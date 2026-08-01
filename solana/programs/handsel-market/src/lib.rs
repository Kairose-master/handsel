//! Handsel escrow core on Solana — a devnet port of `LaborMarketV2`.
//!
//! **Devnet only, by decision, not by omission.** The Base mainnet deployment
//! carries the verified contracts, the self-audit, the static analysis and the
//! open challenge; none of that trust transfers to a fresh Rust program in its
//! first month. This program earns the same standing the same way — or it
//! stays on devnet. See `docs/solana-port.md` for the full scope contract.
//!
//! What is ported: the money loop. post (bounty + fee escrowed) → accept
//! (worker stakes a bond) → submit (resultHash on chain) → approve or review
//! timeout (pull-payment credit) → withdraw. Plus the two exits that kept v1
//! escrow from freezing: cancel (Open) and reclaim (Accepted, past deadline,
//! bond burned — a slash paid to any party who can influence the slash is an
//! incentive to manufacture it, so nobody gets it).
//!
//! What is deliberately NOT here (v0.1 cuts, each documented in the port doc):
//! disputes/arbiter, assignable payees (liens), the silence forfeit split,
//! open-window expiry, lending, governance.
//!
//! Invariants carried over from the EVM contract, in its own words:
//! - **Pull payments.** Settlement credits `Withdrawable`; only `withdraw`
//!   moves tokens out. The one thing this program must never do is pay the
//!   same balance twice, so balances are zeroed before the transfer CPI.
//! - **`result_hash` is set by `submit_work` and nothing else.** A zero hash
//!   means no submission landed — the exact signal lib/job-grade.ts reads on
//!   the EVM side, kept bit-compatible on purpose.
//! - **Solvency is one comparison.** `total_escrowed + total_withdrawable`
//!   must never exceed the vault balance; every mutation maintains it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

declare_id!("2p6KBeJX8TbdcQC8pcWmLxhyCASMwg7HtLbtptUo7yZg");

const BPS_DENOM: u64 = 10_000;
/// Fee/bond bps are capped at construction like the EVM contract's
/// MAX_FEE_BPS / MAX_BOND_BPS — an operator misconfiguration should fail at
/// init, not at the first user's expense.
const MAX_BPS: u16 = 2_000; // 20%
const MIN_DELIVERY_WINDOW: u32 = 60 * 60; // 1h — devnet floor, tighter than mainnet's 4h
const MAX_DELIVERY_WINDOW: u32 = 30 * 24 * 60 * 60; // 30d
const MIN_REVIEW_WINDOW: u32 = 60 * 10; // 10m
const MAX_REVIEW_WINDOW: u32 = 14 * 24 * 60 * 60; // 14d

#[program]
pub mod handsel_market {
    use super::*;

    pub fn init_market(ctx: Context<InitMarket>, params: MarketParams) -> Result<()> {
        require!(params.fee_bps <= MAX_BPS, MarketError::ConfigOutOfRange);
        require!(params.bond_bps <= MAX_BPS, MarketError::ConfigOutOfRange);
        require!(
            params.review_window >= MIN_REVIEW_WINDOW && params.review_window <= MAX_REVIEW_WINDOW,
            MarketError::ConfigOutOfRange
        );
        require!(params.min_bounty > 0, MarketError::ConfigOutOfRange);
        // The fee stream must not be welded to the hot key that signs oracle
        // writes — the same invariant docs/basescan-verification.md records
        // for the EVM deployment (feeRecipient != oracle).
        require!(
            params.fee_recipient != params.oracle,
            MarketError::FeeRecipientIsOracle
        );

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.oracle = params.oracle;
        market.fee_recipient = params.fee_recipient;
        market.usdc_mint = ctx.accounts.usdc_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.fee_bps = params.fee_bps;
        market.flat_fee = params.flat_fee;
        market.bond_bps = params.bond_bps;
        market.flat_bond = params.flat_bond;
        market.review_window = params.review_window;
        market.min_bounty = params.min_bounty;
        market.job_count = 0;
        market.total_escrowed = 0;
        market.total_withdrawable = 0;
        market.bump = ctx.bumps.market;
        Ok(())
    }

