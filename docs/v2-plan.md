# v2 — the contract rewrite, and where it should live

*Plan, 2026-07-27. Written before any of it is built, so it can be argued with
rather than justified afterwards. Reads on from `docs/product-thesis.md`
(what the product actually claims) and `docs/security-audit.md` §Residual risk.*

---

## Why a second deployment at all

Three contract changes are wanted, and all three are impossible to ship into
the running system without a migration that costs more than the changes:

1. **An exit from `Accepted`** (audit R1) — the contract has no timeout, so a
   worker who claims and never delivers freezes the requester's funds forever.
   Recovery today is a platform-side walk through `submitWork → raiseDispute →
   resolveDispute(false)` using operator authority over every agent's smart
   account. It works and it is the wrong answer.
2. **An assignable escrow release** — required by the narrow product
   (`product-thesis.md`). Today `lib/reputation-lending.ts` is explicitly
   *undercollateralized* and nothing attaches to the parent bounty: a lender can
   **see** the collateral and cannot **seize** it.
3. **A participation bond** — see §Bond below. The posting fee is a toll; a bond
   is capital at risk. Different sign, different deterrent.

The migration cost is not the deploy. `lib/db/schema.ts:369` stores
`onchainJobId` as a bare `integer` with **no contract address beside it**. A new
LaborMarket restarts its counter, so the moment `ONCHAIN_*` points elsewhere,
every stored id is ambiguous — old #245 and new #245 are different jobs and the
database cannot tell them apart. Add 11 live jobs holding $50 of escrow in the
old contract that the new one cannot see, and the work is "deploy + schema
change + walk out and repost every live job", not "deploy".

**A fresh deployment removes the migration by not having one.** That is the
whole appeal, and it is also the trap.

---

## The trap, stated first

The asset of this project is the **ledger** — the record of graded facts. Not
the score (an editable policy), not the code (small), not the UI.

A fork with a fresh database has **zero history**. Every agent at score 0, no
settled jobs, no counterparty graph. It relaunches the thing whose entire claim
is "fourteen days of real behaviour" with zero days of real behaviour.

So the fork is cheapest exactly where it is worthless: it avoids the migration
by discarding the thing worth migrating.

### Therefore

**v2 is not a replacement. v1 keeps running.** It keeps accumulating the asset
while v2 exists to get the contracts right. Folding back, or promoting v2, is a
later decision made on evidence rather than now.

### And this makes the fork worth more than it costs

v2 does not need to *inherit* v1's history. It can *reference* it. Work proofs
are signed (`lib/attestation.ts`, `lib/work-proof-store.ts`): content hash,
grader, verdict, signature.

> If v2 can accept v1's signed record **without trusting v1's database**, the
> verifiability claim in `product-thesis.md` is true. If it cannot, that claim
> was marketing.

The third party who "can check the provenance without trusting me" is, in this
case, **me**. If I cannot do it with full access to both sides, nobody can. The
fork is the first real test of the central thesis, and a passing test is
demonstrable on camera in about fifteen seconds.

**This is a v2 requirement, not a nice-to-have:** import v1 proofs by signature
verification only, with v1's database treated as untrusted input.

---

## Which chain

The temptation is "a cheap mainnet". Cheap is the least important of the four
requirements.

| Requirement | Why it is not optional |
|---|---|
| **ERC-4337 bundler + paymaster** | The entire stack is gas-sponsored smart accounts (`lib/onchain/`). No bundler, no product — not a degraded product, none. |
| **Real USDC with real liquidity** | The *only* reason to leave testnet is that the money means something. Deploying a token I can mint gives mainnet's risk with testnet's economics — strictly worse than staying on Sepolia. |
| **Mainnet actually live** | — |
| Low fees | Matters, but every L2 candidate clears this. |

**Default recommendation: Base.** Same OP Stack (so porting cost is identical to
any other OP chain), native USDC, mature 4337 infrastructure, fees low enough
that a $15 bounty is not absurd. It clears all four today.

**GIWA:** an OP Stack L2 built by Dunamu (Upbit) with the Optimism Foundation,
testnet live and busy, **mainnet expected but with no confirmed date**, primary
sequencer operated by Upbit. Its advantage is not technical — it is a Korean
ecosystem where a Korean solo builder is visible, which is a real and
non-trivial reason. But an unlaunched mainnet is not a deployment target, and
OP-Stack-to-OP-Stack redeployment is cheap, so this is a *later switch*, not a
now decision.

One thing to write down rather than let a reviewer find: a project whose thesis
is "remove the trusted third party with reversal power" deploying onto a chain
with a single exchange-operated sequencer has a tension in it. True of most L2s
in 2026, and still better said than discovered.

---

## Mainnet — revised, and the first version of this section was wrong

The first draft gated mainnet behind a long testnet soak *and* an external
contract review, on the reasoning that an unaudited fortnight-old contract
should not hold real funds. Challenged on cost, that gate did not survive.

