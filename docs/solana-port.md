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
| 2 ✅ | CI build + deploy workflow, happy-path script | **Deployed and the money loop is closed on devnet** — post → accept → submit → approve → withdraw, tokens out of the vault, verified against the chain independently |
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

**The board page is live**: `/solana` (`app/solana/page.tsx` +
`app/actions/solana.ts`) renders the devnet board off `readSolanaJobs` — same
three-value read state ('unconfigured' and 'unreachable' render as themselves,
never as an empty market), devnet disclosure banner up top, every address an
explorer link. Verified against the deployed program: 4 Completed jobs from the
week-2 happy-path runs decode and render. Deploying it is env only:
`SOLANA_CLUSTER=devnet` + `SOLANA_PROGRAM_ID=<the declare_id>` on any Vercel
deployment of this repo.

**The write path is done — the platform itself signs.** Three layers, same
duplication discipline as the codec:

- `lib/onchain/solana/tx.ts` — PURE instruction encoding: Anchor's
  `global:<name>` discriminators, Borsh argument layouts, the account order of
  every `#[derive(Accounts)]` struct, PDA seed layouts, and client-side
  `fee_for`/`bond_for` mirrors. `tests/solana-tx.test.ts` reads `lib.rs` and
  diffs all of it — a new instruction, a reordered account, or a flipped
  `mut`/`Signer` fails at `npm run test`.
- `lib/onchain/solana/write.ts` — the ONE file that needs an SDK
  (`@solana/web3.js`): keypair loading (`SOLANA_OPERATOR_KEYPAIR`), PDA
  derivation over tx.ts's seeds, build/sign/send at `confirmed` commitment
  (the happy path documents why `processed` bites), and a `guardDevnet()` on
  every send — the write path refuses any real-money cluster, which is this
  document's devnet-only decision enforced in code.
- `POST /api/admin/solana-loop` — the whole money loop from the deployment
  that serves the board: fund two ephemeral parties, mint test tokens, then
  post → accept → submit → approve → withdraw, answering with every signature
  as an explorer link. Operator-secret auth, POST-only.

**Verified against the chain, not just the Rust**:
`scripts/verify-solana-write.mts` (read-only, no keys) fetches the real
transactions the happy-path left on a job account and checks our encoders
against Anchor's actual wire bytes — discriminator identification, data
lengths (post_job 60B), account counts/order, our derived job PDA equalling
the chain's account, and the Option-None-is-the-program-id convention on
`accept_job`. All four instructions match.

**And the platform now OPERATES the market, not just demos it:**

- **Live audit on the board.** `readSolanaAudit` re-runs every
  `checkMarketInvariants` check from RAW accounts on each /solana refresh —
  market totals vs what the jobs imply, ledger sums, the one-line solvency
  comparison against the actual vault balance, no-blind-settlement,
  no-orphaned-ledger. Verified live: all six hold (owes 3,560,000 = holds
  3,560,000, exact). The difference between a board that displays numbers
  and a board that checks them.
- **One task feed, two runtimes.** `GET /api/tasks` now merges the devnet
  board into the same TaskSpec vocabulary (`solanaJobToTaskSpec`), each
  entry stamped `chain: 'solana:devnet'`. The chain stores a spec hash, not
  prose, so the title says exactly that — nothing invented. This is
  "the off-chain stack is chain-agnostic" as a queryable fact.
- **Credit publishes to the second runtime.** `POST /api/admin/solana-credit`
  writes a real agent's engine-computed score and limit to its `Credit` PDA
  via `set_credit`, signed by the market's oracle key. The product thesis —
  a score earned from graded work, readable on-chain — now has two chains
  it is true on.

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

### What remained for week 3 — both items are now done

- ~~The write path (approve/settle), which needs a signing SDK and a deployed
  program id — blocked on the operator step in week 2.~~ **Built.**
  `lib/onchain/solana/tx.ts` (instruction encoding, 23 tests) +
  `lib/onchain/solana/write.ts` (signing, send-and-confirm) +
  `app/api/admin/solana-loop/route.ts` (the whole post → accept → submit →
  approve → withdraw loop as one operator-authenticated endpoint).
- ~~Wiring `readSolanaJobs` into the board behind `chainKind()`.~~ **Wired.**
  The board reads the deployed program; the state machine that had no caller
  now has one.

### Verified on chain, 2026-08-17

Re-read from devnet before the week-3 film, not from our own database:

