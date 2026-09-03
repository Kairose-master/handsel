# Office sessions — the unit past one job

*2026-09-03. The runtime that turns an office from a roster into an
organisation that pursues a goal over time: plans it, hands the work to a
coding harness on the owner's machine (or to the market), watches it,
checkpoints it, verifies what came back, pays what a written policy allows,
asks a person for the rest, and resumes after a crash from the last safe
point. Read `docs/office.md` first; this is what the office DOES with its
roster.*

Not to be confused with `docs/sessions.md` (`lib/session.ts`), which is a
thread of escrowed turns bound to one worker — a job that lasts an hour. An
office session is a goal that lasts as long as it takes and can contain many
jobs.

## The model

```
Office (user_id, slot)
  └── OfficeSession            goal · status · budget · policy · clock · schedule
        ├── SessionTask        a node of the plan: brief, criteria, deps, settlement (internal|escrow), risk tier
        ├── SessionRun         one execution of a task on one worker (attempt N)
        ├── Checkpoint         what a run had done — summary, git HEAD, bounded patch, files
        ├── ApprovalRecord     the policy's verdict + the person's, with the evidence read
        ├── SessionArtifact    diff · deliverable · test report · log · proof, by sha256
        └── SessionEvent       append-only, idempotent by key — the truth
```

| file | what |
|---|---|
| `lib/office-session.ts` | statuses, transition table, event vocabulary, the reducer (`applyEvent`, `replay`), invariants |
| `lib/office-session-loop.ts` | one heartbeat as a pure function: `tickSession(state, observation, policy) → { events, commands }`; worker selection; `learnFromSession` |
| `lib/approval-policy.ts` | the approval engine: hard rules, the owner's rules as JSON, risk tiers E0–E4, the money gate |
| `lib/coding-harness.ts` | the `CodingHarness` contract; Claude Code's grant → argv and stream parser; the session brief; workspace boundary; redaction |
| `lib/office-session-plan.ts` | the default plan (no model needed) and the mapping from the delegation planner's JSON |
| `lib/office-session-server.ts` | tables, `appendEvents` (the one write path), observation, commands, the worker protocol, owner actions |
| `app/api/worker/poll/route.ts`, `app/api/worker/session-run/route.ts` | the run hand-out, progress reports and cancel list ride the existing poll; the finish report has its own route |
| `public/handsel-worker.mjs` | `runSessionRun`: spawn under the grant (brief on stdin), stream, checkpoint on the first edit and every minute, report-only polls while busy, verify, collect the diff, report |
| `app/(dashboard)/office/sessions/` | the control room and the per-session timeline |
| `app/actions/office-session.ts` | the owner's levers, including the one-click connect |
| `scripts/office-session-e2e.ts` | the end-to-end scenario driver |

### Relationship to jobs and delegations

A job stays what it is: one deliverable, one `specHash`, one release. A
session task with `settlement: 'escrow'` IS a job — posted by
`postSpecJob` with `autoApprove` **off**, graded and paid by the paths every
job uses. The session only decides *when* `autoApprove` may flip on: after
the policy said ALLOW, `settle_escrow` sets the flag and calls
`autoApprovePassedJob`, the single release site, whose on-chain status
check, peer-review hold and cap all still apply. There is no second place
money leaves from.

A task with `settlement: 'internal'` is the office's own worker on the
owner's own machine. No escrow is posted, no bounty exists, no credit event
is written (self-dealing must not inflate a score — `docs/failure-modes.md`
invariant 22). Settling it records the decision and the artifact hash.

A delegation is what a session's `plan` command produces when the goal is
for the market and a model key is configured: the delegation planner's JSON
maps onto escrow tasks (`planFromSubtasks`). Without a key, or for a local
coding session, the plan is deterministic: one task, the goal, verified by
the owner's command and an independent review.

## Session kinds

| kind | what the loop does |
|---|---|
| `one_shot` | plan once, run to completion |
| `long_running` | same, over hours or days — heartbeats, checkpoints, resume |
| `scheduled` | after a wave completes, `WAKE_SCHEDULED` at the next fire; on wake, `WAVE_STARTED` and a fresh plan. The schedule is the SAME session's repeated run, not a new session |
| `event_driven` | idle after a wave (`nextWakeAt = null`); `fireSessionTrigger(userId, 'github.ci_failed')` wakes it with a new wave |
| `local_coding` | bound to one local worker and its workspace grant; the default plan is one coding task |