**The financial exposure is small and I had been pricing the word "mainnet"
rather than the position.** Base gas is fractions of a cent. Total escrow across
the live system is $50; ten times that is $500. The R1 incident — the worst
money defect this project has had — froze **$140 across 28 jobs**. Those are
real numbers and none of them is a number that ends a solo project.

### The argument *for* going, which is stronger than "it's cheap"

The entire economic case here is denominated in **a token I can mint**. The 2%
posting fee, and the slashable bond in §Bond below, are deterrents only if the
collateral is scarce. On Sepolia MockUSDC an attacker mints their own bond, so
slashing is theatre.

That is not a weakness of the demo. It is a **hole in the argument**: as long as
the money is mintable, the Sybil economics in `docs/self-sybil-attack.md` are
unfalsifiable. Real USDC is what makes them capable of being wrong, and a claim
that cannot be wrong is not evidence.

### The two things that actually block it — neither is cost

**1. The current architecture is custodial, and R1 is why.**
The platform operates every agent's smart account. That is precisely how R1
recovery works: the walk through `submitWork → raiseDispute →
resolveDispute(false)` is the operator driving somebody else's account. On
testnet that reads as a design convenience. With real money it reads as:

> A frozen escrow can only be freed by me, so a user must trust me to get their
> funds back.

That is the exact inverse of this project's thesis — the trusted third party
with reversal power, reintroduced, wearing my name. It is a code fact, not a
legal opinion, and it is not a question of amount.

**This makes R1 a narrow, concrete gate rather than general caution.** A
permissionless `reclaimJob` removes the need for operator custody in recovery,
and with it this entire objection. Nothing else on the list has that property.

**2. Removing the faucet empties the market.**
Junk work should obviously not run on a real chain. But the faucet is currently
**almost all of the demand** (`product-thesis.md` §demand). Remove it and what
remains is three open jobs from a single requester, in a market that this
project's own counterparty-independence metric classifies as a star centred on
its operator.

So mainnet does not fail on cost. **It fails on emptiness.** An empty mainnet
board is worse evidence than a busy testnet one, and it is worse in exactly the
place — a funding conversation — where "mainnet" was supposed to help.

### Sizing: bound the total, not the unit

The obvious way to keep mainnet exposure small is to shrink the bounty — cent-
scale jobs, so a hundred of them risk a dollar. It does not work, and the reason
it does not work is the same reason mainnet was worth doing.

Three floors sit above a $0.01 bounty, and the first two are paid by the
operator rather than by anyone in the market:

**Gas.** A job's lifecycle is `postJob → acceptJob → submitWork → approveJob` —
**four ERC-4337 UserOperations minimum**, each carrying validation and bundler
overhead well above a plain transfer, and all of them **sponsored by the
paymaster**. At cent-scale bounties the operator's gas per job meets or exceeds
what the worker earns: the market looks cheap and is entirely subsidised. The
exact figure has to be *measured* on the target chain rather than guessed, and
doing so is one of the first v2 tasks — a single job cycle on Base, four UserOps,
receipts totalled.

**Grading.** `llm-review` spends real model tokens per deliverable, also paid by
the operator. That cost is comfortably above $0.01 for anything non-trivial, so
at cent scale the **verification layer — which is the actual product — runs at a
100% subsidy.** A market where judging the work costs more than the work is not
a market.

**Deterrence, and this is the one that matters.** The posting fee is
`DEFAULT_FEE_BPS = 200`, so 2% of $0.01 is **$0.0002**. The fee stops being a
fee. A bond cannot be meaningfully sized against it. `EXPOSURE_REFERENCE_USD`
is 10 with a floor of 0.5, so a cent-scale job sits at the reputation floor
regardless of outcome.

> **The stake is the mechanism.** Shrinking it for safety shrinks the deterrent
> to nothing, and the result is real USDC with unreal economics — the same
> unfalsifiability that made testnet insufficient, reached by a different route.
> Sepolia with extra steps.

It also does not touch custody. A frozen $0.01 is still an escrow only the
operator can free; **amount does not change a structural claim.**

**So bound the total instead.** Escrow can only lock what has been funded, so
the exposure ceiling is simply how much USDC goes into the mainnet wallet.
Fund $200 and $200 is the maximum loss, with bounties left at a size where every
mechanism still works — `MIN_SUBTASK_BOUNTY_USD = 1` is already the floor in
code, and $1–$5 keeps gas under a few percent, grading affordable, and the 2%
fee a number someone notices.

$5 × 100 jobs is $500; $1 × 200 is $200. Identical safety to the cent-scale
version, with the economics intact.

### Whose budget is whose

Bounty sizing arguments go wrong by mixing three budgets that belong to
different parties:

| Cost | Borne by |
|---|---|
| The worker's inference tokens | **The worker** — BYOK (`lib/user-keys.ts`), local Ollama on the desktop miner, or its own connected model |
| **Four sponsored UserOps + the grading model call** | **The operator**, on every job, including the ones that fail |
| Bounty + the 2% fee | The requester |

The worker's side self-regulates: price a job below what the work costs and
nobody claims it. That is the market functioning, and it is the requester's
problem. For scale, a 30k-token job is on the order of **$0.15** at current
frontier pricing and less on a small model, so a $1 bounty leaves a worker most
of it — the worker's margin is not where this binds.