| What | Value |
|---|---|
| Program | `8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H` |
| Market authority / oracle | `DPcYFhXjwvqD3LzSBorL8zStz9sfbmbsf8NvYNEUPR4s` |
| Jobs | #0–#3 `Completed`, #4 `Open` |
| Credit PDA | `H5nkGHCG1fjkUoWyLaBdNcjUFiGdb2NNPrNDf2Go5NxN` — score 670, limit 60,000 |
| Agent key | recomputed as `sha256("handsel-agent:<id>")` and matched the PDA's stored key |

The last row is the one that matters. A score sitting in an account proves
only that something wrote a number there; recomputing the agent key from the
agent id and finding it already stored proves *which* agent the number is
about. That is the difference between a demo account and a readable score.

### `stop_after`: why an unrecognised value must refuse

The loop endpoint runs to `withdraw` by default, which leaves every job
`Completed` — a correct settlement and an empty board. Filming needs a board
with an `Open` job on it, so `stop_after` truncates the loop
(`lib/solana-loop-plan.ts`, 12 tests).

`parseStopAfter` **refuses** an unrecognised value rather than falling back to
the full loop. Falling back would mean a typo'd `stop_after=pos` silently
spends real devnet SOL running four more steps than asked and lands in exactly
the state the caller was trying to avoid — with a `200` on it. A step name is
either in `LOOP_STEPS` or the request is a mistake; there is no third reading.
The plan is also computed *before any spend*, so a stop at `post` never funds
or mints for a worker that will never accept.

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

### A ceiling set to the ordinary case

The next run showed `Deploy to devnet` at **19 minutes 50 seconds**, the job
cancelled at 20:17, and every step after the deploy skipped — byte
verification, happy path, all of it. Meanwhile the chain said the deploy had
**succeeded**: `programdata slot` moved to 480621789 and the upgrade landed.
The upload finished, the upgrade committed, and the job was killed roughly ten
seconds later by its own `timeout-minutes: 20`.

That ceiling was chosen here, with a stated rationale: *"a program upload over
an endpoint that can take it is a couple of minutes. Twenty is generous, and
cutting it there means a throttled run is reported while someone is still
watching."* The measurement disagrees — the upload of this 428 KB binary is
19:50 on this endpoint. **The limit had been set to the ordinary case**, so the
ordinary case failed. A ceiling only tells you something when crossing it means
something is wrong; 45 minutes does that, 20 was the normal duration wearing a
limit's clothing.

The second change matters more than the number. **The deploy is now
idempotent**: preflight dumps the on-chain program and compares it to the
artifact, and if the chain already has exactly these bytes the upload is
skipped. It is the difference between a re-run costing twenty minutes and
costing one — and the case it was written for is precisely this one, where the
deploy succeeded and only the steps *after* it need to happen. The
`On-chain bytes are this build` assertion still runs either way; skipping the
upload is an optimisation, not a shortcut around the check.

`Grow the program account` showing as skipped in that same run was correct, and
worth noting because it looks like a symptom: an earlier attempt had already
extended the account to 438,912, preflight saw the capacity, and the step did
nothing. The extend is idempotent by construction.

### The chain read is a command now

Every time this sprint that a green checkmark turned out to be wrong, the thing
that settled it was the same: `getProgramAccounts`, decode the bytes, compare
the numbers. Typed out fresh each time, from memory, on a phone screenshot's
say-so. That is a check the project depends on and does not own.

```
npm run verify:solana
```

`scripts/verify-solana-chain.mjs` reads the market, every job and every ledger
and reports six invariants:

| Invariant | Catches |
|---|---|
| every posted job has an account | `job_count` counting a job nothing wrote |
| `total_escrowed` matches the open jobs | escrow the jobs cannot account for |
| `total_withdrawable` matches the ledgers | credited money with no ledger behind it |
| solvent — the vault covers what is owed | the one comparison the program's header names |
| no job completed without a submission | settlement running with no deliverable |
| no funded ledger without an owner | exactly the bug that cost this sprint a day |

It needs no keys, no Solana toolchain, no `anchor build` and no IDL — an Anchor
account is an 8-byte discriminator and fixed-width little-endian fields, and
`lib/onchain/solana/codec.ts` already knew the layout. So it runs on a laptop
that has never touched this program, in about a second, and it is the deploy
job's last step with `always()`, because the state you are left in after a
failure is the state most worth reading.

