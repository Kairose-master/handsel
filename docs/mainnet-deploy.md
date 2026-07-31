# Going to Base mainnet

> **Status: executed.** The deployment this document plans happened on
> 2026-07-30 — addresses, the measured gas table and the exact commands are in
> [`mainnet-kernel-runbook.md`](./mainnet-kernel-runbook.md), and the
> mainnet-vs-testnet feature matrix is in [`deployments.md`](./deployments.md).
> This document remains the *reasoning*; where the deployment diverged from
> the plan, the divergence is noted inline in a block like this one.

The order matters, and it is not the obvious one. **The paymaster policy comes
before the contract**, because the contract cannot lose money that was never put
into it, and the paymaster can.

> **Divergence: mainnet currently runs with the paymaster OFF.** The provider
> integration (first ZeroDev, then CDP) never sponsored a mainnet UserOp —
> the full afternoon of well-typed false errors is written up in
> `failure-modes.md` — so the deployment shipped with `PAYMASTER_DISABLED=true`:
> every Kernel account pays its own gas from a small operator-funded ETH float
> (~$0.006 per 500k-gas UserOp at measured Base fees). Everything below about
> policy sizing applies the day sponsorship is turned on, and not before.

---

## What can actually cost you money

Three separate pools, with very different exposure:

| Pool | Who funds it | What bounds the loss |
|---|---|---|
| **Paymaster** (when sponsorship is on) | You, continuously | **Nothing, until you set a policy.** Every sponsored UserOp is your ETH. |
| **Escrow in the contract** | Whoever posts a job | Bounded by what people escrow. You lose nothing you did not post. |
| **Deploy gas** | You, once | A few dollars. |

Only the first is open-ended, and it is open-ended in the way that matters: an
attacker does not need to beat the contract, they only need to make your app
send transactions. Every permissionless exit, every dispute ruling, every job
post is a UserOp — sponsored on the testnet deployment; on mainnet today each
kernel account pays for its own out of its ETH float.

So the policy is the real gate, and it goes first.

---

## 1. ZeroDev spending policy

In the ZeroDev dashboard, on the **mainnet** project (a separate project from
your testnet one — do not reuse):

> **The gas-spend fields are denominated in ETH, not USD.** Entering `1`
> against a "$1/day" intention authorises ~one full ETH a day. This was
> caught here only because the settings were pasted back for review — every
> number below is a dollar intention; convert before typing.

- **A hard monthly cap you are willing to lose outright.** Treat this number as
  spent. If the answer is "I would be upset", it is too high.
- **A per-UserOp gas ceiling.** Base is cheap; a UserOp costing dramatically
  more than a normal `postJob` is a signal, not a transaction to sponsor.
- **A rate limit per sender.** The sweeps are capped at 3 calls each per pass
  by `MAX_EXITS_PER_PASS` and `MAX_RULINGS_PER_PASS` (6 total), so a legitimate
  sender never approaches a sane limit.
- **Allowlist the contract address**, once you have it from step 3. A paymaster
  that will sponsor a call to any address is sponsoring calls to contracts you
  did not write.

Then set `PAYMASTER_METERED=true`. That is not what creates the policy — it is
your acknowledgement that you did. `lib/onchain/mainnet-guard.ts` **refuses**
every money path without it, and refuses rather than warns, because a warning on
a money path is a warning that gets scrolled past.

### The app-side fuse, in front of ZeroDev's

ZeroDev's cap is all-or-nothing: when it blows, every sponsored call stops,
including the sweeps that free other people's escrow. So `lib/gas-budget.ts`
sits in front of it with two properties the dashboard cannot express.

**Exhaustion degrades to self-pay.** A budget that simply refuses turns a gas
attack into a denial of service — the attacker spends your money *and* takes the
market offline. Over budget, the agent's own account pays instead, which on Base
is a fraction of a cent. The honest user goes from "free" to "nearly free", not
from "working" to "broken".

**Keeper traffic has a reserve user traffic cannot touch.** This is the part
worth understanding: with one shared pool, draining it also disables
`expireReview`, `expireDispute`, `reclaimJob` and `expireOpen` — so a gas attack
becomes a way to **freeze everyone's escrow**, which is strictly worse than the
gas and is the exact failure class v2 was written to close. The reserve stays
small because the sweeps are already capped at six calls per pass.

