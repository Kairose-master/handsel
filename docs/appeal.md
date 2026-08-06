# The appeal

A worker's right to contest a failing verdict. Built after reading
`ITMPEvaluator.sol` (ERC-8195 draft) in `daydreamsai/taskmarket-contracts`.

## Why this exists

Every grading defect in `docs/failure-modes.md` has one shape:

> The platform decided something about a worker, the worker had no way to say
> otherwise, and the fix was to classify better next time.

§24 — a worker refused an attack and the grader wrote a 0.000 quality score.
§25 — a worker said it had no tool and we recorded an accusation against the
requester. Both were answered by sharpening `lib/brief-refusal.ts` until it
could tell the cases apart.

That is the wrong axis to improve on. A classifier is a guess about text, and
every guess about text is eventually wrong on an input nobody imagined, so a
system whose only defence is a better guess has no floor — only a shrinking
error rate. This is the floor.

ERC-8195 makes the other choice explicitly. Their evaluator is not assumed to be
right: it returns a verdict, the task enters `Appealing`, and `appeal()` —
callable only by the worker, only inside a window — routes to a named
`disputeResolver`. They did not build a better evaluator. They built a way to be
wrong and recover.

## How an appeal is heard

Not by amount, and not by who is shouting: **by how the original verdict was
reached.** `lib/grader-class.ts` already carries that.

| Original verdict | Route | Why |
|---|---|---|
| `reproducible` (CI, test suite, canary) | **recompute** | Run it again. Nothing to deliberate — either it passes on a second run or it does not. |
| `mechanical` | **recompute** | Same. |
| `model` (LLM review, vision, audio) | **panel** | Re-prompting the same model is not a second opinion, it is the same opinion with different sampling noise. |
| `attested`, `declared` | **panel** | Not recomputable by a third party, which is the only property that makes `recompute` mean anything. |

The incentive this creates is the one we want: **the cheapest verdict to defend
is the one anybody can recompute, and the most expensive is the one that rests
on a model's say-so.** That is the correct relative price, and it is the same
ordering `docs/graders.md` argues for — reached from the cost side rather than
asserted.

## What may be appealed

| Verdict | Appealable | Why |
|---|---|---|
| `passed: false` | **yes** | The only case where something was established against the worker. |
| `passed: true` | no | Nobody appeals winning. A requester who disagrees has the dispute path — a different mechanism with a different payer. |
| `passed: null` | **no** | This is us saying we do not know: a grader outage, a refused brief (§24), an incapable worker (§25). There is nothing to overturn, and allowing it would let a worker convert "no verdict" into "a verdict in my favour" — strictly worse than the floor it replaced. |

Only the graded worker may file. Once per job (`MAX_APPEALS_PER_JOB`): asking a
third time is not new evidence, it is shopping for a result.

## The window

`APPEAL_WINDOW_MS` is **6 hours**, and it is bounded by something outside our
control. On V2 a failing verdict does not settle on its own —
`returnFailedJobToMarket` records and stops, and `expireReview` settles at the
on-chain review deadline (`lib/dispute-policy.ts` explains why an off-chain
grader is not permitted to be the thing that pays out). So the appeal lives
*inside* the review window that already exists, and must leave the resolution
path room to run before the chain settles regardless of what our database
thinks. An appeal window that outlives the review deadline is a promise the
chain will not keep.

Unknown grading time is **not** permission — an unstamped verdict cannot be
shown to be inside the window, and unknown timing means do nothing here as it
does everywhere else in this codebase.

## What an outcome can be

The interesting case is a **recompute that disagrees with itself**, and it does
not resolve to "the second run wins":

> Two runs of a deterministic check that disagree prove the check is not
> deterministic — and a non-deterministic check is not evidence about the worker
> in either direction.

So a flip lands on `passed: null`, not on a pass. That looks generous and is
not: `null` earns nothing, writes no credit event, and leaves the escrow to the
requester exactly as the §24 path does. What it removes is a **failure** recorded
on the strength of a coin flip.

A split panel resolves the same way, for the same reason — failure to establish
a fact is not a fact. Only an affirmative panel turns a failure into a pass.

An appeal we cannot hear at all (the check will not re-run, the panel cannot be
convened) leaves the original verdict **unchanged**. Our infrastructure failing
is not evidence for either party: it must not quietly clear a failure and it
must not add one.

## Telling the worker

A right nobody is told about is not a right — §25's whole lesson. So the failure
reason returned to the worker now carries the instruction:

> If you believe this verdict is wrong you can appeal it within 6h: POST
> `/api/jobs/appeal` with `{agent_id, spec_hash}` and your worker secret. It
> costs nothing and no verdict about you changes while it is open.

That channel matters: most workers have no browser. The desktop miner, MCP
workers and headless scripts all authenticate with the worker secret, so the
endpoint takes that rather than a session — requiring a logged-in owner would
make the right theoretical for exactly the population most likely to need it.

## What is not built

- **Resolution.** Filing is live; running the recompute and convening the panel
  are not wired. An open appeal is currently a recorded claim awaiting manual
  review, which is honest but is not the mechanism.
- **The panel itself.** `lib/judgment.ts` has the pure core — eligibility by
  account, `PANEL_SIZE`, `tallyPanel`, the fenced question — and has never been
  called by anything.
- **A cost on frivolous appeals.** Filing is free and bounded only by one-per-job.
  The economically right answer is a worker bond forfeited on a failed appeal,
  and LaborMarketV2 already collects a worker bond at accept — but tying the two
  together is an on-chain change, not a scheduling one. Note that ERC-8195 does
  not solve this either: its `stakeAmount` is pulled from the *requester* and
  paid to the evaluator, so it prices an evaluator **showing up**, not **being
  right**, and the worker's `appeal()` is likewise free.
