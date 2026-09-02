# Finding the payer

Written 2026-09-02, against the principle *don't build the product, find the
person who signs the cheque.* This document exists because that principle
indicts most of the last month of work, and the indictment is correct.

Everything here is downstream of one fact the repo already admits about
itself.

## 1. The fact

`docs/product-thesis.md` §"The demand question, answered against myself":

> Of 322 jobs, most demand comes from a house faucet **I fund myself**.
> Settlement rate 62.3%. The open board at the time of writing is 3 jobs from
> a single requester. […] **no externally-funded requester has posted a paid
> job**, so the working capital gap still has not bound.

And the sharpest version, self-inflicted: the counterparty-independence metric
built to catch Sybil rings **classified this market as a star centred on its
own operator.**

`docs/interop-outreach.md` is the honest measure of outside pull: one merged
PR into another project, one substantive exchange, five unanswered. Real
contact. Not demand.

## 2. The arithmetic nobody ran

The question is not "will the current model work". It is "what does the
current model earn **if it works perfectly**". Every input below is a constant
in this repo, not an estimate.

| Surface | Price | Margin/unit | Daily cap | Margin at saturation |
|---|---|---|---|---|
| Storefront commission | $6–12 (`lib/storefront-pricing.ts`) | $2–4 | 5 (`MAX_COMMISSIONS_PER_DAY`) | **~$600/mo** |
| External job posting | $3 (recommended) | $1 | 40 (`EXTERNAL_POST_GLOBAL_PER_DAY`) | **~$1,200/mo** |
| Credit report | $0.01 (`middleware.ts`) | ~$0.01 | — | immaterial |

**Under $2,000/month at absolute saturation** — where saturation means forty
strangers open a wallet every single day, which would itself be a triumph.

That is the finding. **The price is not a knob to tune once demand arrives; it
is the model.** A per-job fee denominated in dollars-per-job cannot pay for
this system's own maintenance, let alone a person. For the unit to be 10–100×,
the buyer has to be a company, not an agent.

## 3. The rail is selecting against the buyer

Who most needs *verified* work — escrowed, independently graded, paid only on
pass?

- somebody spending an employer's money,
- somebody who cannot evaluate the deliverable themselves,
- an organisation with procurement or audit requirements.

None of them can pay in USDC on Base over x402.

Who *can* pay that way? Crypto-native developers — who already run their own
Claude Code and do not need a third party to tell them the output was
acceptable.

**The payment rail filters for exactly the buyers who do not need the
product.** This is a structural explanation for zero demand that does not
require anyone to have made a mistake, and it will not be fixed by better
marketing.

## 4. Three candidate payers

### (A) The supply side pays to be certified — the one nobody is chasing

`docs/positioning.md` §3 already names the asset:

> the only place where "is this agent any good" has receipts, because it got
> paid or it did not.

SWE-bench is static and contaminated. Vendor evals are self-graded. Arena
voting measures preference. MCP registries rank by stars. Handsel emits, for
every finished job and without anyone opting in: an independent grading
verdict, a signed proof of the exact bytes, an on-chain settlement that either
happened or did not, and a credit movement that cost the worker its bond when
it failed.

**The wedge is identified and its buyer was never followed.** The party that
needs that evidence is not the one buying labour — it is the one **selling the
agent**: harness vendors, MCP tool authors, agent startups. Third-party proof
that your thing completes paid work is a credibility purchase, and credibility
comes out of a marketing budget, which is denominated in thousands, not in
six-dollar commissions.

What is for sale: a certification report, a ranked listing, a periodic
benchmark. All of it derivable from data the system already produces.

**The generator exists**: `lib/certification-report.ts`, produced by
`DATABASE_URL=… node scripts/certification-report.mjs <agentId>` (Node 22.18+). A script
rather than a written document on purpose — a hand-written sample would be a
number somebody typed, and the entire pitch is that these are settled outcomes
nobody chose. Its shape:

```
## Independence
- Distinct paying counterparties: **3**
- Largest single counterparty: **33%** of jobs

| Grader class | Jobs | Passed | Pass rate |
|---|---:|---:|---:|
| reproducible | 1 | 1 | 100% |
| mechanical | — | — | — |
| model | 2 | 1 | 50% |

## What this does not establish
- Only 3 graded jobs. Too few for any rate here to be stable.
- Each rate covers one grader class. They are not averaged, because a
  re-runnable check and a model's opinion are not the same evidence.
```

Independence is printed before any rate, because a pass rate read before the
concentration behind it has already done its damage. **No sample is committed
to this repo**: this container's database is empty, and generating a
plausible-looking one would be the first fake number in a document whose only
product is that it has none.

### (B) Repo jobs — nobody pays unless it merges

`docs/positioning.md` calls this the flagship and it is right. The requester's
**own CI** grades and their **own merge** pays. Handsel is not the referee, so
the first objection anyone raises — that it marks its own homework — cannot
be raised at all.

To a buyer with a backlog this is an unusually clean offer: **if it does not
merge, you pay nothing.** That is a materially different proposition from
per-seat coding agents, and it is already built.

The blocker is §3, not the product: settlement has to reach a company through
a rail a company can use.

### (C) Financing — downstream, not now

The escrow-collateralized advance shipped this session. The thesis is honest
that the claim is *testable, not tested*: in this market the prime is usually
funded by the operator too, so the working capital gap has never bound. It
becomes a product after (A) or (B) produce primes who are not the operator.

## 5. What to do this week, with no new product

Ranked by how cheaply each finds or kills a payer.

1. **Ten certification offers.** Generate one report from existing data,
   send it free to ten harness/tool vendors, and ask two questions: may we
   publish it, and what would a standing listing be worth to you. Builds
   nothing.
2. **Three repo-job pilots, free.** Find maintainers or teams with a backlog:
   "three issues, you pay only what merges." The merge rate *is* the sales
   material, and a zero merge rate is the most valuable thing this project
   could learn.
3. **Quote at $500, not $6.** Price the company-shaped unit — a pilot, a
   certification, a monthly listing — and collect the refusals. A $6
   experiment teaches nothing even when it succeeds.

If all three return "nobody buys", that is worth more than the current state,
which is not knowing.

## 6. What to stop

Supply-side mechanism. In one day this repo gained review termination, a
verdict stake, an approval-support check, a grading retry loop, an
escrow-collateralized advance and a platform ledger — every one of them a
refinement to the rules of a market with no customers.

The work is sound and the priority was wrong. There are 65 documented failure
modes, ~3,800 tests, a deployed mainnet contract, and zero external customers.
**The next thing to fix is not in the code.**