| | default | |
|---|---|---|
| `AGENT_GAS_BUDGET_USD` | `0.5` | Per AGENT, not per user — a Sybil's whole point is not being traced to one user, so a per-user cap bites too late. |
| `USER_LANE_GAS_BUDGET_USD` | `5` | The sum across all agents, rolling 24h. This is what stops many cheap identities. |
| `KEEPER_LANE_GAS_BUDGET_USD` | `2` | The reserve. If this ever empties, something is retrying without bound — a bigger number will not fix it. |
| `USER_OP_COST_USD` | `0.01` | The per-op estimate. Over-estimating degrades sooner, which is the safe direction. Replace with the measured figure from deployment #1. |

An unreadable ledger fails toward SPONSORING, not refusing: taking the market
down over a pending migration would be worse than a day of unmetered gas.

**Understand what that direction cost once already.** `gas_spend` was declared
in `schema.ts` and created nowhere — not by the migration, not by the eight
tables that really do self-create. So every read threw, the catch reported zero
spend, and the whole app-side fuse answered SPONSOR to everything **while
looking exactly like a quiet day**. An unreadable ledger and an empty one are
the same picture. ZeroDev's cap was doing all of the work and nothing said so.

Fixed in two places — `ensureLedger()` in `lib/gas-budget.ts` and the migration
— and guarded by `tests/schema-migration-parity.test.ts`. But the lesson sets
the ZeroDev number: **size it as though the app-side fuse is disconnected,
because it has been.**

### Ordering the two layers

They must blow in this order:

1. **App fuse** — degrades to self-pay. The market keeps working.
2. **ZeroDev cap** — all-or-nothing. Sponsorship stops, including the sweeps.
3. **Paymaster balance** — physics.

> **Step 1 means something different in each mode, and kernel mode has a
> prerequisite.**
>
> In EOA mode self-pay is trivial: the agent's account funds its own transaction.
>
> In kernel mode it cannot mean "send from the agent's EOA". The agent's USDC
> *and its identity* live at the kernel address — `postJob` and `acceptJob` need
> its allowance, `submitWork` reverts `NotWorker` from any other sender,
> `approveJob` reverts `NotRequester`. Sending from the EOA would change which
> account acts, not who pays gas, and the call would fail on identity with nothing
> in the error naming a budget.
>
> So kernel self-pay **drops the paymaster instead**: an unsponsored UserOp from
> the same kernel account, funded by that account's own ETH. Identity preserved,
> operator no longer paying.
>
> **The prerequisite: each agent's kernel account needs a small ETH float.**
> Nothing tops it up. `ensureAgentGas` spends the *oracle's* ether and is gated by
> this same budget, so it would refuse exactly when self-pay is needed — and if it
> did not, self-pay would be operator-funded, which is sponsorship under another
> name and would leave the budget unenforceable. Without a float the fuse refuses
> with the address to fund and the two budget variables to raise, rather than
> letting the bundler answer with an AA21.
>
> A few cents per agent is enough on Base. Send it when you provision, and step 1
> above holds in kernel mode too.

So the ZeroDev cap sits *above* the app's ceiling
(`USER_LANE` 5 + `KEEPER_LANE` 2 = **$7/day** at the CODE DEFAULTS — the
deployed config runs far smaller lanes; the runbook's §1 table is the source
of truth for the live numbers), or the graceful layer never runs. And the hardest cap needs no dashboard at all: **you cannot spend a
deposit you did not make.** Fund the paymaster with what you would accept
losing outright, and every policy above it is convenience.

### Base mainnet

| setting | start at | why |
|---|---|---|
| paymaster deposit | what you would accept losing | The only cap that cannot be misconfigured. |
| monthly cap | ≈ the deposit | A cap above your balance is decoration. |
| daily cap | **$10** | Above the app's $7 so the app degrades first; bounded so a disconnected fuse costs $10/day, not the deposit in an afternoon. |
| per-UserOp ceiling | ~10× a measured `postJob` | Set it AFTER deployment #1, from the real number. A gas-price spike must not halt the market; a pathological op must not go through. |
| per-sender rate | **200/day** | The keeper is one address doing ≤6 calls per pass at one pass per 5 min (`TRAFFIC_TICK_INTERVAL_MS`). Normal traffic is far under this; a retry loop is not. |
| contract allowlist | the market + registry, after step 3 | A paymaster that sponsors calls to any address sponsors calls to contracts you did not write. |

### Base Sepolia

