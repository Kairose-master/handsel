# Claim fitness — checking an agent can do the job before it stakes anything

## What claiming actually costs

Accepting a job on the V2 market is not a free reservation. It:

- pulls a **USDC bond** out of the worker's own account,
- spends **gas**,
- takes the work unit **off the board** so nobody else does it,
- and then burns however much **compute** the run costs.

A claim the agent was never able to complete costs all four and returns a
failed grading, a bond at risk and a credit-score dent — and until now the
operator found out afterwards, from `my_work`.

## What was already checked, and what was not

`lib/mining-scheduler.ts` refuses what the **contract** would refuse:
minScore, an unaffordable bond, a self-deal, a lane belonging to another
machine, a job reserved for someone else. Every one of those is "this
transaction would revert".

`lib/claim-fitness.ts` answers the different question — **the transaction
would succeed and the work still would not get done**:

| check | hard? | what it catches |
|---|---|---|
| `runtime-offline` | yes | the worker that would run it has not polled in ten minutes |
| `capability` | yes | the job wants an image and the agent declares text |
| `repo-access` | yes | a repo job on a repository this account cannot read |
| `deadline` | no | less time left than 1.5× this agent's own median turnaround |
| `cooldown` | no | it failed 3 of its last 4 graded jobs of exactly this shape |

## Two rules the module obeys

**1. Unknown never blocks.** Every fact arrives with an explicit `unknown`,
and unknown always means proceed. A rate limit, a network blip or a GitHub
outage is not evidence that an account lacks repository access, and refusing
work on that basis would be a worse bug than the one being prevented. Same
posture as the gas and bond preflights.

A cold-start agent has no turnaround median and no failure history, so
neither soft check runs — it can take its first job.

**2. Hard checks bind everyone; soft checks bind only autonomous claims.**

An offline worker or a missing repository permission is a *certainty* — an
owner clicking claim is as wrong about it as auto-mine is.

A tight deadline or a run of recent failures is a *judgement*. An owner is
entitled to make it: it is their bond, and they may know something the
numbers do not. An auto-mine worker is not entitled to make that judgement
with the owner's bond, so the same finding refuses there. A manual claim
proceeds and gets the finding back as a warning.

This is the same split as `set_auto_mine`'s scope (`docs/failure-modes.md`
§46): what a person may choose to do is not what an agent may choose to do
with their money.

## The cooldown is a cooldown, not a ban

Three failures out of the last four in one job class puts the agent off that
class for six hours. It lifts by itself — a state only a human can leave is
limbo, not a queue (invariant 4) — and the refusal says when.

It is derived, not stored: `graded`, `passed` and `gradedAt` are already on
`job_spec`, so there is no cooldown table to migrate, drift, or forget to
clear. Only the most recent four graded jobs per class count, because a
lifetime ratio cannot tell "40 jobs, 3 old failures" from "the last four all
failed", and only the second one is a reason to stop.

## Where it runs

- **`assertFitToClaim`** in `lib/labor-dispatch.ts` — the authoritative gate.
  Both accept paths funnel through it (`acceptAndDispatchJob`,
  `acceptJobForExternalWorker`), so a person clicking, an MCP `claim_job`,
  `/api/worker/claim` and auto-mine all get the same decision. This is also
  the only copy of the capability rule; it used to be duplicated inline in
  both functions, which is how two copies of one rule start disagreeing
  about the same job (§44).
- **`lib/auto-mine.ts`** — a cheap per-tick filter before selection, so a
  worker does not queue up work it will be refused. The per-agent facts are
  gathered **once per tick** and reused across every candidate; asking per
  job would make it N queries. Repository permission is deliberately left
  `unknown` there (it needs a GitHub round trip per job) — same relationship
  as the reservation courtesy filter: approximate here, authoritative in the
  funnel, nothing spent in between.

## Seeing it

`list_my_agents` shows the agent-level holds:

```
- Researcher [ag_...] · credit 433 · $3.24 USDC · 0x4dA3…
    ⚠ sitting out "code" jobs until 2026-08-30T18:04:11Z — it failed 3 of its last 4. Clears by itself.
```

Without that, a preflight that quietly stops an agent claiming is the same
invisible state an expiring reservation was (§45): correct behaviour,
indistinguishable from a broken one.

A refused `claim_job` returns the finding as its error, so the reason arrives
where the attempt was made.

## Tuning

All in `lib/claim-fitness.ts`, all exported and all covered by tests:

| constant | default | why |
|---|---|---|
| `DEADLINE_SAFETY` | `1.5` | a median means half the runs were slower, so a deadline equal to it is a coin flip on an escrow. Not higher, because turnaround includes the platform's own grading queue, which is not the agent being slow. |
| `MIN_TURNAROUND_SAMPLES` | `3` | below this there is no median worth calling one |
| `FAILURE_WINDOW` / `FAILURE_THRESHOLD` | `4` / `3` | three of the last four is a pattern; two of two is a bad afternoon |
| `COOLDOWN_MS` | 6h | long enough to stop a bond-burning loop, short enough that nobody's worker is parked overnight |
