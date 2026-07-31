# Setting up the challenge escrow — start to finish

The goal: **$100 of real USDC locked in `LaborMarketV2` escrow, in `Accepted`
state, between two agents you control**, so the only way an outsider extracts it
is a genuine contract bug. No open job to snipe, no submissions to grade, no
review window to babysit.

## The idea in one line

Post a job and accept it with your OWN worker **before** announcing. Once a job
is `Accepted` it cannot be accepted by anyone else, and a worker that never
submits leaves the escrow locked until the delivery deadline (up to 30 days),
inert to outsiders.

## Prerequisites

- Basescan verification done (`docs/basescan-verification.md`).
- Keys rotated (the pre-flight in `open-challenge.md`).
- **Two agents you control, on different addresses:** `R` (requester) and `W`
  (worker). Two separate *accounts* sidesteps both the on-chain `SelfWork()`
  check (different addresses) and the app's owner-self-deal block (different
  owners). If you insist on one owner, make the calls directly against the
  contract instead of through the app.
- **`W` must be inert — auto-mine OFF, no runtime connected.** This is
  load-bearing, not hygiene: `autoMineTick` has a *self-heal* step
  (`lib/auto-mine.ts`) that finds any job an auto-mining agent has already
  accepted and **auto-generates and submits the work for it**. If `W` has
  auto-mine on, the next tick completes your challenge job on its own — the
  escrow settles to `W`, the job shows `Completed`, and the "$100 locked for 30
  days" premise is gone. The gate is a single flag: `autoMineTick` returns
  immediately when `agent.autoMine` is false, so the self-heal never runs.
  Create `W` fresh, never turn on auto-mine, never attach a local/cloud/mcp
  worker. It exists only to hold the accept.

## Amounts (deployed schedule: fee 5% + $0.03, bond 5% + $0.03)

| agent | needs | why |
|---|---|---|
| `R` (requester) | **$105.03 USDC** | bounty $100 + posting fee $5.03 |
| `W` (worker) | **$5.03 USDC** + a few cents of ETH | accept bond $5.03; ETH for gas (self-paid on mainnet) |

**Fund nothing else into these agents, and drain every other agent/treasury**
so the total the mainnet deployment holds is ~$110. That is the blast-radius cap
the pre-flight asks for: `AGENT_OWNER_PRIVATE_KEY` derives every agent wallet, so
"what a compromise loses" is the sum they hold — keep it near the prize.

USDC has 6 decimals: **$100 = `100000000`, $0.03 = `30000`.** Circle USDC on
Base = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## Step 1 — post the job (as `R`)

Two calls (the app's `postJobV2` batches them; or do them directly):

1. `USDC.approve(LaborMarketV2, 105030000)`  — bounty + fee
2. `LaborMarketV2.postJob(bounty=100000000, minScore=0, specHash=<any non-zero bytes32>, deliveryWindow=2592000)`
   - `deliveryWindow = 2592000` = 30 days = the maximum, so the lock lasts the
     whole window.
   - `specHash` any non-zero value — this is a self-to-self job that never gets
     worked, so the spec is irrelevant; just don't pass zero (a zero hash reads
     back detached). e.g. `keccak256("handsel-challenge")`.
   - Record the returned `jobId`.

## Step 2 — accept it (as `W`), immediately, before any announcement

Accept **manually / by a direct call — never via auto-mine.** Confirm
`W.autoMine == false` first (see Prerequisites: a self-healing auto-miner will
otherwise finish the job for you).

1. `USDC.approve(LaborMarketV2, 5030000)`  — bond
2. `LaborMarketV2.acceptJob(jobId)`

Now status = `Accepted`. The $100 escrow is locked, held by the contract,
between `R` and `W`.

Do this **right after Step 1**. While the job is `Open`, anyone meeting
`minScore` could in principle accept it — so don't leave a gap, and **don't
announce until it is `Accepted`.** (Belt-and-suspenders: set `minScore` high in
Step 1 and pre-run one job on `W` so only `W` qualifies — but accept-before-
announce is the real protection, since nobody is watching an unannounced job.)

## Step 3 — do NOT submit, and make sure nothing submits FOR you

Leave the job in `Accepted`. `W` never calls `submitWork`. The escrow stays
locked until `deliveryDeadline` (~30 days from accept).

"Don't submit" is not just "don't click submit" — the only path that completes
an `Accepted` job is a `submitWork`, and the only thing that would fire one
without you is `W`'s own auto-miner (the self-heal step above) or a runtime
polling as `W`. With `W.autoMine == false` and no runtime attached, there is no
mechanism left that can submit — the background sweeps only ever *reclaim* or
*expire* an accepted job (refunding you), never complete it. Re-check
`W.autoMine == false` once after accepting, and you're done.

## Step 4 — verify the lock (this is what the challenge page links to)

Read `LaborMarketV2.jobs(jobId)` and confirm:

- status reads **`Accepted`**
- `bounty == 100000000`
- `requester == R`, `worker == W`
- `deliveryDeadline` ≈ now + 30 days

Confirm the `LaborMarketV2` contract holds the USDC (`totalEscrowed` / its USDC
balance includes the $100). The challenge page points at the **contract address
+ `jobId`** on Basescan.

## Step 5 — publish

Fill the launch post's blanks: escrow = the `LaborMarketV2` address (Basescan
link), the `jobId`, and the end date (= `deliveryDeadline`). Announce.

## During the 30 days — what an outsider can and cannot do

| action | possible for an outsider? |
|---|---|
| Accept the job | **No** — already `Accepted` |
| Approve it | **No** — `NotRequester` (only `R`) |
| Submit for it | **No** — `NotWorker` (only `W`) |
| Raise a dispute | **No** — only `R` or `W` |
| `reclaimJob` (the only timeout in `Accepted`) | Reverts until `deliveryDeadline` (`reclaimable()==false`); and when it fires it refunds `R`, so it pays no outsider |

So for 30 days the escrow is inert to everyone but a contract bug. **That is the
whole target** — the challenge is now purely "make the contract pay you", with
the grader and the review window entirely out of the picture.

## Step 6 — at the deadline (day ~30), if it held

Call `reclaimJob(jobId)` (you, or anyone — it is permissionless once due):

- The $100 bounty is **refunded to `R`**.
- `W`'s bond ($5.03) is **burned** — reclaim's slash, a real ~$5 cost of running
  the challenge.
- The fee ($5.03) already went to `feeRecipient` (you); `withdraw` it.

**Net cost of a challenge that holds ≈ the burned bond (~$5) + gas.** The $100
comes back.

*(To avoid burning the bond: before the deadline, have `W` `submitWork`, then let
the review window lapse — `expireReview` settles 90/10, both your own agents, and
the bond returns. More steps for ~$5; usually not worth it.)*

## If someone wins

They extracted the $100 through the contract — take-it-and-it's-yours, per the
rules. Verify on-chain, then write it up in `docs/failure-modes.md`, fix, and
republish. That is the good outcome.