## The state machine

Generated from the code (`transitionTableMarkdown()`), so this table and the
reducer cannot disagree:

| status | shown to the owner | may go to | money may move | automatable |
|---|---|---|---|---|
| `draft` | Goal recorded; nothing has been planned yet. | planned, paused, cancelled, expired, failed | no | yes |
| `planned` | The plan exists; the budget has not been checked against it. | awaiting_budget, ready, … | no | yes |
| `awaiting_budget` | The plan costs more than the session may spend. | planned, ready, … | no | **no** |
| `ready` | Work is ready to dispatch. | planned, running, waiting_on_*, retrying, completed, partially_completed, … | **yes** | yes |
| `running` | A worker is executing a task right now. | ready, waiting_on_*, retrying, completed, partially_completed, … | **yes** | yes |
| `waiting_on_dependency` | Every remaining task is blocked on one that has not finished. | ready, running, completed, partially_completed, … | no | yes |
| `waiting_on_worker` | The worker went silent; the last checkpoint is preserved and a resume is pending. | running, retrying, ready, partially_completed, … | no | yes |
| `waiting_on_review` | A deliverable is in; an independent reviewer has not answered. | ready, running, waiting_on_approval, retrying, … | no | yes |
| `waiting_on_approval` | The policy could not decide alone; a person has to approve or deny. | ready, running, retrying, completed, partially_completed, … | no | **no** |
| `paused` | Paused by the owner; nothing is dispatched until resumed. | ready, cancelled, expired, failed | no | **no** |
| `retrying` | The last attempt failed; the next one is scheduled. | running, ready, waiting_on_worker, waiting_on_dependency, failed, partially_completed, … | no | yes |
| `partially_completed` | Finished with some tasks not done. | — | no | — |
| `completed` | Every task settled. | — | no | — |
| `failed` / `cancelled` / `expired` | terminal, reason on record | — | no | — |

Every non-terminal status may pause, cancel, expire or fail. `STATUS_META`
also carries, per status, what the next heartbeat does and what a fresh
process does after a restart.

### Invariants (`sessionInvariants`)

Checked in tests after every event of every scenario, and by `appendEvents`
before every commit — a batch that would violate one is refused whole:

- a `completed` session has no open escrow task and no failed task (that is `partially_completed`);
- a `cancelled` session has told every live run to stop;
- a terminal session names no current run and has no wake scheduled;
- a `running` session has a current run that is live (or just finished and about to be folded), and that run is resumable: it wrote a checkpoint, began from one, or its task has none (the brief is the level-0 checkpoint);
- `waiting_on_approval` cannot move money and has an undecided approval;
- spend never exceeds the budget; a task never exceeds its attempts; a task is never dispatched twice at once;
- an escrow task settles only after `PAYMENT_SETTLED`; any task settles only after a granted approval;
- money never moves under a `DENY`, and a `REQUIRE_OWNER`/`REQUIRE_REVIEWER` approval is never decided by the policy.

### Time

Every event carries `occurredAt`; the session carries `startedAt`,
`lastHeartbeatAt`, `nextWakeAt`, `deadlineAt`, `pausedAt`, `completedAt`. The
loop schedules its own next wake (`WAKE_SCHEDULED`): a minute while a run
is live, five while waiting on the world, the retry time while backing
off, the deadline whenever it is sooner. The ops step ticks every session
whose `nextWakeAt` has passed.

## The loop (`tickSession`)

```
observe      the server folds worker reports, chain reads, review answers into EVENTS first
interpret    terminal? deadline? paused? — then time out silent runs (heartbeat, pickup, wall clock)
plan         draft → `plan` command; planned → BUDGET_CHECKED
retry/fail   a task whose run died: RETRY_SCHEDULED with backoff, or TASK_FAILED when attempts are spent
graph        doomed tasks skipped, unblocked tasks ready, the rest blocked
verify       submitted → tests (deterministic) → independent review → decide
decide       evaluateApproval → ALLOW / ALLOW_WITH_LOG (granted by policy) · REQUIRE_OWNER (waits) · DENY (fails)
settle       internal → TASK_SETTLED; escrow → moneyGate → PAYMENT_AUTHORIZED + `settle_escrow`, settled when the chain says paid
dispatch     one live run per workspace; selectWorker; TASK_DISPATCHED + `dispatch_run` (with the checkpoint to resume from)
learn        on completion: `record_memory` — lessons derived from the record, folded into the office's session memory
schedule     WAKE_SCHEDULED
```

