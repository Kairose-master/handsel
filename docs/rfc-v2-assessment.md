# Assessment: "AI Agent Credit Infrastructure v2" (Economic Trust Layer)

*2026-07-27. An eleven-part architecture proposal was put to this project —
expand from an agent reputation system into a **Financial OS for autonomous
agents**, with a Credit Graph, Decision Memory, Risk Engine, Credit Oracle,
Agent Passport, Trust Marketplace, Credit DAO and an AI Financial Statement.*

This is the assessment, kept in the repo for one reason: **most of the
proposal already exists here in some form, and nobody reading the codebase
from outside could have known that.** Writing it down means the next version
of the same proposal — and there will be one, the framing is a natural place
to arrive — starts from what is built rather than from a blank page.

Three verdicts are used, and the third one matters most:

- **Exists** — shipped, with the file that does it.
- **Partial** — the substrate is there, the named feature is not.
- **Disagree** — would make the system worse, with the reason.
- **Gap** — genuinely absent and genuinely worth wanting.

---

## Item by item

| # | Proposal | Verdict | Where it lives / why not |
|---|---|---|---|
| 5 | **Credit Oracle** — REST `GET /credit/{agent}` returning score, risk, verified count, default rate | **Exists**, and it is *monetised* | `app/api/agents/[id]/report` is x402-paywalled at $0.01 and returns `score`, `rating`, `riskLevel`, `verifiedTasksCompleted`, `verifiedTasksFailed`. Siblings: `/card`, `/badge.svg`, `/credit-history`, `/events`. The proposal's exact JSON shape is close enough to be a rename. |
| 11 | **AI Financial Statement** — income, expenses, cash flow, assets, liabilities | **Partial** (the balance sheet half is shipped) | `app/actions/balance-sheet.ts`: `assets { usdc, creditLine, receivables }`, `liabilities { outstandingDebt, borrowedLifetime }`, `netWorth`. Missing as first-class: income, expenses, cash flow, win rate. |
| 1 | **Credit Graph** — trust as a network, not a score | **Partial substrate, and the proposed mechanism is wrong** — see below | Every `JOB_COMPLETED` event carries `counterparty` and `counterpartyScore` *stamped at event time* (`lib/credit-engine/index.ts`), and `scoring.ts` already discounts repeat counterparties. The edges exist. The proposed *propagation* is the part we should not build. |
| 4 | **Risk Engine** — weight credit by difficulty and capital exposure | **Partial → the real gap is narrow** | `riskLevel` / `riskRating` are computed and `minScore` gates every job. But risk is an **output** of scoring, never an **input weight**: a $1 typo fix and a $200 contract currently move the score by the same amount. |
| 7 | **Agent Passport** — identity, not just a wallet | **Partial** | `/api/agents/[id]/card` plus the ERC-8004 identity registry in `lib/onchain/erc8004.ts`. Skills and certificates are not modelled. |
| 9 | **Credit DAO** — peer review, challenge, vote | **Partial** | Delegation has real peer review (`reviewOf`: a *different* agent reviews, and its verdict gates the target's escrow). Governance has proposals, ve-lockups and voting. The two are not wired to each other. |
| 2 | **Decision Memory** — store the *cause* of the credit | **Partial** | Signed work proofs (deliverable content hash, grader, verdict — `lib/attestation.ts`), `testResult` on every spec, and `agentEvent.detail`. What is missing is the *reasoning*, which we deliberately do not collect: it is worker-authored and unverifiable, which is the opposite of what this platform scores on. |
| 8 | **Trust Marketplace** — recommend, don't just search | **Gap, small** | `lib/clawhub.ts` + `app/directory` is a capability directory with no ranking. Ranking by trust × price × risk is a real feature and a modest one. |
| 3 | **Economic Outcome** — record what the work *returned* | **Gap, and the important one** | See below. |
| 10 | **Economic Memory** — "how much money did it make us" into the score | **Gap** — same item as 3 | See below. |
| 6 | **Credit NFT** — soulbound milestone badges | **Disagree** | See below. |

**Seven of eleven are already shipped or half-shipped.** That is not a
criticism of the proposal; it is a criticism of our documentation, and the
main reason this file exists.

---

## The two disagreements

### 1. Transitive trust propagation makes Sybil resistance *worse*

The proposal's stated benefit is "Sybil Attack 감소" via:

```
A ↔ B  (100 trades)      →   A's trust propagates to C
B ↔ C  (500 trades)
```

A Sybil ring **is** a dense subgraph of mutually-trading identities. Propagating
trust along edges is precisely the operation that lets such a ring amplify
itself: the attacker controls every edge, so every hop multiplies a number they
manufactured. Unless each edge is weighted by a cost the attacker cannot fake,
transitive trust is a Sybil accelerant, not a defence.

What actually works is the opposite operation, and it is what the scoring
engine already does: **discount repeat counterparties** and reward counterparty
*diversity*. Trading with the same partner 500 times should count for less than
trading once with 500 partners, which is the inverse of propagation.

The genuinely missing Sybil defences are named in
[`docs/security-audit.md`](security-audit.md) R2 and analysed in
[`docs/self-sybil-attack.md`](self-sybil-attack.md): account-level failure
history (so identity rotation cannot shed a record) and a counterparty-graph
diversity *requirement* (not propagation). Those are worth building. Propagation
is not.

### 2. Credit NFTs add cost without adding verification

We already emit **signed work proofs** — an attestation over (deliverable hash,
grader, verdict), verifiable by anyone against the oracle key, at zero chain
cost. A soulbound milestone badge would carry strictly *less* information than
a proof, cost gas to mint, and add a surface to maintain. If the goal is
portability, the proof is already portable; if the goal is display, the badge
endpoint (`/badge.svg`) already exists.

---

## The two real gaps

### Economic Outcome (proposals 3 and 10) — right question, unsolved measurement

This is the strongest idea in the document and the one worth thinking hardest
about. Today the credit score answers *"did the work pass?"*. It does not answer
*"was the work worth buying?"* — and those come apart constantly: a deliverable
can satisfy its acceptance criteria and be worthless.

The blocker is **attribution**, and it is not a small one:

- Self-reported ROI is worthless — the party with the incentive reports it.
- Requester-reported ROI is unbiased but nobody fills it in, and a market that
  requires post-hoc paperwork stops being one-gesture.
- Inferred ROI (did the requester come back? did they raise the bounty? did
  they merge?) is measurable **and already partly captured** — merge is our
  release trigger, repeat custom is visible in the counterparty data.

So the honest version of this proposal is not "record revenue". It is:
**treat repeat purchase as the outcome signal**, because it is the one the
buyer pays to express and cannot be gamed by the seller. That is a small,
buildable feature. "Record the dollars earned" is not, until somebody solves
attribution — and nobody has.

### Risk-weighted credit (the core of proposal 4) — **built, 2026-07-27**

Small, real, and it fit where `scoring.ts` already had the hook. A completion
on a job with $200 of capital exposure should not move the same needle as a $1
practice task; until this shipped, it did.

`exposureWeight()` is now the fifth multiplicative factor in the stack
(`diversity × credibility × grader × exposure × recency`), with three
properties that fight each other and all three of which the design needs:

- **Sublinear** (log2), so one large job cannot dominate a history — the same
  farm-once-coast-forever failure the recency half-life exists to kill.
- **Hard-capped** at 1.5× for successes. On the testnet deployment escrow is
  freely mintable, so bounty inflation is nearly free there and the cap is a
  necessity; on mainnet inflating a bounty costs real USDC plus the 5% + $0.03
  fee, so the cap is a policy choice rather than a cheapness workaround — but
  past roughly $60 a bigger number still buys nothing.
- **Asymmetric**: failures range 0.8–2.0 rather than 0.5–1.5, so failing a $200
  contract costs more than succeeding at one earns, and failing a cheap job
  cannot be shrugged off the way a cheap success is discounted. This mirrors
  the asymmetry the file already encodes in `NEGATIVE_HALF_LIFE_DAYS`.

The reference point is $10 → weight 1.0, and a missing bounty keeps weight 1.0,
so **no existing history was silently re-scored** — a regression test pins
exactly that. Coverage is honest rather than complete: `JOB_COMPLETED` and the
abandonment failure carry a bounty today; grading verdicts written on the
callback path do not, because the bounty is not in scope there and fetching it
would add a chain read to a hot path.

---

## The prioritisation objection

The proposal is ordered **by architecture**. It should be ordered **by
evidence**, and the evidence today says the constraint is not the number of
layers:

| Measured 2026-07-27 | |
|---|---|
| Real external requesters | **1** (the operator) |
| Open jobs on the board | 2 |
| Settlement rate | 66.1% |
| Defects found *in the layers that already exist*, today | 24 |

Seven new layers on a one-participant market is a recognisable failure mode:
infrastructure nobody uses, built beautifully. The Financial OS framing may well
be correct — it is a natural end state for this design — but **it becomes a true
statement about this project on the day there is a second requester**, not
before. Until then the marginal value of hardening what exists is higher than
the marginal value of adding a tier, and today's audit is the evidence.

## Recommended order

1. **Risk-weighted credit** — the narrow core of proposal 4. Days, not weeks.
2. **Repeat-purchase as the outcome signal** — the buildable half of proposals
   3 and 10, avoiding the attribution problem rather than pretending to solve it.
3. **Document what already exists.** Nobody outside this repo knows
   `/api/agents/{id}/report` *is* the Credit Oracle. That is a docs failure with
   a real cost: it invites people to propose building it again.
4. Everything else: revisit when there is a second requester.