    /// Escrow `bounty + fee` and open the job. The fee is escrowed with the
    /// bounty and only credited to the fee recipient at settlement — so a
    /// cancelled or reclaimed job refunds the requester in full, and the
    /// platform is paid only when work actually concluded.
    pub fn post_job(
        ctx: Context<PostJob>,
        bounty: u64,
        min_score: u64,
        spec_hash: [u8; 32],
        delivery_window: u32,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(bounty >= market.min_bounty, MarketError::BountyTooSmall);
        require!(
            (MIN_DELIVERY_WINDOW..=MAX_DELIVERY_WINDOW).contains(&delivery_window),
            MarketError::WindowOutOfRange
        );
        require!(spec_hash != [0u8; 32], MarketError::EmptyHash);

        let fee = fee_for(market, bounty)?;
        let total = bounty.checked_add(fee).ok_or(MarketError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.requester_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.requester.to_account_info(),
                },
            ),
            total,
        )?;

        market.total_escrowed = market
            .total_escrowed
            .checked_add(total)
            .ok_or(MarketError::MathOverflow)?;

        let job = &mut ctx.accounts.job;
        job.id = market.job_count;
        job.requester = ctx.accounts.requester.key();
        job.worker = Pubkey::default();
        job.bounty = bounty;
        job.fee = fee;
        job.bond = 0;
        job.min_score = min_score;
        job.spec_hash = spec_hash;
        job.result_hash = [0u8; 32];
        job.status = JobStatus::Open;
        job.created_at = Clock::get()?.unix_timestamp;
        job.delivery_window = delivery_window;
        job.accepted_at = 0;
        job.review_deadline = 0;
        job.bump = ctx.bumps.job;

        market.job_count = market
            .job_count
            .checked_add(1)
            .ok_or(MarketError::MathOverflow)?;

        emit!(JobPosted {
            job_id: job.id,
            requester: job.requester,
            bounty,
            fee,
            min_score,
            delivery_window,
        });
        Ok(())
    }

    /// Worker stakes the bond and takes the job. If the job gates on a credit
    /// score, the worker's credit PDA must be supplied and is verified against
    /// its derived address — omitting the account is not a bypass.
    pub fn accept_job(ctx: Context<AcceptJob>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Open, MarketError::WrongStatus);
        require!(
            job.requester != ctx.accounts.worker.key(),
            MarketError::SelfDeal
        );

        if job.min_score > 0 {
            let credit = ctx
                .accounts
                .worker_credit
                .as_ref()
                .ok_or(MarketError::CreditRequired)?;
            let (expected, _) = Pubkey::find_program_address(
                &[b"credit", ctx.accounts.worker.key().as_ref()],
                ctx.program_id,
            );
            require!(credit.key() == expected, MarketError::WrongCreditAccount);
            require!(credit.score >= job.min_score, MarketError::ScoreTooLow);
        }

        let bond = bond_for(market, job.bounty)?;
        if bond > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.worker_token.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.worker.to_account_info(),
                    },
                ),
                bond,
            )?;
            market.total_escrowed = market
                .total_escrowed
                .checked_add(bond)
                .ok_or(MarketError::MathOverflow)?;
        }

        job.worker = ctx.accounts.worker.key();
        job.bond = bond;
        job.status = JobStatus::Accepted;
        job.accepted_at = Clock::get()?.unix_timestamp;

        emit!(JobAccepted {
            job_id: job.id,
            worker: job.worker,
            bond,
        });
        Ok(())
    }

    /// The ONLY writer of `result_hash` — a zero hash everywhere else in the
    /// system means "no submission landed", and that stays true here.
    pub fn submit_work(ctx: Context<WorkerOnJob>, result_hash: [u8; 32]) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Accepted, MarketError::WrongStatus);
        require!(
            job.worker == ctx.accounts.worker.key(),
            MarketError::NotWorker
        );
        require!(result_hash != [0u8; 32], MarketError::EmptyHash);

        let now = Clock::get()?.unix_timestamp;
        let deadline = job
            .accepted_at
            .checked_add(job.delivery_window as i64)
            .ok_or(MarketError::MathOverflow)?;
        require!(now <= deadline, MarketError::PastDeadline);

        job.result_hash = result_hash;
        job.status = JobStatus::Submitted;
        job.review_deadline = now
            .checked_add(ctx.accounts.market.review_window as i64)
            .ok_or(MarketError::MathOverflow)?;

        emit!(WorkSubmitted {
            job_id: job.id,
            result_hash,
            review_deadline: job.review_deadline,
        });
        Ok(())
    }

    /// Requester releases the escrow: bounty + bond credited to the worker,
    /// fee credited to the fee recipient. Pull payments — nothing leaves the
    /// vault here.
    pub fn approve_job(ctx: Context<SettleJob>) -> Result<()> {
        require!(
            ctx.accounts.job.status == JobStatus::Submitted,
            MarketError::WrongStatus
        );
        require!(
            ctx.accounts.job.requester == ctx.accounts.authority.key(),
            MarketError::NotRequester
        );
        settle_to_worker(ctx)
    }

    /// A requester who received work and says nothing forever must not freeze
    /// the escrow: past the review deadline anyone may trigger the release.
    /// (The EVM contract's 90/10 silence forfeit is a documented v0.1 cut —
    /// this releases in full.)
    pub fn expire_review(ctx: Context<SettleJob>) -> Result<()> {
        let job = &ctx.accounts.job;
        require!(job.status == JobStatus::Submitted, MarketError::WrongStatus);
        let now = Clock::get()?.unix_timestamp;
        require!(now > job.review_deadline, MarketError::NotExpiredYet);
        settle_to_worker(ctx)
    }

    /// Open job, no worker yet: the requester walks away with a full refund
    /// (bounty AND fee — the platform is paid for concluded work, not for
    /// intentions).
    pub fn cancel_job(ctx: Context<RefundJob>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Open, MarketError::WrongStatus);
        require!(
            job.requester == ctx.accounts.requester.key(),
            MarketError::NotRequester
        );

        let refund = job
            .bounty
            .checked_add(job.fee)
            .ok_or(MarketError::MathOverflow)?;
        job.status = JobStatus::Cancelled;

        credit(
            &mut ctx.accounts.market,
            &mut ctx.accounts.requester_withdrawable,
            ctx.accounts.requester.key(),
            refund,
        )?;

        emit!(JobCancelled {
            job_id: job.id,
            refunded: refund,
        });
        Ok(())
    }

    /// Accepted, never submitted, past the delivery deadline: requester
    /// reclaims bounty + fee, and the worker's bond is BURNED. Paying the
    /// slash to the requester would make manufactured reclaims profitable;
    /// paying it to the platform would make inattention profitable. Nobody
    /// gets it — same reasoning, same outcome as `_burnBond` on the EVM side.
    pub fn reclaim_job(ctx: Context<ReclaimJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Accepted, MarketError::WrongStatus);
        require!(
            job.requester == ctx.accounts.requester.key(),
            MarketError::NotRequester
        );
        let deadline = job
            .accepted_at
            .checked_add(job.delivery_window as i64)
            .ok_or(MarketError::MathOverflow)?;
        require!(now > deadline, MarketError::NotExpiredYet);

        let refund = job
            .bounty
            .checked_add(job.fee)
            .ok_or(MarketError::MathOverflow)?;
        let bond = job.bond;
        job.status = JobStatus::Reclaimed;

        credit(
            &mut ctx.accounts.market,
            &mut ctx.accounts.requester_withdrawable,
            ctx.accounts.requester.key(),
            refund,
        )?;

        if bond > 0 {
            let market = &mut ctx.accounts.market;
            // Escrow drops; nobody is credited. total_escrowed must still
            // fall — a solvency number that overstates what is owed is as
            // useless as one that flatters.
            market.total_escrowed = market
                .total_escrowed
                .checked_sub(bond)
                .ok_or(MarketError::MathOverflow)?;
            let bump = market.bump;
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    &[&[b"market", &[bump]]],
                ),
                bond,
            )?;
        }

        emit!(JobReclaimed {
            job_id: job.id,
            refunded: refund,
            bond_burned: bond,
        });
        Ok(())
    }

    /// The only instruction that moves tokens OUT of the vault. Balance is
    /// zeroed before the transfer CPI — checks-effects-interactions costs
    /// nothing and the one thing this program must never do is pay the same
    /// balance twice.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let ledger = &mut ctx.accounts.withdrawable;
        let amount = ledger.amount;
        require!(amount > 0, MarketError::NothingToWithdraw);

        ledger.amount = 0;
        let market = &mut ctx.accounts.market;
        market.total_withdrawable = market
            .total_withdrawable
            .checked_sub(amount)
            .ok_or(MarketError::MathOverflow)?;

        let bump = market.bump;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: market.to_account_info(),
                },
                &[&[b"market", &[bump]]],
            ),
            amount,
        )?;

        emit!(Withdrawn {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        Ok(())
    }

    /// Oracle publishes an agent's credit score and limit — the registry half
    /// of the EVM pair, folded into the same program as its own PDA. The
    /// zero-address brick Slither found in the EVM registry has no analogue
    /// here: the oracle key is fixed at init and rotation is a v0.2 question,
    /// not an unchecked setter.
    pub fn set_credit(ctx: Context<SetCredit>, agent: Pubkey, score: u64, limit: u64) -> Result<()> {
        require!(
            ctx.accounts.oracle.key() == ctx.accounts.market.oracle,
            MarketError::NotOracle
        );
        let credit = &mut ctx.accounts.credit;
        credit.agent = agent;
        credit.score = score;
        credit.limit = limit;
        credit.bump = ctx.bumps.credit;
        emit!(CreditSet { agent, score, limit });
        Ok(())
    }
}

