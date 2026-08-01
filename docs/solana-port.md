# Solana devnet port — the Colosseum Eternal sprint

Started 2026-08-01 as a 4-week sprint for [Colosseum Eternal](https://colosseum.com/eternal).
Program source: `solana/programs/handsel-market/`. **Devnet only** — that is a
decision, recorded here so it cannot quietly become an accident later.

## Why devnet is a hard line

The Base mainnet deployment holds real money because it earned the right in
public: bytecode verified on Basescan, a written self-audit, Slither + Mythril
runs with every finding dispositioned, and $100 escrowed behind a "break it"
challenge. **None of that transfers.** This program is a first month of Rust in
a codebase whose author-side verification is one AI and one human who does not
read Rust. It gets the same standing the same way the EVM contracts did — by
being published, analyzed and attacked — or it keeps holding tokens that cost
nothing. If this paragraph and reality ever disagree, reality is the bug:
file it like `docs/deployments.md` says.

## What this is for

Eternal's submission is a product demo + repo + technical walkthrough after a
4-week sprint. The pitch is honest and narrow: Handsel runs live on Base
mainnet with real USDC; this sprint is the escrow core reaching a second
runtime. The off-chain stack — grading, credit engine, MCP connector, UI — is
chain-agnostic and already built; what Solana needs is the money layer.

## Scope: the money loop, nothing else

```
post_job (bounty + fee escrowed)
  → accept_job (worker stakes bond; credit-score gate)
    → submit_work (result_hash on chain)
      → approve_job | expire_review (pull-payment credit)
        → withdraw
post_job → cancel_job                      (Open, requester exit)
accept_job → reclaim_job (deadline passed) (refund + bond BURNED)
set_credit                                 (oracle publishes score/limit)
```

### Deliberate v0.1 cuts — documented, not forgotten

| Cut | Why it can wait |
|---|---|
| Disputes / arbiter | The timeout path settles everything; the EVM deployment's own data says disputes rarely resolve any other way. Also the strongest v3 idea (delete the arbiter, `docs/v2-plan.md`) may make this cut permanent. |
| `assignPayee` lien | Lending isn't ported, so nothing needs assignable release. |
| Silence forfeit (90/10) | `expire_review` releases in full. Fewer branches in month one; the constructor param can arrive with v0.2. |
| Open-window expiry | `cancel_job` covers the stale-Open case; a sweep can crank it. |
| Vault / borrowing, governance | Not on Base mainnet either — the port must not overtake the original. |

## How the EVM invariants map

| LaborMarketV2 | handsel_market | Note |
|---|---|---|
| Contract holds USDC; immutables | `Market` PDA (seeds `["market"]`) + vault token account (seeds `["vault"]`, authority = market PDA) | Config is set at `init_market` and has no setters — immutability by absence, same as the EVM side. |
| `jobs[id]` struct | `Job` PDA (seeds `["job", id_le]`) | One account per job; rent paid by the requester. |
| `withdrawable[addr]` | `Withdrawable` PDA (seeds `["withdrawable", owner]`) | Pull payments. `owner` stamps on first credit and can never be re-pointed. |
| `AgentCreditRegistry` (separate contract) | `Credit` PDA (seeds `["credit", agent]`) in the same program | The EVM registry's `setOracle(address(0))` brick (found by Slither, `docs/static-analysis.md`) has no analogue: the oracle is fixed at init, and rotation is an explicit v0.2 design question instead of an unchecked setter. |
| `resultHash` set only by `submitWork` | `result_hash` written only by `submit_work`, zero-hash rejected | The signal `lib/job-grade.ts` reads stays bit-compatible: zero = no submission landed. |
| `_burnBond` — slash paid to nobody | `token::burn` from the vault | Same reasoning verbatim: a slash paid to any party who can influence the slash is an incentive to manufacture it. SPL burn needs no mint authority, so this works even on real USDC. |
| `totalEscrowed`/`totalWithdrawable`, `escrowSolvency()` | Same two fields on `Market` | Solvency stays one comparison: `total_escrowed + total_withdrawable <= vault.amount`. |
| CEI, zero-before-transfer in `_withdrawTo` | Ledger zeroed before the transfer CPI | Solana's account model makes classic reentrancy hard anyway; the ordering costs nothing and keeps the property reviewable locally. |
| Checked math (`^0.8.24`, no `unchecked`) | `checked_add/sub/mul` everywhere + `overflow-checks = true` in release profile | The SWC-101 answer, pre-written for whoever runs a Rust analyzer at this. |
| `assertNotSelfDeal` (off-chain, owner-level) | `SelfDeal` error on-chain (address-level) + the owner-level check stays off-chain | Same split as EVM: the chain rejects the trivially checkable case, the platform rejects the identity-level case. |

Devnet-only parameter deltas: delivery-window floor is 1h (mainnet: 4h) so a
demo doesn't take an afternoon; everything else mirrors the mainnet schedule
(fee 5% + flat, bond 5% + flat) at init time.

## Four weeks

| Week | Deliverable | Gate |
|---|---|---|
| 1 (now) | Program compiles, design doc, this scope contract | `cd solana && cargo check` — in the standard gate list |
| 2 | Deploy to devnet + mock USDC mint + `scripts/` happy-path script (post→accept→submit→approve→withdraw against devnet) | The loop runs on a public cluster, tx signatures in the doc |
| 3 | Off-chain integration: `lib/onchain/` grows a Solana driver behind the same facade the V1/V2 split already uses; testnet-style deployment reads/writes devnet | The board renders devnet jobs; grading settles one |
| 4 | Eternal submission: 1-min updates backlog, product description, technical walkthrough, demo video | Submitted |

Week 2 needs the Solana toolchain (`cargo-build-sbf`) — an operator-side or CI
step, since this environment ships only host Rust. `cargo check` stays the
in-repo gate for the program logic itself.

## What would stop the sprint

The standing rule from the challenge planning: if someone makes a serious run
at the Base challenge (job #3, until 2026-08-30), that takes priority and this
sprint pauses. Eternal is rolling — it restarts when we do.