Same dashboard, **separate project** — never reuse the mainnet one.

The point here is not money; testnet ETH is free. It is that **the one thing you
must never meet for the first time on mainnet is your own app hitting the cap.**
The designed behaviour — degrade to self-pay, keeper reserve untouched — has
never executed. So set testnet TIGHT, deliberately, to make it fire:

| setting | set to | why |
|---|---|---|
| daily cap | **$1** | Below the app's $7 ceiling, so ZeroDev blows FIRST. That is backwards for production and exactly right here: it is the only way to watch what happens when sponsorship stops. |
| per-sender rate | **50/day** | Low enough that a runaway loop trips it in minutes instead of overnight. |
| per-UserOp ceiling | leave generous | You are measuring the cost, not bounding it yet. |
| contract allowlist | same two addresses | Rehearse the step so it is not new on mainnet. |

Then raise the daily cap above $7 and confirm the order flips: the app degrades
to self-pay and the sweeps keep running. Two runs, opposite outcomes, both
observed before any of it is worth money.

---

## 1b. Base Sepolia first

Rehearse on Base Sepolia before any of this is worth money — and NOT at the
script defaults, which are tuned for production and hide exactly what a
testnet exists to find. The full testnet configuration (windows at the 10-min
floor so every exit is reachable, fee and bond non-zero so the `postCost` /
`bondFor` / `_burnBond` paths actually run, the deliberately-tight paymaster
policy) now lives in its own guide: [`deploy-testnet.md`](./deploy-testnet.md).

Cost: nothing. Faucet ETH, faucet USDC.

---

## 2. Deploy the registry

```bash
ONCHAIN_CHAIN=base ONCHAIN_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
ORACLE_ADDRESS=<hardware-backed key, NOT the deployer — and it WILL also be the arbiter> \
node scripts/deploy-registry.mjs --confirm-mainnet
```

`LaborMarketV2`'s constructor requires `registry` to be a contract, and its
address is **immutable**. Replacing a compromised registry later means replacing
the market too, and waiting out every live job.

The oracle key deserves more care than a backend key usually gets. It **cannot**
touch escrowed money — that was executed end-to-end during the audit with a
stolen key and the answer was zero, because the market never pays on the strength
of a score, only on approval, ruling, or silence. It **can** forge every score
the market gates on, and hand itself the registry via `setOracle`, which is a
single-step transfer with no two-step accept — so a compromise is a race the
attacker wins if they move first.

The script warns if you pass the deployer key as the oracle. Take the warning:
by then that key has touched a deploy script and an RPC endpoint, and the oracle
key should be one that has touched neither.

---

## Deploying twice on purpose

A perfectly reasonable plan, and Base Sepolia genuinely does not test the thing
that is actually unknown — Sepolia's USDC is a different contract, so a testnet
rehearsal validates the script and the app wiring, not the contract's behaviour
against real USDC or a real sequencer.

The one condition: **redeploying is cheap only while the first deployment holds
no money you care about.** Credited balances stay in a v2 forever — nobody can
move a credited balance for its owner and there is deliberately no sweep — so a
first attempt that has taken someone else's escrow cannot be abandoned, only
apologised for.

So treat deployment #1 as the rehearsal:

- Do not publish the address. Do not let anyone else post to it.
- Drive one full lap with your own money, in cents: post → accept → submit →
  approve → **withdraw** (settlement credits; it does not transfer, so a lap
  that stops at "approved" has not tested the half that pays).
- Drive one deadline lap too — post, let it sit past `reviewWindow`, and confirm
  the sweep calls `expireReview`. That path is the default outcome of the whole
  dispute design and nothing off-chain has ever executed it.
- If anything is wrong, deploy #2, repoint `LABOR_MARKET_ADDRESS`, and write off
  whatever dust is in #1.

---

## 3. Deploy the market

```bash
ONCHAIN_CHAIN=base \
ONCHAIN_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
USDC_ADDRESS=<Base USDC> \
CREDIT_REGISTRY_ADDRESS=<from step 2> \
ARBITER_ADDRESS=<the ORACLE address — see below> \
node scripts/deploy-labor-v2.mjs --confirm-mainnet
```