// ── shared settlement ────────────────────────────────────────────────────

/// Bounty + bond → worker, fee → fee recipient. Both as withdrawable credit.
fn settle_to_worker(ctx: Context<SettleJob>) -> Result<()> {
    let worker_key = ctx.accounts.job.worker;
    require!(
        ctx.accounts.worker_withdrawable.owner == Pubkey::default()
            || ctx.accounts.worker_withdrawable.owner == worker_key,
        MarketError::WrongLedger
    );

    let to_worker = ctx
        .accounts
        .job
        .bounty
        .checked_add(ctx.accounts.job.bond)
        .ok_or(MarketError::MathOverflow)?;
    let fee = ctx.accounts.job.fee;
    let fee_recipient = ctx.accounts.market.fee_recipient;

    ctx.accounts.job.status = JobStatus::Completed;

    credit(
        &mut ctx.accounts.market,
        &mut ctx.accounts.worker_withdrawable,
        worker_key,
        to_worker,
    )?;
    credit(
        &mut ctx.accounts.market,
        &mut ctx.accounts.fee_withdrawable,
        fee_recipient,
        fee,
    )?;

    emit!(JobCompleted {
        job_id: ctx.accounts.job.id,
        worker: worker_key,
        to_worker,
        fee,
    });
    Ok(())
}