Every stage's output is an event the reducer accepted or a command the
server performs; a command's result arrives as events on the next append,
so a crash between the two leaves a resumable record.

### Verification layers, and what each may authorise

| layer | evidence | may |
|---|---|---|
| deterministic test (`verify.command`, run by the worker after the harness) | exit code + tail, `TEST_REPORTED` | a failure DENIES outright; a pass is one condition |
| platform grader (escrow tasks) | the job's recorded verdict | a recorded FAIL is never re-graded into a pass (§69) |
| independent reviewer (model, `run_review`) | `REVIEW_RECEIVED {approve, note}` | REVISE with attempts left → feedback and a retry; APPROVE is one condition; no reviewer available → a person |
| the policy | the flattened evidence | ALLOW / ALLOW_WITH_LOG / REQUIRE_OWNER / REQUIRE_REVIEWER / DENY |
| the owner | the inbox | anything the policy could not |
| the chain | `PAYMENT_SETTLED` observed, never assumed | settles an escrow task |

## The approval policy (`lib/approval-policy.ts`)

Not a boolean. Two layers, in order:

1. **Hard rules** no policy can relax: a write outside the workspace → DENY;
   over the remaining or daily budget → DENY; failed tests or CI → DENY;
   risk **E4** (money, deploy, delete, production), a modified secret,
   production impact, or over the single-task limit → **REQUIRE_OWNER**.
2. **The owner's rules**, as JSON: `deny` (any) · `requireOwner` (any) ·
   `requireReviewer` (any, while unreviewed) · `autoApprove` (ALL). A
   condition on evidence that is missing never holds — "no test ran" is not
   "tests passed".

The default policy is the product spec's example:

```
daily_budget_usd: 20 · single_task_limit_usd: 3
auto_approve: testsPassed != false · changedFileCount <= 10 · secretModified == false · productionImpact == false · reviewerVerdict == APPROVE · amountUsd <= 2
require_owner: amountUsd > 2 · productionImpact · newDependency · reviewerDisagreement
require_reviewer: reviewerVerdict == null
```

Every decision is a receipt on the `ApprovalRecord`: policy id and version,
the evidence read (verbatim), the rules that matched, one reason per
line, who decided (`policy` | `owner` | `reviewer`), and what moved.

**Risk tiers** (`riskTierFor`, from what a run actually did): E0 read ·
E1 edit in workspace · E2 tests/shell · E3 network/install/PR/dependency ·
E4 money/deploy/delete/production. Same letters as
`lib/evidence-assurance.ts`'s evidence classes, deliberately not the same
ladder: one says how much a claim may be trusted, the other how much an
action can do.

**The money gate** (`moneyGate`): an escrow release is asked for only from
a status whose `moneyMayMove` is true, under ALLOW/ALLOW_WITH_LOG or a
person's grant, and — on a real-money deployment — a **policy** decision
needs `OFFICE_SESSION_ALLOW_REAL_MONEY=true` (the LINEAGE / REVIEW_STAKE
shape). An owner's own click is not gated by the flag. Internal tasks pass
for the record and move nothing.

## Claude Code as a first-class worker

### The contract (`CodingHarness`)

`detect → preflight → start → stream → pause/resume/cancel → collect →
inspectWorkspace`. Only `claude` gets the full treatment today
(`HARNESS_SESSION_SUPPORT`): a structured stream (`--output-format
stream-json --verbose`), native session ids, and the grant compiled to tool
allow/deny lists. Codex, OpenCode, Cline and Gemini run a session under
their one-shot argv with the brief on the command line, report line-buffered
stdout, and resume from checkpoints only. That is stated per adapter, not
implied.

### The grant → the flags

```
write:false   → --permission-mode plan  + --disallowedTools Edit,Write,MultiEdit,NotebookEdit
write:true    → --permission-mode acceptEdits          (edits auto-approved INSIDE the cwd only)
shell:true    → --allowedTools Bash      shell:false → --disallowedTools Bash
network:false → --disallowedTools WebFetch,WebSearch
```

