# The failure code table

`lib/failure-codes.ts`. From the Handsel Office autonomous-evaluator design
study, whose central rule is one sentence:

> **"It failed" and "it scored low" must never be the same state.**

Handsel was one flag away from that mistake. `testResult` carries
`passed: boolean | null` plus `refusedBrief` and `workerIncapable` — a partial
version of the right idea, and those two flags exist precisely because a
refused brief and a failed grade are recorded against different parties. But
everything else that can go wrong still landed in the same `passed: false`,
including things that are not about the worker at all: a grader timing out, an
ambiguous rubric, two evaluators disagreeing, a poisoned input, a replayed
settlement.

When those collapse into a low score, **a system fault becomes the worker's
penalty** — it loses the bounty and takes a credit hit for an outage.

## Two axes

A verdict is a pair, and the pair is the point.

| Task outcome | Evaluation execution | Means |
|---|---|---|
| `FAIL` | `SUCCESS` | The work was judged and found wanting. The worker's problem. |
| `UNKNOWN` | `FAILURE` | Nothing was judged. **Not** the worker's problem, and paying or penalising on it is the defect. |
| `REFUSED_BRIEF` | `SUCCESS` | On record against the requester. |
| `CANNOT_DO` | `SUCCESS` | Returns to the market; no verdict about anyone. |

`attributableToWorker()` is the question the two axes exist to answer, and a
single `FAILED` state cannot express it. `AgentContract.verification` now
carries both, plus the derived attribution.

Handsel records execution only implicitly — a null verdict cannot distinguish
"the grader never ran" from "the grader ran and could not decide" — so the
contract reports `PARTIAL` rather than claiming a `SUCCESS` it cannot
evidence.

## Families

Sixteen, stable: `AUTH` `SEC` `DAT` `RAT` `PRV` `DET` `VER` `RPL` `IDN` `ORC`
`ECO` `LEG` `SPC` `MOD` `TIM` `DEP`. A code may be added to a family without
renegotiating what the family means.

Only the labels read verbatim from the study are carried in `CODES` — the
study defines five per family and inventing the rest would be exactly the
false confidence the design refuses. A family with no code yet is still
usable: an uncodified code in a known family resolves to the family's default
severity.

## Severity, and why it is contextual

| | Meaning | Consequence |
|---|---|---|
| S0 | informational | record only |
| S1 | transient, recoverable | bounded retry |
| S2 | degraded or uncertain | **PROVISIONAL — no economic action** |
| S3 | material risk to the judgment | HOLD evaluation and settlement, human review |
| S4 | security, privacy, funds, legal | freeze scope, block credentials, escalate |

The same code is not the same incident. `TIM-002 EXEC_TIMEOUT` is S1 for a
test that ran long, and S3 when the response lost was a payment
transaction's — because then *whether money moved is unknown*, which is a
different fact about the world.

`severityFor()` **only escalates.** The table value is a floor; anything that
would lower it is an argument for a person to make, not a default to apply.

## Codes that name nothing

`ERROR` `INVALID` `FAILED` `UNKNOWN` `BAD_RESULT` `GRADING_FAILED` are
refused by `validateCode()`.

The study's example is the 2026 `.de` DNSSEC incident: the real cause was an
invalid DNSSEC signature, and the resolver reported a generic "no reachable
authority", which hid it. A diagnosis that cannot be acted on is worse than no
diagnosis, because it looks like one.

Where the cause is genuinely undetermined, say so:

```json
{ "primaryCode": "DEP-001", "causeStatus": "UNCONFIRMED",
  "suspectedCauses": ["DEP-005", "TIM-001"] }
```

A wrong confident code is worse than an honest uncertain one.

## Judgment state

Separate from the failure code: a code says what went wrong, the state says
what may now happen.

```
RECEIVED → VALIDATING → EVALUATING → VERIFYING
    → FINAL | PROVISIONAL | HELD | INVALIDATED | ESCALATED
        → REVIEWED → FINAL | REVERSED | REMEDIATION_REQUIRED
```

`maySettle()` refuses anything S2 or above, any incomplete execution, and any
outcome that judged nothing. Uncertain is not a verdict to pay on.

## The constitutional rule

> Evaluator shall judge, not execute. Scorekeeper shall record, not rewrite.
> Executor shall act only on a separately authorized, one-time decision.

Two of the three are already in the instrument table
(`docs/trade-instruments.md`): `inspection` binds **neither** party — the
evaluator judges and escrow moves on a deadline or an approval, never on the
finding itself — and `authorisation` is the separately-authorised, one-time
decision the executor acts on. The third, "scorekeeper records, not rewrites",
is what the credit engine has to keep true; `appealed` is surfaced on the
contract because a rewritten verdict is otherwise indistinguishable from one
nobody questioned.