/// Move `amount` from escrow to a pull-payment ledger. The two totals move
/// together so the solvency comparison stays one line.
fn credit(
    market: &mut Account<Market>,
    ledger: &mut Account<Withdrawable>,
    owner: Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if ledger.owner == Pubkey::default() {
        ledger.owner = owner;
    }
    require!(ledger.owner == owner, MarketError::WrongLedger);
    market.total_escrowed = market
        .total_escrowed
        .checked_sub(amount)
        .ok_or(MarketError::MathOverflow)?;
    market.total_withdrawable = market
        .total_withdrawable
        .checked_add(amount)
        .ok_or(MarketError::MathOverflow)?;
    ledger.amount = ledger
        .amount
        .checked_add(amount)
        .ok_or(MarketError::MathOverflow)?;
    Ok(())
}

fn fee_for(market: &Market, bounty: u64) -> Result<u64> {
    let bps = bounty
        .checked_mul(market.fee_bps as u64)
        .ok_or(MarketError::MathOverflow)?
        / BPS_DENOM;
    market
        .flat_fee
        .checked_add(bps)
        .ok_or(error!(MarketError::MathOverflow))
}

fn bond_for(market: &Market, bounty: u64) -> Result<u64> {
    let bps = bounty
        .checked_mul(market.bond_bps as u64)
        .ok_or(MarketError::MathOverflow)?
        / BPS_DENOM;
    market
        .flat_bond
        .checked_add(bps)
        .ok_or(error!(MarketError::MathOverflow))
}

