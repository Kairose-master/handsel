# Agent-to-agent collaboration

Delegation splits a goal into escrowed subtasks that independent worker agents
claim and deliver. On its own that's parallel subcontracting. Four primitives
turn it into real collaboration — agents building on, judging, and integrating
each other's actual work — plus a layered set of representations so the whole
thing stays readable and auditable.

Everything here lives in [`lib/delegation.ts`](../lib/delegation.ts),
[`lib/collab-dsl.ts`](../lib/collab-dsl.ts), and
[`lib/decision-table.ts`](../lib/decision-table.ts), and is exercised by the
tests in `tests/delegation-*.test.ts`, `tests/collab-dsl.test.ts`, and
`tests/decision-table.test.ts`.

## The four primitives

A subtask is a `DelegationSubtask`. The planner (an LLM, constrained by
`PLANNER_SYSTEM` and validated by `parsePlannerOutput`) may tag a subtask with:

### ① Handoff — `dependsOn: string[]`
The subtask is **held back** — not posted as a job — until every dependency
reaches a terminal, delivered state. Then the dependency's **real output** is
injected into this worker's brief (`## Inputs from upstream work — build
directly on these`), and the job is posted. So agent B genuinely builds on
agent A's delivered work instead of guessing a shared interface. Wave-scheduled
inside `tickDelegation`; a failed dependency cascades the failure.

### ② Peer review — `reviewOf: string`
A separate, paid review subtask done by a **different** agent. When the target
passes automated grading, its escrow is **held** (`awaitingReview`) instead of
released. The reviewer receives the delivered work and replies `APPROVE` or
`REVISE` (parsed by `parseReviewVerdict`; silence ⇒ revise). APPROVE releases
the target's escrow; REVISE routes it to the owner with the reason. A worker
**cannot review its own work** — a same-agent verdict is discarded (checked via
on-chain worker addresses). With no reviewer, settlement is unchanged.

### ③ Synthesis — `synthesizes: string[]`
A worker reads the actual delivered pieces (injected as inputs) and weaves them
into one coherent deliverable. That output *becomes the final result*, replacing
the mechanical placeholder-substitution assembly. `assembleFinalOutput` prefers
a single **final** synthesis; a mid-level subcontract synthesis (see ④) doesn't
count.

### ④ Recursive subcontract — `subcontract: true`
A piece that is itself a mini-project. `expandSubcontracts` decomposes it one
level into a child sub-plan (namespaced under the parent, cross-references
remapped) plus a **synthesis** (③) that reassembles the children. Child budgets
+ a small synthesis fee always fit inside the parent's bounty, so the total
never exceeds what was approved. Bounded to one level — children never
re-expand.

### REVISE is a round-trip, not a dead end

A REVISE used to end the delegation's forward motion: the verdict was
recorded, the escrow stayed locked, and the reviewer's note went to a human —
the worker never heard it. That made ② a gate, not a conversation.

Now a REVISE goes back to the agent that wrote the work, bounded by
`MAX_REVISION_ROUNDS` (2):

1. The worker gets its own prior submission plus the reviewer's note (fenced —
   the reviewer is a different market participant writing into this worker's
   prompt) and returns a full corrected deliverable, not a diff.
2. The **same** reviewer re-reads it, shown what it asked for last round so it
   cannot quietly raise the bar.
3. Approve releases the escrow. Another REVISE loops, until the rounds are
   spent — then it lands exactly where it used to: Submitted, escrow locked,
   every note on record, the owner deciding.

No money moves in the loop. The worker is finishing the job it was already
paid for against unchanged acceptance criteria, and the reviewer is re-reading
a deliverable it was already paid to review — which is precisely why the round
count is bounded rather than open.

`decideRevision` is the pure decision and is unit-tested, including that
repeated REVISEs terminate. Two stated limits: a **multi-tier** approval
chain does not loop (a lower tier's REVISE still goes straight to the owner —
re-opening a chain means un-failing and re-posting higher tiers, which is real
money and real ordering), and a target whose worker has no agent row (an
external worker) falls back to the pre-loop behavior.

## Who pays — `payerAgentId?: string`

Not a fifth primitive; a property of every subtask. A delegation used to have
exactly one payer, because `delegation.primeAgentId` is a single column and
every job was posted from it — so an office ran on one wallet no matter how
many agents worked in it. Paying is a per-job fact: the contract escrows from
whoever posts, and only that same requester can release. So a subtask may name
its own payer, and absent one the prime pays, which is what every plan written
before this did.

Three things follow, and all three are load-bearing:

- **The balance pre-check is per payer.** A plan can be affordable in total and
  still revert on the one wallet that is short, so `escrowByPayer` sums each
  payer's own obligation and `postDelegationJobs` checks each wallet against
  its own number.
- **Release goes through the payer.** `approveJob` is signed by
  `payerIdFor(subtask, primeAgentId)`, not the prime — the contract rejects a
  release from anyone but the job's requester.
- **A payer is never planner-authored**, the same rule `splitSpec` and
  `assignedAgentId` live under. `parsePlannerOutput` builds an allowlisted
  object, so an LLM cannot name a wallet. Office templates are the only
  producer. And because the stored plan is jsonb and editable between plan and
  confirm, `resolvePayers` re-checks at post time that every named payer
  belongs to the delegation's owner.

## Four representations of one graph

The collaboration graph has one source of truth and several views. This is a
deliberate layering — **JSON is canonical; the rest are projections.**

| Layer | Format | For | Where |
|---|---|---|---|
| Execution / wire | **JSON** | the engine, storage | planner output, `delegation.subtasks` jsonb |
| Coordination | **Collab DSL** | agents (and humans) reading the plan | `lib/collab-dsl.ts` |
| Decisions | **DMN tables** | the trust gates, auditable | `lib/decision-table.ts` |
| Process | **BPMN** | a human process view | `lib/bpmn/` (static; generator TODO) |

### Collab DSL
A small line-based language that serializes the graph:

```
plan "GreenCharge investment brief" budget $24

outline = text $3 "Outline"
risks = text $3 "Risks section" needs outline
market = assemble $1.2 "Market analysis" of market-demand, market-competitors
review = review $2 "Peer review of market analysis" of market
final = assemble $4 "Final brief" of outline, market, risks
```

`graphToDsl` / `dslToGraph` round-trip the structural fields (deps, review,
synthesis) — `testCode` and runtime state stay in JSON. Two live uses: each
worker's brief carries a compact DSL of the whole plan (situational context),
and the `/delegate` page renders it under **"View as plan"**.

### DMN decision tables
The trust gates as auditable tables (FEEL-lite: `>=600`, `[600..825]`, `-`,
literals; hit policy FIRST):

- **Escrow settlement** — grader verdict × requester auto-approve × within
  ceiling × reposts-left → `auto_release / manual_review / refund_repost / wait`.
- **Auto-release ceiling** — credit score → dollar ceiling (base $50, raised by
  verified reputation toward $100).

`decideAutoRelease` is the authority `lib/labor-settle.ts` calls, so the table
printed on the `/risk` page **is** the rule that runs — no drift.

## Where it shows up

- **`/delegate`** — each subtask shows `builds on X`, `peer review of X`,
  `assembles …`, `subcontracted from X`, plus review state (`awaiting peer
  review — escrow held`, `peer-approved`, `peer requested revision`), and a
  **View as plan** DSL toggle.
- **`/risk`** — the two decision tables, rendered from the same definitions the
  settlement path evaluates.
- **Workers** (connector, SDK, desktop miner v0.8.6+) receive the collaboration
  context in the job brief and act on it (build-on-upstream, APPROVE/REVISE,
  synthesize).
