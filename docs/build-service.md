# The build service — paying for results, not attempts

**Status: spec. Nothing below is built.** This page exists so the product
sentence and its money semantics are pinned down before any code, the same way
`docs/graders.md` pinned pluggable graders.

## The sentence

Fleet products (SWE-AF and its siblings) sell "goal in, PR out" — and bill for
the *attempt*: ~$6–20 of tokens per build, spent whether or not the result
passes anything. Handsel already has the opposite primitive at per-job scale:
escrow first, independent grading, **money moves only on a pass**. The build
service is that primitive wrapped to goal scale:

> **Give a goal and a budget. Get a graded deliverable. Failed attempts cost
> you nothing — and that is enforced by escrow, not promised by us.**

No competitor billing per token can say this sentence, because their revenue
is the attempt.

## Shape

```
POST /api/build   { goal, budgetBaseUnits, repoUrl?, deadline? }  → { buildId }
GET  /api/build/<id>                                              → status + manifest
```

The result manifest lists every subtask with: verdict, amount paid or
refunded, the grader class that decided it (`reproducible` / `mechanical` /
`model` — `docs/graders.md` taxonomy), and the signed work proof
(`/api/proof/<id>`). A build's claim is exactly as strong as its weakest
grader class, and the manifest must say so per line rather than laundering an
LLM opinion into "verified".

## Every stage already exists

| Stage | Existing code |
|---|---|
| Decompose goal → subtask DAG | `lib/delegation.ts` planner |
| Per-worker briefs with plan context | `lib/collab-dsl.ts` |
| Escrow, settle, auto-release gates | `lib/labor-settle.ts`, `lib/decision-table.ts` |
| Workers | MCP connector, desktop miner, headless script, house worker |
| Grading | `lib/text-grading.ts` (model), repo-jobs CI lane (mechanical) |
| Assemble pieces → one deliverable | synthesis in delegation + assembly |
| Signed proof per pass | `lib/attestation.ts` |
| Code goals → PR, CI grades, merge pays | `lib/repo-jobs.ts` |

What does not exist: the wrapper endpoint, the budget envelope, and the
manifest. The build is new plumbing between old parts, not a new trust
mechanism — which is the point.

## Money semantics (the part that must never be improvised)

- The budget is an **envelope**: posting fees + subtask escrows are drawn from
  it, and the sum of draws can never exceed it. The gate is a decision table
  (`lib/decision-table.ts`), not scattered ifs.
- A failed or expired subtask's escrow returns to the envelope; whatever is in
  the envelope at close **returns to the requester**. Refund is a normal
  outcome, not an error path.
- Partial success is first-class: "7/10 subtasks passed, $X paid, $Y
  refunded" is a completed build, presented with the same manifest — not a
  failure state. The claim "you only pay for what passed" is only honest if
  the partial case is the designed-for case.

## Honest caveats, stated before they are discovered

1. **Pay-on-pass moves attempt-risk onto workers.** A worker who fails eats
   their own token cost. Supply arrives only where
   `pass-rate × reward > cost-of-attempt`, which means small, well-specified
   subtasks — exactly what the planner must be tuned to emit. If external
   supply is thin, the house worker executes; it is a real, disclosed lane
   (grader ≠ worker still holds), not staged demand.
2. **Grader classes must not blur.** A CI-graded diff is recomputable by
   anyone; an LLM-graded text is a signed opinion (`docs/verifying-proofs.md`:
   provenance, not recomputation). The manifest carries the class per subtask;
   the marketing sentence inherits the weakest class in the build.
3. **The demo case is the repo case.** GitHub goals already have the full
   mechanical loop live (label → escrow → PR → CI grades → merge pays), so the
   first build vertical should be repo goals, where "graded" means CI, not
   opinion.

## Increments (each shippable alone)

1. Budget-envelope arithmetic as a pure lib + decision table + tests.
2. `POST /api/build` accepting only repo goals (mechanical lane end-to-end).
3. Manifest + `GET /api/build/<id>` with per-subtask proofs and refund lines.
4. Text/mixed goals behind the same envelope, manifest labelling classes.
5. A `/build/<id>` public page — the manifest is the marketing.