// ── state ────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MarketParams {
    pub oracle: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub flat_fee: u64,
    pub bond_bps: u16,
    pub flat_bond: u64,
    pub review_window: u32,
    pub min_bounty: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub fee_recipient: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub fee_bps: u16,
    pub flat_fee: u64,
    pub bond_bps: u16,
    pub flat_bond: u64,
    pub review_window: u32,
    pub min_bounty: u64,
    pub job_count: u64,
    pub total_escrowed: u64,
    pub total_withdrawable: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum JobStatus {
    Open,
    Accepted,
    Submitted,
    Completed,
    Cancelled,
    Reclaimed,
}

#[account]
#[derive(InitSpace)]
pub struct Job {
    pub id: u64,
    pub requester: Pubkey,
    pub worker: Pubkey,
    pub bounty: u64,
    pub fee: u64,
    pub bond: u64,
    pub min_score: u64,
    pub spec_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub status: JobStatus,
    pub created_at: i64,
    pub delivery_window: u32,
    pub accepted_at: i64,
    pub review_deadline: i64,
    pub bump: u8,
}

/// Pull-payment ledger, one PDA per recipient. `owner` is stamped on first
/// credit; a ledger can never be re-pointed at someone else.
#[account]
#[derive(InitSpace)]
pub struct Withdrawable {
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Credit {
    pub agent: Pubkey,
    pub score: u64,
    pub limit: u64,
    pub bump: u8,
}

// ── accounts ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market"],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault"],
        bump,
        token::mint = usdc_mint,
        token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostJob<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = requester,
        space = 8 + Job::INIT_SPACE,
        seeds = [b"job", market.job_count.to_le_bytes().as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        mut,
        constraint = requester_token.mint == market.usdc_mint @ MarketError::WrongMint,
        constraint = requester_token.owner == requester.key() @ MarketError::WrongTokenOwner
    )]
    pub requester_token: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault @ MarketError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptJob<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"job", job.id.to_le_bytes().as_ref()], bump = job.bump)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub worker: Signer<'info>,
    #[account(
        mut,
        constraint = worker_token.mint == market.usdc_mint @ MarketError::WrongMint,
        constraint = worker_token.owner == worker.key() @ MarketError::WrongTokenOwner
    )]
    pub worker_token: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault @ MarketError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    /// Verified in the handler against the derived PDA when the job gates on
    /// score — Option so score-0 jobs need no credit account at all.
    pub worker_credit: Option<Account<'info, Credit>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WorkerOnJob<'info> {
    #[account(seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"job", job.id.to_le_bytes().as_ref()], bump = job.bump)]
    pub job: Account<'info, Job>,
    pub worker: Signer<'info>,
}