> **Divergence: the arbiter must currently BE the oracle.** The dispute path
> (`lib/dispute-gate.ts`) signs `resolveDispute` with `oracleWallet()` — there
> is no `ARBITER_PRIVATE_KEY` anywhere in the code — so a market deployed with
> a different arbiter address has an arbiter that can never act, and every
> dispute settles by `expireDispute`. `scripts/preflight-addresses.mjs`
> refuses the mismatch for exactly this reason. Separating the two keys (the
> better design this section argues for) is a **code change first**, then a
> redeploy; it is not an env-var choice today.

The script deploys the **committed** artifact rather than recompiling. Round 2
of the audit verified that artifact byte-identical to the audited source; a
script that recompiles at deploy time throws that guarantee away, because the
bytes reaching the chain become whatever the local solc produced that day.

It refuses, rather than warns, on: `base` without `--confirm-mainnet`, any unset
address, a `usdc`/`registry` with no code on the target chain, and a non-zero fee
with no recipient.

### Keys: one, and what that buys and costs

Deployment #1 runs **deployer = registry oracle = market arbiter on one key**.
Recorded here because it is a decision, not an oversight.

**Splitting keys saves no gas.** Gas is charged per transaction, not per
address, so three keys and one key pay identical fees. What splitting actually
costs is funding three addresses and leaving dust in each — which is the real
reason not to bother at this size.

Merging the **deployer** in is free: its authority ends when the deploy
transaction lands. `LaborMarketV2` has no owner and no setter, and the registry
takes its oracle as a constructor argument rather than assuming the deployer.

The other two are where the exposure is:

| role | what one leaked key does | rotatable? |
|---|---|---|
| registry oracle | `setLimit()` writes **any** agent's score and limit — the product's entire claim is that a score is *earned* | yes, until the attacker calls `setOracle` first |
| registry oracle | `setOracle()` hands the registry to someone else **permanently** | **no** — a redeployment of the registry and every score in it |
| market arbiter | `resolveDispute(id, false)` refunds any contested job | **no** — immutable, no setter |

They fail in opposite directions: the oracle can be rotated only if you notice
before the attacker does, and the arbiter cannot be rotated at all. One key
means one leak reaches both.

`CRON_SECRET` has already reached Vercel's logs once in this project's history,
so "the env leaks" is a thing that has happened here, not a hypothetical.

**This was accepted for deployment #1 as a rehearsal cost — and deployment #1
is now the live market.** It holds real Circle USDC and settled job #1 on
2026-07-30, so single-key exposure is a live risk, not a rehearsal artefact.
`scripts/deploy-labor-v2.mjs` prints which roles share an address at deploy
time, so the choice was visible at the moment it became permanent. The rule
set the code actually enforces (`scripts/preflight-addresses.mjs`):
**arbiter == oracle** (or disputes are unresolvable) and **feeRecipient !=
oracle** (or fee revenue sits on the hottest key).

**Revisit for deployment #2 — and know it is a code change.** Splitting the
arbiter off needs an `ARBITER_PRIVATE_KEY` path in `lib/dispute-gate.ts`
first; for the deployed contract it is impossible outright (`arbiter` is
immutable). If split, the arbiter can sit at zero balance — `DISPUTE_WINDOW`
gives fourteen days to fund it — at the cost that automatic rulings stop and
every dispute settles by `expireDispute`, which pays the worker. That is the
designed default, not a failure.

### The recommended first config, and why

Every one of these is **immutable**. There is no setter for any of them.

> **What actually deployed (2026-07-30):** `FEE_BPS=500`, `FLAT_FEE=30000`
> (5% + $0.03), `BOND_BPS=500`, `FLAT_BOND=30000`, delivery window 4h–30d.
> The fee took `MAX_FEE_BPS` rather than the 200 suggested below — chosen
> deliberately, since the operator eats the gas either way — and the bond
> mirrors the fee, which has one measured consequence: at every bounty the
> bond and the fee are the **same number** (0.035 at a 0.1 bounty), and on
> mainnet job #1 that coincidence made the bond read as the fee having been
> taken from the worker. `lib/worker-funds.ts` and the UI's bond/claimable
> lines exist because of it.

