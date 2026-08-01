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
| 1 ✅ | Program compiles, design doc, this scope contract | `cd solana && cargo check` — in the standard gate list |
| 2 ▸ | CI build + deploy workflow, happy-path script | Workflow written; **the deploy itself is blocked on an operator step**, below |
| 3 | Off-chain integration: `lib/onchain/` grows a Solana driver behind the same facade the V1/V2 split already uses; testnet-style deployment reads/writes devnet | The board renders devnet jobs; grading settles one |
| 4 | Eternal submission: 1-min updates backlog, product description, technical walkthrough, demo video | Submitted |

### Week 2, concretely

`.github/workflows/solana-devnet.yml` does the part this environment cannot:
it installs the Anza toolchain and Anchor, runs `anchor build` (the real SBF
compile — `cargo check` uses the host target and cannot see a stack-frame
overflow or a missing `idl-build` feature), type-checks the client scripts
against the *generated* IDL, and uploads the `.so` + IDL as artifacts. Build
runs on every push touching `solana/**`; **deploy is `workflow_dispatch` only**
and gated on two secrets, because a program deploy is a real transaction and an
accidental redeploy on every push would churn the program account.

`solana/scripts/happy-path.ts` runs the whole loop against the cluster and
asserts the arithmetic at each step rather than eyeballing it — the fee and
bond it expects are computed from constants duplicated from the program on
purpose, so a change on one side and not the other fails loudly. It also pins
the two properties the rest of the system leans on: `result_hash` is still zero
on an `Accepted` job, and `approve_job` moves **no tokens** (settlement credits
a ledger; only `withdraw` transfers). It is idempotent — the market is a
singleton PDA, so on re-run it adopts the existing one instead of failing in a
way that looks like a program bug.

**The blocking operator step.** `declare_id!` holds a placeholder derived from
a hash: a valid address nobody has the private key for. A real deploy needs a
keypair whose pubkey matches it, so someone has to run `solana-keygen new`,
put the resulting address in `declare_id!`, and store the file's contents in
the `SOLANA_PROGRAM_KEYPAIR` secret (plus a funded devnet wallet in
`SOLANA_DEPLOYER_KEYPAIR`). The workflow checks the match and fails with those
instructions rather than deploying to one address while every client derives
PDAs against another — a mismatch fails at runtime, far from its cause.
`solana/README.md` carries the exact commands.

## What would stop the sprint

The standing rule from the challenge planning: if someone makes a serious run
at the Base challenge (job #3, until 2026-08-30), that takes priority and this
sprint pauses. Eternal is rolling — it restarts when we do.