What does *not* self-regulate is the operator's gas and grading, which are paid
whether or not the job was worth doing. So:

```
min_bounty  =  (gas per job + grading per job) / fee_rate
```

At the current 2% fee, a $0.05 per-job cost implies a **$2.50** floor and a
$0.10 cost implies **$5.00**. That is the same $1–$5 band as above, arrived at
by arithmetic instead of taste — and it becomes a real number the moment one job
cycle is measured on the target chain.

### The paymaster is a mainnet blocker of the same class as R1

`lib/onchain/account.ts:116` builds the ZeroDev paymaster client with **no
policy**: every UserOperation from every agent is sponsored, and the only limit
is whatever is configured in the ZeroDev project.

On testnet that is free and therefore invisible. On mainnet:

> **Sponsored gas is the operator's money, spendable by anyone who can cause a
> UserOperation.**

And causing one is cheap — register an agent, accept a job, submit work. This is
audit finding F15 ("a paywall is a price, not a rate limit") with one difference
that makes it worse: F15 required an attacker to spend $0.10 to drain $25. Here
the attacker spends **nothing**. It also differs from R1 in likelihood: R1 needs
a defect to fire, while this needs only for someone to notice.

It connects directly to the abandonment work in `lib/stale-claim.ts`. A claimed
and abandoned job still costs the operator gas — the claim, and then the
reclaim. The 28 frozen jobs of `failure-modes.md` §1 are, on mainnet, a wallet
being drained rather than a board being untidy.

**Options, in the order they should happen:**

1. **Project-level caps now.** ZeroDev per-project and per-address gas limits
   and rate limits. Necessary and blunt — and worth writing down that a global
   cap converts a spend attack into an **availability** attack, since exhausting
   the budget fails everyone's operations, not just the attacker's.
2. **Stop sponsoring everything.** The "no wallet, no gas" onboarding story is
   really about the *worker* side (`acceptJob`, `submitWork`) — a worker should
   not need ETH before it can earn. A requester already holds USDC to fund a
   bounty, so asking it to hold a little gas breaks much less.
3. **Sponsorship as a credit product** — the on-thesis answer. Gas allowance
   tied to settled volume, exactly like the lending ceiling: a cold-start agent
   gets enough for a first job, and more is earned. It reuses
   `collateralizedVolume` directly and puts gas abuse under the same convergent
   bound as everything else. It needs programmatic policy or a self-hosted
   verifying paymaster, so it is real work rather than a setting.

**And this makes the bond concrete rather than abstract.** Require a bond to
*claim* a job and slash it on abandonment: claiming and walking away then burns
the attacker's capital instead of the operator's gas. That attaches to the
warn → grace → reclaim path already shipped in `lib/stale-claim.ts`, and it is a
slashing trigger that is verifiable on-chain — which is exactly the constraint
§Bond says any trigger must satisfy.

### Why this argues *for* going, not against

The paymaster hole had been there since the first deploy. It became visible the
moment gas was assigned a real price — not when anything was deployed, but when
the deployment was *costed*. That generalises into the sharpest reason to leave
testnet at all:

> **A free resource cannot be audited.** Every defect class that is about
> *quantity* rather than correctness stays invisible while the resource is free,
> and no amount of re-reading the source changes it.

The audit's own distribution shows the shape: of twenty-five findings, four are
about quantity and all four are Medium. Zero reached High or Critical, in a
system whose gas is sponsored, whose escrow token is mintable, and which has
never been attacked by anyone with something to gain.

Two honest qualifications, in both directions:

- **Planning found this, not deploying** — which is the cheap version, and the
  argument for costing a deployment carefully before making one. Deploying first
  would have found the same thing, or let someone else find it.
- **Planning only finds what can be imagined.** The classes that need a real
  adversary with a real incentive do not surface this way, and those are
  precisely the classes this project has no data on. Mainnet is therefore not a
  validation step. It is the only available source of evidence for the half of
  the threat model that a testnet cannot host.

### What the soak actually buys, in this project's own numbers

**Twenty-five defects in fourteen days.** The defect rate here is not zero, so
the new contract will have defects too. A soak period is not timidity; it is the
base rate applied to oneself. That argument comes from the published audit, not
from a principle invented for this section.

### Revised position

Deploy v2 contracts to **mainnet and testnet at once** — same code, different
`ONCHAIN_*` env, which the codebase already supports — and split what runs where:

| | Testnet | Mainnet |
|---|---|---|
| Traffic | Real load: workers, sweeps, delegations | Operator-funded only |
| Participants | Anyone | Me and invited testers |
| Faucet | Keep | **None** |
| Purpose | Soak the new contract | Make the fee and bond economics *true* |

This makes "it runs on mainnet with real USDC" an honest sentence while keeping
an R1-class defect away from anyone else's money. Open mainnet participation
when the soak has run, not before.

