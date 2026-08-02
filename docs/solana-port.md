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
| 3 ▸ | Off-chain integration: read path + chain discriminator done; the write path (signing) is what remains | Codec and discriminator unit-tested; board wiring waits on a deployed program id |
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

**The program id is now real.** `declare_id!` was a placeholder derived from a
hash — a valid address nobody held the key for — and is now
`8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H`, generated by
`solana/scripts/keygen.mjs`. The private half lives only in the
`SOLANA_PROGRAM_KEYPAIR` repo secret; it is not in this repo and never was.

The workflow still verifies that the built keypair's pubkey equals
`declare_id!` before deploying, because the failure it prevents does not go
away: deploying to one address while every client derives PDAs against another
fails at runtime, far from its cause.

**What is still needed to deploy**, both operator-side:

| Secret | What |
|---|---|
| `SOLANA_PROGRAM_KEYPAIR` | The keypair file's contents for the address above |
| `SOLANA_DEPLOYER_KEYPAIR` | A separate funded devnet wallet, ~3 SOL (rent-exempt storage for the binary, plus the happy-path script's accounts) |

Then **Actions → Solana devnet → Run workflow** with `deploy` and
`run_happy_path` checked. `solana/README.md` carries the exact commands.

### Week 3, concretely

**The read path needs no Solana SDK.** `getProgramAccounts` with a memcmp
filter on Anchor's 8-byte discriminator returns every `Job` the program owns
and nothing else, so enumerating the board derives no PDAs. What is left is
base58, base64 and fixed-width little-endian fields — `lib/onchain/solana/codec.ts`,
pure, no dependencies, and consequently unit-testable without a cluster. The
write path is a different question: signing needs ed25519 and transaction
serialisation, which is what an SDK is for, and it lands with the deployed
program id.

The account layout is duplicated from the Rust rather than generated from the
IDL, because the IDL only exists after `anchor build` and a build artifact that
can be missing is a runtime failure waiting for a deploy. Duplication nobody
checks is just a second place to be wrong, so `tests/solana-codec.test.ts`
**reads `solana/programs/handsel-market/src/lib.rs`** and asserts the decoder
against it: same fields, same order, widths summing to the account size, and
the same status variants in the same order (Borsh encodes a fieldless enum as
its index, so reordering the Rust variants silently re-labels every job on the
board). A field added on the Rust side and not mirrored here fails at
`npm run test`, not on devnet.

### The bug this week found: `isRealMoney()` was EVM-shaped

`isRealMoney()` classified a deployment by `CHAIN.id`, which is built from
`ONCHAIN_CHAIN` — an EVM chain name. Its allowlist is TESTNETS, so anything
unrecognised counts as real money. That asymmetry is right for EVM and the
wrong answer entirely for a deployment whose money lives on Solana: **devnet
would have worn the mainnet badge**, printed the mainnet disclosure, and armed
`assertRealMoneyReady` over tokens worth nothing.

`lib/onchain/chain-kind.ts` is the discriminator — `'evm' | 'solana'`, derived
from the environment, EVM unless a valid Solana cluster AND program address are
both present, so every existing deployment is untouched and a Solana one is
opt-in. `isRealMoney()` routes through it; `chainDisplayName()` closes the
matching label hole, since CLAUDE.md's "never hardcode testnet/mainnet" rule
was being satisfied by `CHAIN.name`, which a Solana deployment does not have.

Half-set environments are deliberately NOT Solana. A cluster with a typo'd
program id reads as unconfigured rather than as a market that fails every
call — the second degrades into an empty board, which is indistinguishable
from an empty market. Same rule, and the same reasoning,
as `MarketReadState` in `app/actions/guest.ts`.

### What remains for week 3

- The write path (approve/settle), which needs a signing SDK and a deployed
  program id — blocked on the operator step in week 2.
- Wiring `readSolanaJobs` into the board behind `chainKind()`. The read
  function and its state machine exist; nothing calls them yet, because
  pointing a page at a program that is not deployed would render an
  `unreachable` board and teach nothing.

### Deploying a program over a public RPC does not work

First real deploy attempt died with:

```
Error: Data writes to account failed: Custom error: Max retries exceeded
```

`solana program deploy` uploads the `.so` as **hundreds of small write
transactions** into a buffer account. The public devnet endpoint drops them
under that load; retrying harder does not fix a rate limit. Three changes, in
order of how much they matter:

1. **`SOLANA_RPC_URL` secret** — a dedicated endpoint if one is configured,
   falling back to the public cluster. This is the actual fix; the rest is
   mitigation. The job **checks the endpoint's genesis hash** before using it:
   a mainnet URL answers RPC calls perfectly well and then reports the deployer
   as unfunded, which reads as a faucet problem rather than a wrong-cluster
   one. Devnet is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; anything else
   fails immediately with that comparison printed.
2. **`--use-rpc`** sends the writes through the RPC instead of forwarding them
   to validator TPUs, which is where they were disappearing, plus
   `--max-sign-attempts 30` (the default is 5, which is not many when a few
   hundred writes each get one chance) and a small priority fee.

   It was briefly 100, and that was a mistake worth recording: on a throttled
   endpoint it did not fix anything, it converted *"fails in two minutes"* into
   *"grinds for forty-five and then fails"*. **Retrying is not a substitute for
   an endpoint that can take the load**, and a knob that hides a failure for
   forty-five minutes is worse than the failure. The deploy job's timeout is
   now 20 minutes for the same reason — an upload over a working endpoint
   takes a couple, so anything past twenty is a diagnosis, not a delay.
3. **Buffer reclamation, before and after.** A failed deploy STRANDS its buffer,
   and a buffer holds rent for the whole binary — 1.5–2 SOL here. Retrying
   without reclaiming means every attempt eats another wallet's worth, which is
   how a flaky RPC becomes "the faucet will not give me any more". Both steps
   are `solana program close --buffers`, which is idempotent, and the trailing
   one is `if: always()` because a stranded buffer is precisely what a *failed*
   run leaves behind.

That last one has a second reason. A failed deploy prints the buffer's ephemeral
**seed phrase** into the log to let you resume — so a public CI run publishes it.
The buffer's *authority* is the deployer, not that keypair, so it is not
directly spendable by a reader; reclaiming it automatically means there is
nothing to reason about either way.

### The first devnet deploy, and two bugs it took to find one

The program went live at `8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H` and
the happy-path job reported **green**. The chain disagreed:

```
job #0: Completed  bounty=1,000,000  fee=80,000  bond=80,000  submission=yes
Market: escrowed=0  withdrawable=1,160,000
  ledger GLPR6KSp…  1,080,000   ← worker (bounty + returned bond)
  ledger DmpJvW8W…     80,000   ← fee recipient
```

post → accept → submit → approve is exactly right, to the unit. But `withdraw`
had not run: had it, the worker's ledger would be zero and `totalWithdrawable`
80,000. **Money credited, money stuck.**

**Bug 1 — the program.** `withdraw` derived its ledger address with
`bump = withdrawable.bump`, and nothing ever wrote that field. `credit()` is a
plain helper with no access to `ctx.bumps`, so it set `owner` and `amount` and
left `bump` at 0 — confirmed on chain, `Withdrawable.bump = 0` against
`Job.bump = 255`. Settlement credited the ledger and the seeds check then
refused every withdrawal from it, forever. `credit()` now takes the bump, and
`withdraw` re-derives canonically (`bump` with no `= expr`) so the constraint
cannot depend on a field a helper might forget again. Both, deliberately: the
field should be truthful, and the instruction that strands funds should not
need it to be.

**Bug 2 — the CI, and the reason bug 1 survived.** The step ran
`npx tsx scripts/happy-path.ts | tee happy-path.log`. **A pipeline's exit status
is the LAST command's**, so the script threw, `tee` exited 0, and the job went
green. Every assertion in that script worked; the harness discarded the verdict.
`set -o pipefail` now, and `settle-heartbeat.yml` got the same line — its `grep`
already caught the case, but "grep found nothing" is a worse first clue than
"the request failed".

This is the repo's oldest shape (`docs/failure-modes.md`): **a check that cannot
fail is not a check.** `tests/solana-codec.test.ts` grew a static guard —
every `bump = x.bump` constraint must have a matching `x.bump =` assignment —
verified by reintroducing the bug and watching it fail.

### The third false green: a run that never deployed

The fix above was pushed, the workflow was dispatched, and the run came back
green. The chain disagreed again, and this time it took no decoding to see it:

```
programdata slot   480587171   ← the ORIGINAL deploy, hours earlier
market.job_count   1           ← no second happy path
total_withdrawable 1,160,000   ← both ledgers still funded
```

`ProgramData.slot` is the slot the program was last written in. It had not
moved, so the binary on devnet was still the broken one — the fix existed only
in `main`. The run was green because the deploy job never ran: `deploy` is a
`workflow_dispatch` boolean defaulting to `false`, and a dispatch that leaves
it unchecked builds, passes, and reports success without ever touching the
cluster. Nothing lied; the run answered a different question than the one being
asked of it.

Two changes, both aimed at the gap between "the run is green" and "the fix is
live":

- **`run_happy_path` now defaults to `true`.** A deploy that is never exercised
  proves an upload finished and nothing else. Skipping the money loop is the
  deliberate act now, rather than the default.
- **The deploy job verifies the bytes it left behind.** `solana program dump`
  reads the program back off the chain; the step asserts this build is a
  byte-for-byte prefix of it and that the remainder is zero padding, then
  writes the deployed slot and the `.so` hash into the run summary. That turns
  "was this commit deployed?" into a question answerable from the chain alone
  — which is precisely what could not be answered here.

The shape across all three: `tee` swallowing an exit code, a bump nobody wrote,
and a job that never ran. Each produced a green checkmark over an unchanged
chain. **The chain read is the check; CI is a convenience.**

### 88 bytes, and a loader that only counts in 10240s

With the deploy job actually running, it failed — and this one is worth writing
down because retrying is exactly the wrong instinct. The only transaction the
program saw was a failure:

```
Program BPFLoaderUpgradeab1e… invoke [1]
ExtendProgram requires a minimum of 10240 additional bytes
  or to extend to maximum size, but only 88 were requested
Program BPFLoaderUpgradeab1e… failed: invalid program argument
```

A program's data account is sized at first deploy and does not grow on its own.
Adding the `bump` argument to `credit()` made the binary **88 bytes** bigger
than the 428,584 the account holds. `solana program deploy` handles that by
asking the loader to extend by exactly the shortfall; the loader refuses any
extension under 10240 bytes. The two are simply not speaking the same
language, and no retry budget helps: **88 is 88 every time.** It is the
opposite failure mode from the RPC throttling earlier in this file, and it
looks nearly identical from the run page — a deploy step going red — which is
why the transaction log, not the CI log, is the thing to read.

The deploy job now extends deliberately before deploying, by the shortfall
*plus* the 10240 minimum. The slack is the point: an ordinary code change no
longer needs an extend at all, so the step is a no-op on most runs and prints
how many bytes are left. On a first deploy it skips — there is nothing to
extend and `solana program deploy` sizes the account itself.

### The real defect was the loop

Eight deploy attempts, eight separate facts learned:

| # | What failed | Kind |
|---|---|---|
| 1 | `zeroize 1.9.0` wants edition2024, SBF rustc is 1.79 | toolchain |
| 2 | program-id check ran in the job with no keypair | my design error |
| 3 | public RPC drops the upload's writes | infrastructure |
| 4 | `--max-sign-attempts 100` ground for 45 minutes | my tuning error |
| 5 | deployer short 1.09 SOL for the upgrade buffer | funding |
| 6 | `tee` swallowed the exit code; `bump` nobody wrote | product bug |
| 7 | dispatched without the `deploy` box checked | input |
| 8 | 88-byte growth, 10240-byte loader minimum | loader rule |

Every one of them was real. None was a repeat. The problem was never the count
— it is that a round trip cost fifteen to forty-five minutes and returned
**one** of these, and the next one was only visible after fixing the last. That
is not debugging, it is a queue.

Two changes make a run say everything it knows:

- **The deploy job no longer rebuilds.** It used to run `anchor build` again —
  fifteen minutes, plus installing `avm` and Anchor — to produce a binary the
  build job had already produced. The `.so` does not contain the keypair, only
  `declare_id!`, which comes from source either way; the keypair signs the
  deploy, it does not shape the bytes. The deploy now downloads the build job's
  artifact. Faster, and *stricter*: what reaches devnet is literally the
  artifact attached to the run, which anyone can download and hash against the
  on-chain program.
- **One preflight step, after the reclaim and the airdrop, before a lamport is
  spent.** Program id vs `declare_id!`, artifact size vs on-chain capacity, the
  extension it implies, and the balance against what the buffer and the extend
  will actually cost — reported together, failing at the end with a count
  rather than at the first problem. Rent-exempt minimum is computed, not
  parsed: `(128 + data_len) × 6960` lamports, which reproduces the
  2.98414872 SOL that attempt #5 discovered by running out of money.

```
  program keypair        8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H
  declare_id!            matches
  artifact               428672 bytes (from the build job)
  on chain               428584 bytes
  capacity               short by 88 — will extend by 10328
  buffer rent            2.9848 SOL   (transient, refunded)
  extend rent            0.0719 SOL   (permanent)
  needed + fees          3.0766 SOL
  deployer balance       6.8969 SOL
  ready.
```

Dry-running that step against stubbed `solana` output — deployed and not,
fitting and short, funded and broke, id matching and not — caught a ninth bug
before it cost anything. `[ "$EXT" -gt 0 ] && say ...` is the line's exit
status, and steps run under `bash -e`, so it would have killed the job on every
run that did **not** need an extend, which is to say all the ordinary ones. An
`if` now. The same shape as `scripts/check-msrv.mjs`: when a round trip is
expensive, spend the effort locally.

### "I never cancelled it"

Runs started coming back **cancelled** with nobody cancelling them. There is no
`concurrency:` block in the workflow, so nothing was racing — which leaves the
one other thing that cancels a job: **a timeout is a cancellation.** GitHub
kills a job past `timeout-minutes` and reports it as cancelled, not failed.

The build job's ceiling was 45 minutes. A cold run compiles `avm` from git and
then compiles `anchor-cli` through it — twenty-five to forty minutes before
`cargo check` has even started. Past 45 it was killed, and this is the part
that makes it a loop rather than a slow build: **a cancelled job never reaches
`actions/cache`'s post step, so it saves nothing.** The next run was cold too.
Cold, killed, nothing cached, cold again — indefinitely, with a cancellation
notice each time and no cause visible in the log, because the log just stops.

Three changes, each aimed at a different part of the loop:

- **The ceiling fits the cold case: 90 minutes.** A limit only helps if the
  ordinary run fits under it. This one has to fit the *cold* run once; after
  that the cache makes it minutes.
- **The toolchain is saved the instant it exists**, via `cache/restore` plus an
  explicit `cache/save` right after the install, instead of `actions/cache`'s
  post step. Whatever happens to the rest of the job, the forty-minute compile
  is paid at most once.
- **Two caches instead of one.** A single entry keyed on the Cargo.toml hash
  put a ~700 MB toolchain that changes only with `ANCHOR_VERSION` in the same
  bucket as multi-GB build output that changes constantly. A repo gets 10 GB
  and evicts oldest-first, so evicting build output took the Anchor
  installation with it, reintroducing the cold compile at random intervals.
  Toolchain is keyed on the Anchor version; build output on `Cargo.lock`.

Worth stating plainly, because it cost real time to see: **the deploy failures
and the cancellations were unrelated problems that looked like one flaky
pipeline.** Read the transaction log for the first and the job annotation for
the second — the run page conflates them.

## What would stop the sprint

The standing rule from the challenge planning: if someone makes a serious run
at the Base challenge (job #3, until 2026-08-30), that takes priority and this
sprint pauses. Eternal is rolling — it restarts when we do.