| | Suggested | Why |
|---|---|---|
| `FLAT_FEE` | **the measured gas envelope** | See below. This is the number that makes sponsorship solvent. |
| `FEE_BPS` | `200` | Scales with the value at risk. It cannot cover gas on its own — see below — but it is the right shape for the part that *is* proportional. |
| `FLAT_BOND` | **≈ `FLAT_FEE`** | Makes `acceptJob` cost something at every bounty size. Returned in full unless the job is reclaimed, in which case it is **burned** — see below. |
| `BOND_BPS` | `500` | The proportional half of the same. |
| `REVIEW_WINDOW_S` | `1 day` | Not the 7 the constant used to hardcode. Seven days is very long for a market whose jobs finish in minutes, and it is the exposure window for both the accept-squat and the silence forfeit. |
| `SILENCE_FORFEIT_BPS` | `1000` | A worker submitting garbage earns 10% from any inattentive requester. That was chosen when the money was testnet. **Re-choose it now that it is not.** |

> **`FLAT_FEE`, `FLAT_BOND` and `MIN_BOUNTY` are TOKEN UNITS, not whole tokens.**
> USDC has six decimals, so one dollar is `1000000` and three cents is `30000`.
> Writing `1e18` out of ETH habit is wrong by a factor of a trillion, and until
> round 3 it deployed without complaint: a `FLAT_FEE` at `1e18` made every
> `postJob` revert forever, and a `FLAT_BOND` at `1e18` was worse — posting still
> worked, so requesters went on escrowing into jobs no worker could accept.
> `MAX_TOKEN_PARAM` (1,000 units) now rejects all three in the constructor, and
> the deploy script checks them before spending gas. It is a **typo bound, not a
> policy**: it permits ~33,000× the intended flat fee, so it must never be the
> thing that decides what this deployment charges.

> **A slashed bond is burned, not paid to the requester.** It went to the
> requester until round 3, and that made the accept-squat profitable in the
> other direction: the requester chooses `deliveryWindow` at post time and the
> spec is off-chain, so nothing on-chain relates the size of the work to the time
> allowed for it. Post at `MIN_DELIVERY_WINDOW`, wait, `reclaimJob` — bounty back
> plus the bond of every worker who could not have finished, with the bounty
> never at risk. Measured over five cycles at a 10% bond and a 2% fee: requester
> `+5×(bond − fee)`, worker `−5×bond`. And `MAX_BOND_BPS` (2000) exceeds
> `MAX_FEE_BPS` (500), so the two ceilings **cannot** be chosen to make it
> unprofitable — the fix had to be about where the bond goes, not how big it is.
>
> A slash paid to a party who can influence whether the slash occurs is an
> incentive to manufacture it. Routing it to `FEE_RECIPIENT` would close it for
> every third-party requester and leave it open for you, since you are also a
> requester while the market bootstraps. Burning closes it for everyone, and it
> is what the bond's stated purpose already asked for: *make the squatter pay*,
> which was never the same goal as *make the victim whole*.
>
> Operationally: burned bonds accumulate as `escrowSolvency().surplus`, which no
> one — including you — can sweep. **A growing surplus on this contract is not an
> alarm; it is the squat rate denominated in money.** `BondBurned` is the event
> that tells you which.

### Why a percentage alone cannot work

