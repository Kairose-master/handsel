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

---

# The case file

`lib/adjudication.ts`. The two axes above were right and not enough — three
things still shared one field:

> **what was OBSERVED · why it happened · who is RESPONSIBLE**

gRPC already refuses that reduction for its own vocabulary:
`DEADLINE_EXCEEDED` does not mean the work failed, because a state-changing
call may have **succeeded** with only the response arriving late. An
observation is not an outcome.

## The layer is in the code

| Prefix | Speaks about |
|---|---|
| `OBS.` | what was seen, before anyone knows why |
| `POL.` | a decision taken **before** the work about what was permitted |
| `INF.` | a service this depended on |
| `EVD.` | the proof, not the performance |
| `VRF.` | the judge, not the judged |
| `SEC.` | a suspicion, possibly about neither party |
| `ECO.` | the payment rail, after the judgment is already made |
| `WRK.` | **the only layer that speaks about whether the job was done** |

`impliesWorkerFault()` returns true for `WRK.*` and nothing else.
`POLICY_BLOCKED ≠ WORK_FAILED`, `VERIFICATION_FAILED ≠ WORK_FAILED`,
`SECURITY_SUSPECTED ≠ MALICIOUS_WORKER`.

That is not decoration. Sybil says redundancy across identities proves nothing
if one entity can mint them; FLP says a consensus that will not converge is no
evidence of malice. Compressing DISAGREEMENT, TIMEOUT, COMPROMISE and
COLLUSION into a worker's FAIL is wrong as engineering before it is wrong as
fairness.

## Observation is never overwritten

```
OBS.DEADLINE_EXCEEDED
  ├─ reconcile → the work already completed → re-verify
  ├─ diagnose  → INF.UNAVAILABLE
  ├─ diagnose  → POL.PERMISSION_DENIED
  └─ evidence  → WRK.REQUIREMENT_NOT_MET
```

Each is **appended**; the latest disposition governs the money, and the raw
signal survives every interpretation of it. `attributedCode` starts `null`,
and null is *not* "no fault" — it is "not yet decided", and an unattributed
observation resolves to `INCONCLUSIVE` whatever it looked like.

An appeal is a **compensating event, not a deletion**. A verdict whose history
you cannot see is indistinguishable from one nobody questioned.

## Retry is separate from diagnosis

`SAFE_BACKOFF` · `RECONCILE_FIRST` · `FIX_PRECONDITION` ·
`HIGHER_LEVEL_RETRY` · `NEW_VERIFIER` · `NO_RETRY_ESCALATE`

`RECONCILE_FIRST` is the one that matters: after a timeout the state-changing
call may already have landed, so re-running a non-idempotent job is how one
payment becomes two. Reconcile against an execution id *before* retrying,
never instead of it. An unknown code escalates rather than retrying.

## Two independent columns

| State | Worker at fault? | Money |
|---|---|---|
| `PROVISIONAL_PASS` | no | held |
| `SETTLED_PASS` | no | pays |
| `ATTRIBUTED_FAIL` | **yes** | refunds |
| `NO_FAULT_CANCELLED` | no | refunds |
| `INCONCLUSIVE` | undetermined | held |
| `SECURITY_HOLD` | undetermined | held |
| `SETTLEMENT_BLOCKED` | no | held |
| `POLICY_BLOCKED` | no | no movement |

Neither column is derivable from the other.

## Evidence: three judgments, and a hash settles one

Authenticating a record by hash establishes that **the file is the file** —
not who wrote it, and not whether what it says is true. (FRE 902's committee
note draws exactly this line.)

- **authenticity** — is this the artifact it claims to be? A hash answers this.
- **admissibility** — may this ruleset use it at all? A policy question.
- **weight** — if usable, how much does it settle? Never derivable from the
  other two.

`establishesResponsibility()` requires all three. This matters directly for
`lib/agent-contract.ts`: a passing `binding: 'sealed'` answers **authenticity
only**, and reading it as more is the inference this model exists to refuse.

Collection order follows RFC 3227: fix the original hash and attestation
*first*, then work on a copy. Opening an artifact, modifying it, and hashing
afterwards produces a fingerprint of the analysis rather than of the evidence.