Never `bypassPermissions` on a session run. `acceptEdits` auto-approves
edits inside the working directory and nothing else, so a write outside it
needs an answer no headless run can give and fails closed. The platform
checks the reported paths against the workdir anyway (`escapedWorkspace` →
a hard DENY); and the worker refuses a grant whose workdir lies outside its
own `--workdir`. The mirror in `public/handsel-worker.mjs` is pinned to
`lib/coding-harness.ts` by `tests/coding-harness.test.ts`, which extracts
and runs it.

### Connect once

```
Office → Worker fleet → "Connect Claude Code on your machine"
  choose agent · working directory · verification command · shell / network / install / push · $ per task · $ per day
  → connectWorkspaceWorker(): flips the agent to a local worker (rotating its secret), stores the grant, returns ONE command
  → npx handsel-worker --token … --workdir <dir> --harness claude
  → first poll: the worker is online; a session's task can be dispatched to it
```

Secrets and external payments are never grantable from that surface.

### While it runs

The worker parses the stream into events (`progress`, `file`, `tool`,
`error`, `cost`), redacts credential shapes, and sends them on the next poll
(`session_runs`) — the same authenticated round trip that hands out work.
Every 60 s it captures a checkpoint: `git status`, a bounded `git diff`
(untracked files included), the last thing the harness said. The platform
folds each report into `RUN_PROGRESS` and each checkpoint into
`CHECKPOINT_CREATED`; the raw lines go to a bounded run log the page
tails.

On exit the worker runs the verification command (when `shell` is granted),
takes the diff and the changed/deleted file list from git, reads the
deliverable file the brief named, and POSTs `/api/worker/session-run`. The
server hashes the diff, deliverable and test report as artifacts, folds
`RUN_FINISHED` + `TASK_SUBMITTED` + `TEST_REPORTED`, and ticks the session
immediately so verification starts now.

### When it dies (scenario B)

No heartbeat for `HEARTBEAT_TIMEOUT_MS` (5 min; `OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS`
to tune, bounded) → `RUN_TIMED_OUT` → `waiting_on_worker`, the checkpoint
kept. `RETRY_SCHEDULED` with backoff; on the retry the task is dispatched
again with `resumedFromCheckpointId`, the brief carries the checkpoint's
summary and files, and the worker re-applies the checkpoint's patch when the
working tree no longer has it. Attempts are counted per task, so a resume is
attempt 2 of the same task — never a second task, never a second payment.
A run nobody picked up within `PICKUP_TIMEOUT_MS` is `WORKER_LOST`; another
alive worker is chosen if there is one, otherwise the session waits and the
owner is told.

## What the worker enforces vs what the platform records

| boundary | enforced by | recorded by |
|---|---|---|
| the working directory | `cwd` + `acceptEdits`; the worker refuses a grant outside its `--workdir` | `escapedWorkspace` on the reported files → DENY |
| shell / network / editing tools | Claude Code's allow/deny lists | the stream's tool events → `runRiskTier` |
| secrets | never granted; `.env*`/keys in the changed files → `secretModified` | hard REQUIRE_OWNER |
| production / dependencies | — | path classes → `productionImpact` / `newDependency` |
| cost | per-task and daily limits in the grant and the policy | `PAYMENT_SETTLED` sums per office per 24 h |

## The control room (`/office/sessions`)

**First screen first.** `components/office-control-strip.tsx` sits at the
top of the dashboard home and of `/office`: needs-you count with inline
approve/deny, live sessions with their current task, worker and next step,
running-now, workers online, paid today (and how much of it the policy
approved by itself), retries/failures, the latest artifact by hash, and how
many lessons the briefs opened with. Every number is the same
`officeSessionOverview` query the control room uses; it links into it.

