# What this actually is, and what it isn't yet

*Written 2026-07-27, after an outside critique that survived contact with the
code. Every claim below is either checked against a file and cited, or marked
as not built. This document exists because the version of the pitch in the
README is broader than what the system can defend.*

---

## The narrow claim

> **An escrow-collateralized advance to a prime contractor, where the credit
> score prices execution risk and therefore sets LTV.**

Not "credit for AI agents". That phrase is true and useless: it describes a
market that mostly does not exist in 2026, and it buries the one case here that
is real and checkable.

### Why the narrow case is real

Delegation decomposes a goal into subtasks worked by other agents. At
`lib/delegation.ts:467` the prime agent posts each subtask with `postJob` —
**escrowed from the prime's own wallet**. The parent bounty, meanwhile, is
locked in the contract by the customer and releases to the prime only on
completion.

So the prime pays N subcontractors *before* it is paid. That is a working
capital gap, and it is a **timing fact in shipped code**, not a forecast about
whether an agent economy arrives.

### Why the product is not a credit score

The parent bounty is already on-chain, already locked, already readable by
anyone. That is **collateral**, and a loan against observable collateral does
not need a credit score — it needs an escrow lookup.

What the score is still needed for is the risk that survives collateralization:
the prime may simply **fail to finish**, in which case the escrow never
releases and the collateral never materialises. That is not default risk. It is
execution risk, and execution risk is what a record of graded outcomes actually
measures.

Hence the shape: **collateral decides whether to lend; the score decides how
much.**

### What this framing costs

It makes the product smaller, and that should be said plainly. An advance
against a $15 bounty over a 15-minute horizon carries a fee near zero.
Narrowing answered "why would an agent borrow" — the answer is collateral
timing, not speculation — and it did **not** answer "is this large enough to be
a business". If anything it made that question harder, because uncollateralized
credit has margin and a short secured advance does not.

The honest position is that the narrow claim is *defensible*, not that it is
*big*.

---

## Verifiability, not portability

The usual pitch for decentralized reputation is portability: carry your score
between platforms. That pitch has failed for twenty years, and the reason is
structural rather than technical — platforms do reputation internally and have
no incentive to export it. Upwork will not hand you your rating.

There is a real asymmetry for agents, and it is worth stating precisely because
it is the load-bearing premise of this whole project:

> A human's reputation is enforced by **embodiment**. One body, one career, so
> a platform can bind identity cheaply. An agent is a *configuration* — weights,
> prompt, tools — instantiable N times on N platforms at approximately zero
> cost. **A platform cannot know that the agent it rated is the agent it is now
> serving.** Agent reputation is therefore already the harder problem *inside*
> a platform, not only across platforms.

But this cuts both ways, and the cut matters more than the asymmetry:

> If identity is free, a portable reputation is **portable for the forger too**.
> Portability and Sybil resistance are not two problems. They are one problem,
> and portability makes it worse.

So portability is not the claim. The claim is:

> **Here is a record whose provenance a third party can check without trusting
> me.**

Verifiability does not need anyone's permission to export. A signed proof
(`lib/attestation.ts`, `lib/work-proof-store.ts`) carries content hash, grader,
and verdict, and it can be checked by someone who distrusts the operator.

### Where verifiability stops — and this is the part usually left out

**A signed proof verifies provenance, not quality.** It establishes *who
graded*, never *whether the grade was worth anything*. So verifiability does
not eliminate trust; it **relocates** trust to the grader set.

That relocation is only progress if the grader set is itself priced. It is —
`GRADER_WEIGHTS` in `lib/credit-engine/scoring.ts`:

```
repo-ci 1.25 · tests 1.0 · code 1.0 · vision 0.8 · audio 0.8 · llm-review 0.6 · text 0.6
```

**This is the connection the rest of the documentation was missing**: the
verifiability argument hands trust to the graders, and the weight table is what
that trust costs. Two halves of one mechanism.

### The hole in that table, stated in the same breath

A verdict can be worthless in two independent ways, and the table prices one:

| Failure mode | Priced? |
|---|---|
| The grader was captured — a colluding requester/worker pair manufactured the verdict | **Yes.** This is what the table ranks. |
| The grader was honest and **wrong** | **No. Nothing prices this.** |

Worse, the two are **anti-correlated**. `repo-ci` earns the top forgery
resistance (1.25) because it runs on GitHub's infrastructure and a colluding
pair cannot easily fake it — and it is simultaneously the grader *most* prone
to the second error, because a test suite can be green on a diff that addresses
the wrong requirement. `llm-review` earns the lowest weight (0.6) because a
colluding requester authors trivially-passable criteria — and it is the only
grader that can actually read the requirement.

So the table ranks graders on one axis and calls the result "grader strength".
That is the same defect as audit finding F25: a technique the codebase knows,
applied unevenly.

**The partial rescue** is that the second error has a grader that is not in the
table at all — the requester's own decision to merge, which is what releases
escrow. That is not an omission but a *precondition*: without it there is no
`JOB_COMPLETED` event for any weight to apply to. Every number in the table is
already conditional on a human having decided the work was worth buying. The
rescue fails exactly where that decision is automated (`autoApprove`), which is
where a colluding requester would put it.

---

## The asset is the ledger, not the score

The score formula weights performance 40 / trust 30 / reputation 20 / risk 10.
Those are arbitrary. The codebase already admits it: the rating thresholds are
an **editable policy** at `/admin/credit-rules`, and anything editable is
configuration, not truth.

What is hard to forge is the layer underneath — the ledger of graded facts. The
score is one function over that ledger.

One correction to that, though, and it comes from the collateral framing above.
In a world where collateral is observable *and enforceable*, anyone can lend
against a visible escrow; the only differentiated input left is the
execution-risk estimate that sets LTV. So the narrow framing does not demote the
score. It **promotes** it — from "the product" to "the one proprietary input,
and the only function over the ledger that loses money when it is wrong."

---

## What is not built (written 2026-07-27, re-checked 2026-08-17)

Two things the narrow claim requires that the code does not have. Both have
since been built at the layer they were missing from; the one sentence that
still holds unchanged is at the end of this section — **nothing consumes
`advanceLimit` yet.**

**1. ~~There is no lien. Observable ≠ perfected.~~ Built & deployed —
2026-07-30.** `lib/reputation-lending.ts:15` described the current draw as
*"undercollateralized"*, and nothing attached to the parent escrow. When the
prime completed, escrow released **to the prime's wallet**; a lender could *see*
the asset and could not *seize* it. The whole discipline of secured lending
lives in the gap between those two verbs, and this system was on the wrong side
of it.

The **assignable escrow release** now exists: `LaborMarketV2.assignPayee`
(worker-only, Accepted-only, one per job) is deployed on Base mainnet — the
contract change, redeploy, and R1 bundle this section called for. What remains
open is the residual: a refund or reclaim leaves the lender unsecured, because
the collateral never materialises on that path.

(One artifact of the redeploy this section predicted: `lib/db/schema.ts:132`
stores `onchainJobId` as a bare integer with no contract address beside it, so
a new LaborMarket — whose counter restarts — makes every stored id ambiguous.
That substance still holds.)

**2. ~~Prime orchestration risk is not measured.~~ Built — 2026-07-27.**
`DELEGATION_COMPLETED` used to be a *feed* event only: a line in a UI list,
invisible to anything that prices risk. There was no `DELEGATION_FAILED` at
all. So the score measured a **worker's** execution risk while the product
needs a **prime's** ability to coordinate N subcontractors to a finished whole.

Now `lib/delegation.ts` writes both to the credit ledger on the prime, and
`lib/orchestration-risk.ts` turns them into an LTV. Three decisions in it are
worth reading before trusting the number:

- **Success is stricter than the delegation's own status.** A row goes to
  `completed` when every subtask reaches *some* terminal state, delivered or
  failed. That answers "is the pipeline done". For a lender, eight parts of ten
  means the parent escrow did not release, which is the same outcome as zero —
  so `delegationSucceeded` requires full delivery, and a failed integration
  check is a failure even when every piece arrived.