*(This is the pre-deploy argument for `FLAT_FEE`, computed at the 200bps then
under consideration. The market deployed at 500bps + $0.03 flat — the shape
the argument asked for — and on mainnet today the gas is the agent's own, not
the operator's, until sponsorship is turned on.)*

**Revenue is per-POST; cost is per-ACTION.** A job's fee is charged once, at
`postJob`. Its gas is spent five or six times — post, accept, submit, approve,
and the withdrawals — and each of those is a sponsored UserOp the operator pays
for.

Worse, that expense is **flat**. A $0.05 job and a $100 job burn the same gas. A
bps fee scales with bounty; the cost does not. So:

| bounty | fee at 200bps | gas envelope (≈5 UserOps) | |
|---|---|---|---|
| $100 | $2.00 | ~$0.05 | solvent |
| $1 | $0.02 | ~$0.05 | underwater |
| $0.05 | $0.001 | ~$0.05 | **50× underwater** |

And it cannot be fixed by raising the percentage: `MAX_FEE_BPS` is 500, so the
most a deployment can ever charge on a $0.05 job is $0.0025. The ceiling is a
fraction of a number that is already tiny. **`MIN_BOUNTY`'s own comment says the
mainnet plan turns on cent-scale bounties**, which is precisely where the
proportional model has no solution.

`FLAT_FEE` is the fix: a floor sized at the gas envelope, charged once, never
refunded — because the gas was spent posting, and a refundable gas reimbursement
is a loan.

### And why the bond needs the same treatment

The identical arithmetic breaks the defence on the worker side. 5% of a $0.05
bounty puts $0.0025 at risk, which deters nobody — so `acceptJob` stays
effectively free exactly where the market is thinnest. **A free `acceptJob` is
the one action an attacker can repeat at zero cost while the operator pays gas
for every one of them**, which is the DDoS shape the ZeroDev cap exists to
survive rather than prevent.

`FLAT_BOND` prices it. An honest worker locks it for the length of one job and
gets every unit back; only `reclaimJob` — a deadline passed with an empty
`resultHash`, no judgement involved — takes it.

### How the money actually gets back to the operator

The fee accrues as **USDC**, credited to `feeRecipient` inside the contract.
The loop is manual and it does close: `withdraw()` the accrued USDC → convert
to ETH → top up whichever pool is paying for gas. Today that pool is **each
agent's own ETH float** (operator-dripped, sponsorship off); the day a
paymaster is live it becomes the paymaster deposit. Watch it on
`/admin/health`; if fee revenue is not keeping pace with the gas being
dripped, `FLAT_FEE` was set below the real envelope and the only fix is a
redeploy.

### Sizing FLAT_FEE

Deployment #1 was how it was measured: one full lap, actual gas from Basescan
(~$0.006 per 500k-gas UserOp, five to six ops per cycle), margin on top —
and `FLAT_FEE=30000` ($0.03) shipped on deployment #1 itself, immutable. If
the envelope ever outgrows it, that is a redeploy, not a knob.

Token units, not dollars. USDC has 6 decimals, so $0.03 is `30000`.

`ARBITER_ADDRESS` *should* be a dedicated key — the oracle publishes scores,
the arbiter moves money, and one key doing both means one compromise does both
— but see the divergence note under step 3: today the code signs rulings with
the oracle wallet, so the two must be the same address until that changes.

---

## 4. Verify on Basescan

solc **0.8.24**, optimizer **200 runs**, **viaIR ON**. viaIR is not optional —
the contract does not compile without it since the `jobs` getter reached 14
fields.

The deploy script prints the bytecode hash. A verification that does not
reproduce it is a different contract, whatever the source says.

---

## 5. Point the app at it

```
LABOR_MARKET_ADDRESS=<from step 3>
USDC_ADDRESS=<Base USDC>
PAYMASTER_METERED=true      # or PAYMASTER_DISABLED=true — see below
PAYMASTER_DISABLED=true     # the live mainnet config: no sponsorship
BUNDLER_RPC=<bundler URL>   # ZERODEV_RPC still works as the legacy name
```

`realMoneyBlockers()` accepts either acknowledgement: `PAYMASTER_METERED=true`
says "a spending policy exists on the paymaster", `PAYMASTER_DISABLED=true`
says "there is no paymaster to police". The current mainnet deployment runs
the second.

`isV2Market()` detects V2 from the **deployed code**, not from an env flag — an
env var says what someone believed when they set it. Once it answers true, the
V1 dispute sweeps stand down and the deadline sweep takes over.

---

## What you are accepting

Stated plainly, because none of it is removable by a code change:

- **The contract is immutable, unowned and unpausable.** Every defect found
  after this is permanent. The only response is deploy v3, stop posting to v2,
  wait — and that only empties JOBS. Credited balances stay in v2 forever;
  nobody can move a credited balance for its owner, and there is deliberately no
  sweep. A post-only `halt()` was considered and declined, so the response to a
  discovered defect is to stop your own UI while an agent posting with its own
  key keeps funding a contract you know is broken.
- **The arbiter is a single immutable key with no rotation.** A silent arbiter
  is survivable — `expireDispute` is permissionless. A compromised one is not,
  and with a lien live it can destroy a lender's perfected security interest,
  which is a third party that is not in the dispute and gets no appeal.
- **USDC on Base is a Circle-upgradeable proxy.** The blocklist is handled. A
  transfer that returns no data would brick every withdrawal permanently — that
  one is closed by the SafeERC20 handling. A fee-on-transfer USDC would produce
  `held < owed`, which `escrowSolvency()` surfaces and nothing prevents.
- **No external audit yet.** Two adversarial rounds ran against
  `@ethereumjs/vm`, which proves nothing about real USDC, sequencer timestamp
  granularity, L2 reorg depth, or gas under real Base conditions. That is
  exactly the ground an external auditor with a forked-mainnet harness covers.

Start with amounts you would shrug at.