Needs your decision (the inbox: reasons, files, the diff, approve/deny) →
Sessions (status sentence, wave, tasks done, spent/budget, live runs, next
check; pause/resume/cancel) → Worker fleet (grant, liveness, harness;
connect) → Budget (paid today, of which auto-approved; committed) → Give
the office a goal → Approval policy (rendered; editable as JSON) → What
this office learned. `/office/sessions/<id>`: the timeline (the log,
verbatim), the live run (the harness's own lines), tasks with every
verdict, approvals with the evidence they were decided on, artifacts by
hash, and whether replaying the log reproduces the state shown.

## The end-to-end scenario

`scripts/office-session-e2e.ts` runs against a scratch Postgres, the real
`next start`, the real `handsel-worker.mjs` and a real `claude` process, on
a git fixture whose `add()` subtracts. It creates the user and agent rows
sign-up would create, stores a grant, starts a session, and drives the loop
by ticking; the worker does what a worker does. What it checks: only the
intended file changed, the diff and test report were stored by hash, the
policy decided as written, the event log replays to the materialized state,
and — for scenario B — that killing the worker mid-run ends in a resumed
attempt 2 from the checkpoint and one settlement, not two.

### What the run that shipped with this document showed (2026-09-03)

Environment: this repo's container, Postgres 16 on a scratch cluster,
`next start` on port 3111, `handsel-worker.mjs --harness claude
--no-preflight` (root: the one-shot preflight asks for
`bypassPermissions`, which the CLI refuses under root; session runs use
`acceptEdits` and are unaffected), Claude Code 2.1.259, no LLM key on the
platform (so no independent reviewer).

| scenario | sessions | what happened |
|---|---|---|
| **A** local coding, default policy | `oses-ImdcSVsh5VZy` | plan → dispatch → Claude Code edited `lib/math.js` only, ran `npm test` (pass), wrote the deliverable → diff/deliverable/test report stored by sha256 → review requested, **no reviewer available** → `REQUIRE_OWNER`, session `waiting_on_approval` → owner granted on the inbox → settled, `completed`. Harness cost $0.0886. Replay matched the materialized state. |
| **C** small task, lenient policy (no reviewer condition) | `oses-yXXZCd1Bw9tt` | same run; policy evaluated `ALLOW_WITH_LOG` (tests pass, 1 file, no secret, no production, $0) → granted by policy, settled, `completed` with nobody clicking. |
| **B** worker killed mid-run | `oses-s_Mylv5n9SHy` (no checkpoint yet), **`oses-ajSaGQAr9qcZ`** (checkpoint) | `kill -9` on the worker 12 s in, after the first edit's checkpoint (patch 291 B) had landed → 45 s later `RUN_TIMED_OUT` → `retrying` (60 s backoff) → worker restarted → attempt 2 dispatched with `resumedFromCheckpointId`, the brief said "Resuming from checkpoint 1", the dispatch carried the patch → finished, auto-approved, **one** settlement. `RUN_PROGRESS×29` from the busy-worker report polls. |
| **D** production change → owner | unit-tested (`tests/office-session-loop.test.ts`), not run live — the fixture has no production file | `vercel.json` in the changed set → hard `REQUIRE_OWNER`, `waiting_on_approval`, no `PAYMENT_AUTHORIZED` until the owner grants |

Also checked on every session: `git status` in the workspace showed only the
intended file(s); nothing outside the workdir was touched; no escrow was
posted and no chain was called (internal tasks); `spentUsd` stayed $0.

The first attempt at scenario A found four defects the unit suite could
not: Claude Code's variadic tool flags eating the positional brief, a
dead run's dispatch row keeping the worker "busy", a missing `retrying →
waiting_on_worker` edge, and a busy worker that did not poll — so no
checkpoint or heartbeat reached the platform until the run ended.
`docs/failure-modes.md` §70 has each one and its fix.

## What is not built

- **Cloud/MCP workers on a session task.** A session run is handed out on
  the poll, so only a polling (local) worker can take one today. Escrow
  tasks reach cloud/MCP agents the ordinary way (the market), which is the
  right lane for them; internal tasks cannot.
- **Codex/OpenCode/Cline/Gemini streaming and tool grants.** They run, they
  checkpoint from git, their grant is the cwd. The per-tool allow-lists exist
  only for Claude Code.
- **Pause/resume of a live process.** `pause` at the session level stops
  dispatching and times out dead runs; it does not SIGSTOP a harness.
- **Independent review needs a model key** (`resolveLlm`). Without one the
  reviewer answers "unavailable" and the policy sends the task to the owner
  — never to an automatic pass.
- **Worker success rates in selection.** `WorkerCandidate.successRate` is
  null (no fake numbers); selection uses the bound worker, liveness,
  capability and bond readiness.
- **A signed proof per internal artifact.** Artifacts are hashed and the
  approval receipt names the hash; the EIP-712 work proof is issued only on
  the escrow lane (`issueProofForJobSpec`).
- **MCP tools** for sessions. The control room and the actions are the
  surface; `open_session`/`session_*` remain the job-session tools.