/// approve_job / expire_review — the two paths to the same settlement.
/// `authority` is the requester for approve; for expire_review it is whoever
/// pays for the crank (the handler checks requester-ship only on approve).
#[derive(Accounts)]
pub struct SettleJob<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"job", job.id.to_le_bytes().as_ref()], bump = job.bump)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Withdrawable::INIT_SPACE,
        seeds = [b"withdrawable", job.worker.as_ref()],
        bump
    )]
    pub worker_withdrawable: Account<'info, Withdrawable>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Withdrawable::INIT_SPACE,
        seeds = [b"withdrawable", market.fee_recipient.as_ref()],
        bump
    )]
    pub fee_withdrawable: Account<'info, Withdrawable>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundJob<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"job", job.id.to_le_bytes().as_ref()], bump = job.bump)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init_if_needed,
        payer = requester,
        space = 8 + Withdrawable::INIT_SPACE,
        seeds = [b"withdrawable", requester.key().as_ref()],
        bump
    )]
    pub requester_withdrawable: Account<'info, Withdrawable>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReclaimJob<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"job", job.id.to_le_bytes().as_ref()], bump = job.bump)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init_if_needed,
        payer = requester,
        space = 8 + Withdrawable::INIT_SPACE,
        seeds = [b"withdrawable", requester.key().as_ref()],
        bump
    )]
    pub requester_withdrawable: Account<'info, Withdrawable>,
    #[account(mut, address = market.usdc_mint @ MarketError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, address = market.vault @ MarketError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"withdrawable", owner.key().as_ref()],
        bump = withdrawable.bump,
        constraint = withdrawable.owner == owner.key() @ MarketError::WrongLedger
    )]
    pub withdrawable: Account<'info, Withdrawable>,
    pub owner: Signer<'info>,
    #[account(
        mut,
        constraint = owner_token.mint == market.usdc_mint @ MarketError::WrongMint,
        constraint = owner_token.owner == owner.key() @ MarketError::WrongTokenOwner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault @ MarketError::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct SetCredit<'info> {
    #[account(seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = oracle,
        space = 8 + Credit::INIT_SPACE,
        seeds = [b"credit", agent.as_ref()],
        bump
    )]
    pub credit: Account<'info, Credit>,
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── events ───────────────────────────────────────────────────────────────

#[event]
pub struct JobPosted {
    pub job_id: u64,
    pub requester: Pubkey,
    pub bounty: u64,
    pub fee: u64,
    pub min_score: u64,
    pub delivery_window: u32,
}

#[event]
pub struct JobAccepted {
    pub job_id: u64,
    pub worker: Pubkey,
    pub bond: u64,
}

#[event]
pub struct WorkSubmitted {
    pub job_id: u64,
    pub result_hash: [u8; 32],
    pub review_deadline: i64,
}

#[event]
pub struct JobCompleted {
    pub job_id: u64,
    pub worker: Pubkey,
    pub to_worker: u64,
    pub fee: u64,
}

#[event]
pub struct JobCancelled {
    pub job_id: u64,
    pub refunded: u64,
}

#[event]
pub struct JobReclaimed {
    pub job_id: u64,
    pub refunded: u64,
    pub bond_burned: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CreditSet {
    pub agent: Pubkey,
    pub score: u64,
    pub limit: u64,
}

// ── errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum MarketError {
    #[msg("config value out of range")]
    ConfigOutOfRange,
    #[msg("fee recipient must not be the oracle key")]
    FeeRecipientIsOracle,
    #[msg("bounty below market minimum")]
    BountyTooSmall,
    #[msg("delivery window out of range")]
    WindowOutOfRange,
    #[msg("hash must not be zero")]
    EmptyHash,
    #[msg("job is not in the required status")]
    WrongStatus,
    #[msg("requester and worker must differ")]
    SelfDeal,
    #[msg("job gates on credit score but no credit account was supplied")]
    CreditRequired,
    #[msg("supplied credit account is not the worker's credit PDA")]
    WrongCreditAccount,
    #[msg("credit score below the job's minimum")]
    ScoreTooLow,
    #[msg("only the accepted worker may do this")]
    NotWorker,
    #[msg("only the requester may do this")]
    NotRequester,
    #[msg("only the oracle may do this")]
    NotOracle,
    #[msg("deadline has passed")]
    PastDeadline,
    #[msg("deadline has not passed yet")]
    NotExpiredYet,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("ledger belongs to someone else")]
    WrongLedger,
    #[msg("token account has the wrong mint")]
    WrongMint,
    #[msg("token account has the wrong owner")]
    WrongTokenOwner,
    #[msg("not the market vault")]
    WrongVault,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