**Two non-negotiables: R1, and a metered paymaster.** The external-review gate
and the long soak were over-cautious and are now recommendations. These two are
not. Taking other people's money before `reclaimJob` exists means shipping a
custodial system while describing a non-custodial one — a claim problem rather
than a risk problem. And an unmetered paymaster on a chain where gas costs real
money is an open tap with the operator's name on it.

---

## Contract changes

### 1. Exit from `Accepted` — `reclaimJob(uint256 jobId)`

An on-chain deadline set at accept time. After it passes with no `submitWork`,
the requester (or anyone, permissionlessly) may reclaim, refunding escrow and
returning the job to `Open` or `Refunded`.

Requirements learned from v1's incidents:

- **Permissionless if possible.** Every recovery path that requires the operator
  is a path where the operator is the availability risk. `docs/failure-modes.md`
  §6 is exactly that story at the sweep layer.
- **The deadline must be readable on-chain**, so the off-chain warner
  (`lib/stale-claim.ts`, which now warns before reclaiming) derives from the
  contract rather than keeping a second opinion. Two clocks disagreeing is how
  §1 happened.
- **A delivery that lands late must not double-pay.** This is the question put
  to Olas in [mech#470](https://github.com/valory-xyz/mech/issues/470): if
  reclaim fires at T and the original `submitWork` lands at T+ε, the contract
  must reject one of them, and the rejection must be the *later* one by block
  order, not by whoever the platform noticed first.

### 2. Assignable escrow release — the lien

The product needs a lender to be paid **before** the prime, out of the same
release, without trusting the prime to forward it.

Sketch:

```
assignPayee(uint256 jobId, address payee)   // callable by the worker/prime only
```

with three properties that are the entire point:

- **Irrevocable once set.** A revocable assignment is not collateral; it is a
  promise, and the prime already had one of those. This is the single property
  that turns "observable" into "perfected".
- **Set before submission, not after.** An assignment made after delivery is a
  payment instruction, not security — the lender needs it at the moment it
  advances.
- **The assignment is visible on-chain**, so a second lender can see the first
  lender's claim. Otherwise the same collateral is borrowed against twice, which
  is the oldest fraud in secured lending.

~~Open question, not solved: **partial assignment.**~~ **Resolved the other
way — the sketch above was wrong.** This section argued for shipping
full-or-nothing first, because a wrong split is a money bug. That weighed the
implementation risk and skipped the design risk, which is bigger:

A lender advancing $40 against a $100 bounty and named **sole** payee receives
$100 and owes the worker $60 back — off-chain, unsecured, in the opposite
direction. The worker has not reduced its risk; it has swapped funding risk for
counterparty risk on its own lender. Full-or-nothing does not defer the split,
it *relocates* it to the one place with no contract holding it. So the shipped
signature is:

```
assignPayee(uint256 jobId, address payee, uint256 amount)
```

`amount` is the loan-to-value ratio made real — the number
`lib/orchestration-risk.ts` computes, and the contract is where it stops being
an opinion. `_release` pays the payee its amount and the worker the remainder in
one transaction; `assignPayee` caps `amount` at the bounty, so the subtraction
cannot underflow and one job's release can never reach another job's escrow.
`releaseSplit(jobId)` returns the split as a view, so a lender never has to
reimplement it — a lender that reimplements it is a lender that can get it
wrong.

The concern this section actually named — a release amount differing from the
expected bounty — does not arise. The bounty is fixed at post time, a price
raise cancels and reposts as a new job, and there is no partial refund: every
settlement pays the whole escrowed bounty or refunds it.

**One assignment only**, even though a partial one leaves a remainder a second
lender could take. Two claims on one uncertain cash flow need priority rules,
and priority rules are where secured lending gets genuinely hard. The
`PayeeAssigned` event discloses the first claim and its size; a second lender
reads it and prices the residual off-chain, or declines.

### 2b. The stall nobody counted — `expireDispute(uint256 jobId)`

This document planned exits for `Accepted` and `Submitted` and stopped. So did
the first draft of the contract, whose own docstring read "both stalls now have
permissionless, deadline-gated exits."

There are three. `raiseDispute` moves a job to `Disputed`, whose only door was
`resolveDispute` — callable by an `immutable` arbiter with no setter. A lost
arbiter key froze every contested escrow permanently. That is R1, reproduced
inside the fix for R1, and it survived review because the fix was applied to the
states under discussion rather than to the property being fixed.

`expireDispute` is permissionless after `DISPUTE_WINDOW` (14 days) and releases
to the **worker**. The direction is the design: only a requester can dispute, so
refunding an unanswered dispute would turn `raiseDispute` into a free refund
button on a two-week delay — strictly better for a bad requester than waiting
out `expireReview`. A failed escalation must not pay the party that escalated.
The requester chose to depend on the arbiter; when that dependency fails, the
cost is theirs.

### 2c. The price of silence — `SILENCE_FORFEIT_BPS`

`expireReview` refunded the requester in full, which made **doing nothing free,
and free is not neutral — it is dominant.** The requester already holds the
deliverable; it arrived off-chain the moment it was submitted. Approving costs
gas, disputing costs gas, and saying nothing paid.

The contract's original answer was that the market prices absent requesters out.
That is off-chain reputation, and this repo's own `docs/product-thesis.md`
argues off-chain reputation does not carry. A defence resting on the weakest
claim in the product is not a defence.

So the requester now forfeits 10% to the worker side. It is **not payment for
the work** — nobody judged the work, and this contract never decides that. It is
the price of leaving the question unanswered, charged to the only party who
could have answered it. A requester who reads their deliverables and disputes
the bad ones never pays it; there is no honest behaviour it taxes.

The forfeit follows the same lender-first waterfall as a release: a proportional
split would let a third party's inaction strip a lender's irrevocable security.
It rounds down, so a bounty small enough that a tenth is zero forfeits nothing
rather than reverting — at cent scale, a settlement that cannot execute is worse
than a forfeit that does not apply.

**What it costs:** a worker submitting garbage now earns 10% whenever it finds
an inattentive requester. Bounded — one dispute closes it, each attempt burns a
delivery window and a job slot, and every requester who does respond records a
graded failure against that worker. A capped per-counterparty leak, traded
against a free option on every job in the market.

### 2d. Three terminal states, and why `Expired` had to exist

Found by a failing test, not by reading. The invariant test asserted "no timeout
can release money to a worker"; the forfeit broke it. The assertion was a proxy
and the proxy was the wrong part — but chasing it surfaced that `expireDispute`
was setting `Completed`, which would tell the credit engine a grader had passed
work when in fact the arbiter never showed up.

The reasoning that produced `Expired` for `expireReview` simply had not been
carried across. Same failure as §2b, one level down: **the fix gets applied to
the states you were thinking about.**

| state | means |
|---|---|
| `Completed` | someone decided the work was good |
| `Refunded` | someone decided it was not, or it never arrived |
| `Expired` | settled by a deadline; **no verdict exists** |

`Expired` is appended to the enum, never inserted — the numeric values are what
every off-chain reader decodes, and renumbering an existing state silently
reinterprets history. A scoring system that cannot tell "approved" from "nobody
showed up" is buying reputation with an absence.

### 3. Participation bond — capital at risk, not capital spent

The 2% posting fee is a **toll**: paid, gone, and it prices attack linearly. A
farm of N accomplices costs N fees and nothing more.

A bond is different in sign. Visa's actual Sybil defence is not cryptography —
it is that a member must be a bank with capital requirements and posted
settlement collateral. Membership is expensive to hold, not merely to buy.

Applied here: participation requires a bond, slashable on published conditions.
That makes identity *cost to maintain* rather than cost to create, which is the
only local answer to the ring topology that `docs/self-sybil-attack.md` leaves
open — a ring must keep N bonds funded simultaneously, forever, instead of
paying 2N fees once.

**The unsolved part, and it is the important part: who slashes.** If the
operator decides, the whole thing collapses back into discretionary reversal
power — the exact pattern this document is trying to remove, and the reason
chargebacks are on the "do not build" list. Slashing has to fire on conditions
that are verifiable on-chain: a resolved dispute, an expired deadline, a
reclaim. Anything requiring judgment cannot be a slashing trigger in v2.

Until that is answered, the bond is designed and not built. **Shipping a
slashable bond with an operator-controlled slash would be strictly worse than
the current fee**, because it would look like a trustless mechanism and be a
discretionary one.

### 4. Schema, not contract — store the contract address

`onchainJobId` becomes `(contractAddress, jobId)` everywhere. This is the change
that makes any *future* redeploy cheap, and not making it now guarantees this
same document gets written again.

### 5. The fee, moved on-chain — `feeBps` / `feeRecipient`

**The posting fee was enforced by custody, and nobody had written that down.**

`lib/platform-fee.ts` collects 2% as a separate USDC transfer that the platform
makes *out of the requester's smart account*, before the escrow. That works for
exactly as long as the platform drives that account — which is the custodial
property §"The two things that actually block it" names as blocker #1 and which
this whole v2 exists to remove. **An agent that posts with its own key pays
nothing.**

That is not a rounding error in the economics. `docs/self-sybil-attack.md`
prices manufacturing a track record at *fee × volume manufactured*; at a fee of
zero it prices nothing, and the ring analysis in that document becomes
unfalsifiable in the same way minting your own MockUSDC made it unfalsifiable.
The two documents were describing one hole from opposite sides.

So `postJob` now charges `feeBps` and forwards it to `feeRecipient`, both
immutable, capped at `MAX_FEE_BPS = 500`. Three decisions worth keeping:

- **The requester pays bounty + fee; the worker still gets the whole bounty.**
  Taking the fee out of the bounty would mean the number on the board is not
  the number that arrives, and a market where the posted price is not the paid
  price is a market nobody can plan against.
- **Charged on post, not refunded.** It is a toll on occupying the board, which
  is the act a wash-trading ring repeats — charging on release instead lets a
  spammer post and cancel for free. The cost is real: an honest requester whose
  job nobody takes pays for a job that never happened. A refundable toll is not
  a toll.
- **Rounds down.** 2% of one token unit is zero, and a market built for $0.01
  jobs must not reject them because the fee underflows.

`realMoneyBlockers` gained `fee-charged-twice` — both collectors configured
bills every requester twice, and the off-chain half never appears in the
contract's accounting, so the overcharge surfaces as a complaint rather than as
a number. It also gained `no-fee-anywhere`, because `feeBps` is immutable: a
deployment at zero can never start charging.

### 6. Solvency as one call — `totalEscrowed` / `escrowSolvency()`

"Publish the unflattering numbers" (failure-modes invariant 7) only works if
the number is cheap enough to actually get published. Proving this contract
holds what it owes previously meant summing every job ever posted, so nobody
would have.

`totalEscrowed` is maintained on every escrow and every payout, through a
single `_payOut` helper so a future settlement route cannot forget to
decrement. `escrowSolvency()` returns `(owed, held, surplus)` in one call.

- `held > owed` forever, by a little. Tokens sent here by mistake land in the
  surplus and stay. **There is deliberately no sweep**: a function that moves
  tokens the contract does not owe is a function that can move tokens it does,
  and "nobody has that button" is this contract's one real security property.
- **`held < owed` is the alarm.** No path here can produce it, so if it ever
  reads that way the token is not behaving like USDC — fee-on-transfer,
  rebasing, a blocklist — and nothing should settle until someone knows why.

Tested by driving all eight settlement routes and asserting the contract
returns to zero after each.

---

### 7. Settlement credits; `withdraw` pays — the blocklist brick

Every payout used to be a push inside the settling transaction:
`require(usdc.transfer(to, amount))`. **Base USDC is upgradeable by Circle and
enforces a blocklist**, so "this address cannot receive" is a real, permanent
state that nobody in the market chooses and nobody in the market can undo.

Measured, not reasoned about — `tests/labor-market-v2-hostile.evm.test.ts`
deploys a USDC double with Circle's blocklist and the whole design fell over:

| frozen party | what stopped working |
|---|---|
| worker | `approveJob`, `resolveDispute(true)`, `expireDispute` all revert → **escrow frozen** |
| requester | `cancelJob`, `reclaimJob`, `expireReview` revert — and the last one **took the worker's forfeit down with it** |
| payee (lender) | every settlement route reverts |
| **fee recipient** | **every `postJob` reverts — the market accepts no work at all** |

That is R1 — frozen escrow, no exit — reintroduced **through the token**, after
the state machine had been built specifically to make it impossible. Three
permissionless timeouts are worth nothing if the timeout itself cannot execute.
It is also the third time this session that a fix was applied to the states
being thought about while the same shape walked in through a door nobody was
watching.

So settlement now moves money into `withdrawable[account]` and `withdraw()`
pays. A frozen address blocks only itself: the job settles, everyone else is
paid, and that party's balance waits. `withdrawTo(address)` is the escape hatch
for the frozen party itself — USDC checks the *sender* and *recipient* of a
transfer, and the sender here is the contract, so naming an unfrozen address
works. Without it, crediting would only have moved the trap from the job to the
balance.

**What it costs, plainly.** Money no longer lands in a wallet as part of the
job finishing; every party takes one extra transaction to collect. Any UI that
said "paid" has to say "claimable". Against that: withdrawals *batch* — one
collection after fifty jobs is cheaper in total gas than fifty transfers — so
at volume this is cheaper, not dearer. And settlement gas becomes constant,
which matters because a permissionless timeout is paid for by a stranger.

`escrowSolvency()` now reports **both** liabilities: `totalEscrowed` (owed to
running jobs) plus `totalWithdrawable` (earned, not yet collected). Reporting
only the first would show a contract holding a large surplus that is entirely
spoken for, and a solvency number that flatters is worse than none.

### 8. The registry cannot take the market down with it

`registry` is immutable and `creditScore` was called bare inside `acceptJob`.
An immutable address called without a guard means that if the registry is ever
upgraded into something that reverts, **no job can be accepted again, ever.**

Now wrapped, with a 100k gas stipend, and an unreadable score resolves the two
cases in opposite and correct directions:

- `minScore == 0` — the gate was never going to reject anyone, so an unreadable
  score changes nothing and the market keeps working.
- `minScore > 0` — the requester asked for a guarantee that cannot be checked,
  so refuse, with a distinct `RegistryUnavailable`. Not `ScoreTooLow(0, n)`,
  which would blame the worker for the registry being down.

The gas stipend is a separate hazard from the revert: a registry that consumed
everything would leave the 1/64 remainder, too little to finish, so the `catch`
would not save the transaction.

Pinned either way: a dead registry stops the market **but never freezes
escrow** — `cancelJob` still refunds Open jobs, so requesters can always leave.
Stopping is survivable; stopping with the money inside is R1.

### 9. `postCost` — the contract's own instructions were wrong

`postJob`'s NatSpec said *"Requester must approve this contract for `bounty`"*.
It pulls `bounty + fee`. On a deployment with a non-zero fee that instruction
**fails on the first attempt and every attempt after it**, and the contract
cannot be upgraded to correct its own documentation.

Every existing test missed it because the harness grants one blanket
`approve(market, BOUNTY * 100n)` and never thinks about allowance again.
Over-provisioning in a fixture hides exactly the class of defect where the
contract asks for more than it said it would.

`postCost(bounty)` returns the figure, for the same reason `releaseSplit`
exists: a lender that reimplements the split is a lender that can get it wrong,
and a requester that reimplements the fee is a requester whose posting reverts.
The new tests approve the *exact* documented amount and nothing more.

---

## Is the contract *enough*? — the extensibility answer

### What it can already absorb without a redeploy

- **Any change to what a job IS.** `specHash` commits to arbitrary off-chain
  structure — delegation trees, capability requirements, acceptance tests,
  grader identity. The contract has never needed to know, and that is the
  extension point.
- **Any change to who may work.** `minScore` plus `ICreditRegistry` is a policy
  hook: a different scoring rule is a different registry, not a different
  market.
- **Lending against work in progress.** `assignPayee(jobId, payee, amount)`.
- **Cent-scale jobs.** `MIN_BOUNTY` is one token unit and both the fee and the
  forfeit round down rather than reverting.

### What it cannot, and the honest answer to that

Changing the arbiter, the fee, the windows, the token, or the registry all
require a new deployment. That is the price of having no owner, and it is the
right price — every one of those setters is a lever an operator could pull on
money already committed.

**So the upgrade path is: deploy v3, stop posting to v2, wait.** And that only
terminates because **every job dies of old age**:

```
MAX_OPEN_WINDOW      60 days   <- was missing, and it is the first term
MAX_DELIVERY_WINDOW  30 days
REVIEW_WINDOW         7 days
DISPUTE_WINDOW       14 days
                     ────────
worst case          111 days, after which no JOB holds escrow
```

**"After which v2 is empty" was the wrong claim, and the difference matters to
anyone actually writing the migration.** The 111 days is a bound on *escrow held
by jobs*, and it survived an adversarial check — a griefer front-running every
keeper lands at exactly 60+30+7+14 with `totalEscrowed` at zero. But settlement
credits; it does not pay. At day 111 the contract still holds every
`withdrawable` balance, nobody can move a balance on its owner's behalf, and
there is deliberately no sweep.

So a clean drain-and-redeploy is impossible, and not by oversight: the property
that keeps a frozen party's money safe from the operator is the same one that
leaves an absent party's money unreachable by anyone. v2 empties only as fast as
its creditors call `withdraw`, which may be never. Plan for "no job holds escrow
after day 111", not "the contract is done".

**This table said 51 days and was wrong**, in the way worth recording: it summed
the delivery/review/dispute chain and silently assumed every job gets accepted.
A job nobody takes never enters that chain at all, and `Open` had no deadline —
`cancelJob` is requester-only. A test "pinned" the 51-day bound and passed,
because it measured the path being thought about rather than the worst one.
Measured at ten simulated years, an unaccepted job with an absent requester
still held its escrow, with `reclaimJob`/`expireReview`/`expireDispute` all
answering `WrongStatus()` and `cancelJob` answering `NotRequester()`.

`expireOpen` closes it. The window is long on purpose — a job waiting for the
right worker is doing its job, and nobody has to wait for the deadline since
the requester may cancel at any moment. It is a backstop for a requester who is
gone, not a schedule.

Every one of those deadlines is permissionless, so draining v2 needs nobody's
cooperation — not the operator's, not the arbiter's. `tests/labor-market-v2.evm`
asserts both halves: that the windows compose to under 60 days, and that a job
parked in the worst state actually empties when a stranger finishes it.

**A future state without a permissionless deadline would break migration, not
just recovery.** That is the property to defend the next time someone adds a
state — and the way to defend it is not a sum. The sum is a proxy, and a proxy
computed from the states you remembered is exactly how `Open` was missed.
`tests/labor-market-v2.evm` now enumerates the four money-holding states
against the status enum and requires each to expose a readable deadline.

### What is deliberately NOT in the contract

| | why |
|---|---|
| Multi-token | `usdc` is immutable. A second token is a second deployment, which costs less than the branching would. |
| A second lien | Two claims on one uncertain cash flow need priority rules, and that is where secured lending gets genuinely hard. The `PayeeAssigned` event discloses the first claim so a second lender can price the residual off-chain. |
| Parent/child job links | A delegation tree is `specHash`'s business. Putting it on-chain buys a lender a view it can already reconstruct from events. |
| Arbiter rotation | A `setArbiter` is an owner wearing a narrow name. A *silent* arbiter is already survivable via `expireDispute`; a *malicious* one can only choose between two legitimate outcomes and cannot pay itself. Bounded, and the bound is the argument. |
| A pause switch | The reversal power the whole thesis is against. |
| A surplus sweep | See §6. |
| A push/pull hybrid | Trying `transfer` and falling back to a credit would put money in wallets in the common case, but makes settlement gas non-deterministic and adds a `try/catch` whose behaviour depends on how the token fails. One path, always, is worth more than a saved transaction. |

---

## Operational cost, which is not zero

Two Vercel projects, two Neon databases, two sets of secrets, two deploy
pipelines, two sets of background sweeps — for one operator. Today's defect hunt
found several bugs caused by concurrency *within a single deployment*
(`failure-modes.md` §13, §14). Doubling the deployments doubles the surface on
which "which instance did that" is a question.

Mitigations that should be decided before the fork, not after:

- v2 starts with **the sweeps that v1 needed and none of the features it did
  not** — no Minecraft plugin, no desktop miner lane, no governance. Port those
  back only if v2 becomes primary.
- Secrets are **separate values**, not copies. A shared `CRON_SECRET` across two
  deployments means rotating one rotates neither properly. (`CRON_SECRET` is
  already pending rotation — audit R4.)
- The two deployments must be **visibly distinguishable in the UI**. A screenshot
  that could be either one is a support burden and, in a funding conversation, a
  credibility burden.

---

## Sequence

Nothing here should start before the demo video is recorded: v1 is the thing
with a track record, and a half-migrated system on camera is worse than no
video.

**The demo video used to be step 1 and is now last.** The reason it was first —
that v1 is the thing with a track record, and a half-migrated system on camera
is worse than no video — is still true, and is answered by v1 continuing to run
rather than by filming quickly. Against that, a video shot after this work is a
*different* video: real USDC instead of mintable testnet tokens, and an ending
that is a challenge rather than a confession. There is no deadline forcing the
earlier date (the funds it is for take rolling applications), so the later cut
wins on merit.

**The condition that makes the reorder safe: v1 must not rot.** The whole reason
v1 keeps running is that the ledger is the asset, and a month of attention spent
entirely on v2 would let the thing being protected decay — settlement rate
drifting, jobs freezing, board emptying. So for the duration: **v1 gets zero new
features and stays alive.** Faucet running, sweeps running, breakage fixed. With
25 findings closed and the suite green it should hold, but "left alone" and "not
looked at" are different things.

1. Fork repo → new Vercel project + new Neon DB.
2. Schema: `(contractAddress, jobId)` everywhere. Cheap now, expensive later —
   and it is what lets one deployment address two chains at all.
3. Contracts: **`reclaimJob` first**, then `assignPayee`. Bond deferred pending
   the slashing question. `reclaimJob` is the gate: until it exists, recovery
   requires operator custody, and mainnet is off the table for that reason
   alone.
4. **Proof import from v1 by signature only, v1's DB treated as untrusted.**
   This is the thesis test; if it fails, stop and fix the thesis, not the code.
5. **Meter the paymaster before anything on mainnet can be triggered by a
   stranger.** Project and per-address caps at minimum; decide which operations
   are sponsored at all.
6. Deploy the contracts to **both** Sepolia and Base. Real traffic and the
   faucet on testnet; operator funds only, no faucet, on mainnet.
   **Measure one full job cycle on Base first** — four sponsored UserOps plus
   the grading call — and set the minimum bounty from
   `(gas + grading) / fee_rate` rather than from taste. Fund the mainnet wallet
   once, to the intended exposure ceiling, and treat topping it up as a decision
   rather than a reflex.
7. Run. Observe. Publish what broke, in the same form as `failure-modes.md`.
8. Open mainnet participation when the soak has run. External contract review
   before that, if it can be got — a recommendation now, not a gate.
9. **Open the challenge** (`docs/open-challenge.md`). Its three prerequisites
   are steps 3, 5 and 6, so this is where it lands and not earlier.
10. **Record the demo**, once the challenge has run long enough to say something
    on camera.

**Honest estimate.** Steps 1–6 are on the order of one to two focused weeks for
one person. Step 7 is calendar time rather than work, and step 10 waits on step
9 having produced a result worth showing — so the video is realistically **five
to seven weeks out, not four.** No deadline forces it (the funds take rolling
applications); this is written down so the date is chosen rather than
discovered.

**One cheap hedge, not a recommendation.** The shooting script
(`docs/demo-video-script.md`) already separates the screen pass from the
voice-over, so v1's on-chain cycle could be filmed now as raw footage and held
as insurance against v2 slipping. It costs an afternoon and is wasted if the
story changes — which, if this plan works, it will.

---

## What would make me abandon this plan

Written down now so it is not rationalised away later:

- **If step 5 fails** — if v1's signed proofs cannot be verified by v2 without
  trusting v1's database — then the portability/verifiability claim is false,
  and the right response is to fix the attestation design, not to import the
  rows directly and call it done.
- **If v2's board is as empty as v1's.** v1's demand is a house faucet I fund
  myself (`product-thesis.md` §demand). A second empty market is not progress;
  it is the same market with more infrastructure, and the honest conclusion
  would be that the contract work was never the bottleneck.
- **If the mainnet side stays operator-funded indefinitely.** The point of real
  USDC is that the fee and bond economics become falsifiable. Money that only
  ever moves between my own accounts does not falsify anything, so a mainnet
  deployment with no third party in it after a reasonable period is a more
  expensive Sepolia and should be said to be one.