The decoders and the invariant function are pure and unit-tested (41 tests in
`tests/solana-codec.test.ts`), including the cases devnet has not produced:
insolvency, a ledger total that disagrees with the market, a job completed with
a zero result hash, a funded ledger at the default pubkey. Two are worth
naming. **A vault balance that could not be read fails the solvency check
rather than passing it** — `null` must never read as zero, or an insolvent
market looks merely empty and empty looks fine. And **a donation to the vault
is not a defect**, which is why solvency is `>=` and not `==`: holding more
than you owe is fine, owing more than you hold is not.

Current devnet state, read by the tool:

```
market   jobs 1 · escrowed 0 · withdrawable 1160000
vault    FF4ahh…EhHQ holds 1160000 of mint G7fnPw…fcf7
  job #0  Completed bounty 1000000 fee 80000 bond 80000
  ledger GLPR6K…zKqN  owed 1080000
  ledger DmpJvW…Y5NA  owed 80000
→ chain agrees with itself.
```

Those two ledgers are the ones stranded by the bump bug. The fixed program is
live now, so they are withdrawable again — by whoever holds those keys, which
in this case was an ephemeral test keypair. The money is test-mint tokens and
the solvency invariant still holds, which is the point: the market can say what
it owes and prove it holds it.

### The first honest red, and it was the test that was wrong

With the ceiling raised the deploy finished inside it, the byte check passed,
and the happy path ran through post → accept → submit → **and stopped**:

```
[6] approve_job — pull-payment credit, no tokens move
Error: ASSERTION FAILED: fee owed 160000, expected 80000
```

`set -o pipefail` earned its comment: a script that threw produced a red run
instead of a green one. But the program is right and the assertion was wrong.
`credit()` **adds** to a ledger, and the market's fee recipient is fixed at
`init_market` — so on the second run its ledger already held the first run's
80,000, and settlement correctly added another. 160,000 is the right answer.

An absolute assertion on an accumulating ledger is really an assertion that
this is the first run, which this script's own header denies: it adopts the
existing market by design. Both ledger assertions are deltas now. The worker's
had been passing by luck — a fresh keypair each run means a fresh PDA — and
now it passes for the same reason as the fee's.

The chain verifier read the aftermath in one second and confirmed the diagnosis
before a line was changed:

```
market   jobs 2 · escrowed 0 · withdrawable 2320000
  job #0  Completed   job #1  Completed
  ledger GLPR6K…zKqN  owed 1080000     ← run 1's worker
  ledger DmpJvW…Y5NA  owed  160000     ← the fee recipient, twice
  ledger H5uSqE…Gf8q  owed 1080000     ← run 2's worker
→ chain agrees with itself.
```

Which is the tool doing exactly what it was built for the day before: turning
"is CI lying?" from an hour of hand-decoding into one command. The money loop
is now proven through approve on the fixed program; `withdraw` is the one step
still unrun.

### Closed: withdraw moved real tokens out of the vault

Job #3 ran the whole loop on the fixed program, and `npm run verify:solana`
read the aftermath from the chain rather than from the run page:

```
market   jobs 4 · escrowed 0 · withdrawable 3560000
vault    FF4ahh…EhHQ holds 3560000
  ledger ESFHWY…ZD9A  owed 0          <- this run's worker, drained
  ledger DmpJvW…Y5NA  owed 320000     <- the fee recipient, four jobs deep
```

The arithmetic is the proof, and it is exact:

```
before          3,480,000
credit        + 1,160,000   (worker 1,080,000 + fee 80,000)
withdraw      - 1,080,000
                3,560,000   == what the vault actually holds
```

The vault balance fell with the ledger. That is the difference between
settlement bookkeeping — which every earlier run already proved — and tokens
leaving custody, which is the instruction the `bump` bug had made impossible.
Five ledgers now sit next to each other as a record of the whole sprint: two
with `bump 0` from before the fix and permanently orphaned, two credited after
it, and one drained to zero.

Weeks 1, 2 and 3 are done — the write path shipped, the board reads the
deployed program, and the week-3 footage was filmed against the state verified
above. What remains is the week 4 submission.

## What would stop the sprint

The standing rule from the challenge planning was: if someone made a serious
run at the Base challenge (job #3, $100 USDC, window through 2026-08-30),
that would take priority and this sprint would pause. That window has since
closed — read from chain, the job is back in `Refunded` status, and nobody
moved the money — so this no longer applies. Eternal is rolling — it
restarts when we do.