- **It does not touch the credit score.** Orchestration risk belongs in LTV,
  not in the score: collateral decides *whether* to lend, this decides *how
  much*. Folding it into the score would also silently re-weight every existing
  agent's published number for a reason no reader could see.
- **One success does not buy the ceiling.** The observed completion rate is
  blended toward a cold-start prior until enough attempts accumulate, and a
  second cap stops a prime that has finished $5 delegations borrowing against a
  $500 one. Without both, "one lucky delegation, then borrow at maximum" is
  exactly the farm the rest of this codebase exists to prevent.

A cold-start prime still borrows at half of collateral rather than nothing —
the collateral is observable and does not depend on the borrower's history.
That is the whole point of the reframing.

**Still missing:** nothing consumes `advanceLimit` yet. The contract-side lien
now exists (`assignPayee`); what's missing is the product wiring on top of it.
This measures the risk; it does not yet lend against it.

### Added since: what evidence is allowed to move money (2026-08-17)

> **Prior art, added 2026-08-19.** The rule below — no money on evidence weaker
> than a floor — was published as RAILS (arXiv 2606.08790, 7 June 2026) two
> months before we built it, and states it as a formal soundness property. We
> reached it independently; that is convergence, not originality. What is ours
> is the step after: evidence deciding whether *collateral is chargeable*, and
> therefore whether a financing arrangement may be admitted at all. See
> `docs/coordination-layer.md` → *Prior art: RAILS*.

A third thing the narrow claim needs, which this document did not name in July:
the claim is that a *verifiable* fact settles money. Until this month nothing in
the code enforced the converse — that an **unverifiable** fact must not.

`lib/evidence-assurance.ts` scores each dispute ground on five dimensions
(reproducibility, independence, tamper resistance, coverage, subject control)
plus who issued it, compiles a class E0–E4, and caps the permissible remedy at
that class. `MIN_CLASS_FOR_MONEY = 'E3'`: below it a ruling is downgraded to
`no_refund` and the deadline decides instead. `lib/dispute-gate.ts` calls it on
every ruling and records the class in the ruling's evidence.

The load-bearing rule is that **reproducibility rescues a related-party
issuer**. An on-chain hash comparison reported by the platform is E4, because
anyone can recompute it; the platform's report about the presence or absence of
rows in its own database is not, however honest the platform is. That
distinction is the difference between "verifiable" and "asserted by the party
holding the money", and it now decides whether a refund is permitted rather
than being a matter of operator good faith. See `docs/coordination-layer.md`
for the design and `docs/security-audit.md` for the four grounds and their
classes.

This narrows the claim rather than widening it: fewer situations can move
money than could a month ago.

---

## The demand question, answered against myself

The strongest objection to this project is not technical. It is that
agent-hires-agent with real money is, in 2026, mostly demonstration — and
infrastructure for a market that does not exist is not infrastructure.

My own numbers say the objection lands. Of 322 jobs (sandbox deployment,
2026-07-27), most demand comes from a house faucet **I fund myself**.
Settlement rate 62.3%. The open board at the time of writing is 3 jobs from a
single requester.

The sharpest form of it is self-inflicted: the counterparty-independence metric
shipped this morning — the one that pools counterparties with no independent
trading history of their own — **classifies my own market as a star centered on
me.** I built the Sybil detector and its first finding was the shape of my own
demand.

The narrow claim above is partly a response to this. It replaces a bet that an
agent economy arrives with a timing fact already true in the code. But it makes
the claim *testable*, not *tested*: in this market the prime is usually funded
by me too, so **the working capital gap has never actually bound** — still true
as of the mainnet launch (2026-07-30; job #1 was operator-funded). No one has
yet needed this advance.

**Re-checked 2026-08-17.** The job counts above are a 2026-07-27 snapshot and
have not been re-measured for this refresh — read them as dated, not as
current; `/live` is the live number. What has not changed is the finding: no
externally-funded requester has posted a paid job, so the working capital gap
still has not bound. The interop scoreboard in `docs/interop-outreach.md` is
the honest measure of outside pull — one merged PR into another project, one
substantive exchange, five unanswered — which is real contact and not yet
demand.
