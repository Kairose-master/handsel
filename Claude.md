# Claude.md — Handsel project reference

This file is the living architecture reference for this repository. It
started as a build spec ("build a vertical slice") and that vertical slice
is long since done — everything below reflects **current state**, not a
to-do list, except the explicit "Not yet built" section at the end.

## What this is

An AI Agent Credit Infrastructure prototype:

> Payment lets AI agents transact. Credit lets AI agents scale.

Autonomous agents perform real economic tasks, generate genuine behavioral
history, build reputation from that history, receive a credit score, and
draw a programmable, on-chain-enforced credit limit against it. See
`README.md` for the full feature tour — this file is about how the system
is put together and the conventions to follow when extending it.

## Stack

- **Frontend/backend**: Next.js (App Router) + TypeScript + Tailwind,
  Drizzle ORM over Neon PostgreSQL, Better Auth for sessions.
- **Agent runtime**: Python + LangGraph + Anthropic Claude
  (`agent-runtime/`), a separate FastAPI service reached over HTTP —
  async (202 + callback), never blocks a Next.js request.
- **On-chain** (optional layer): Solidity contracts on Ethereum Sepolia,
  ERC-4337 smart accounts via ZeroDev (Kernel v3.1, EntryPoint v0.7),
  Ethereum Attestation Service for score attestations, `viem` for all
  client-side chain interaction.

## Architecture: how a task becomes a credit score

```
Task Input
  ↓
LangGraph Agent (planner → tool execution → evaluation)      [Python, agent-runtime/]
  ↓
Structured events (TASK_STARTED, TOOL_EXECUTED, TASK_COMPLETED/FAILED, ...)
  ↓
POST /api/runtime/callback                                    [persists to agent_events]
  ↓
recalculateCredit()                                            [lib/credit-engine/index.ts]
  ↓
assessCredit() — pure function, no I/O                         [lib/credit-engine/scoring.ts]
  ↓
score (300–990) → rating (AAA–D) → credit limit → risk level
  ↓
credit_scores history row + agent row updated + (optional) on-chain mirror
```

`assessCredit()` weights: Performance 40% · Reliability 30% · Reputation
20% · Risk 10%. Factor scores are *dampened toward neutral (50) while the
sample is small* — an agent must earn certainty, not start there. Zero
recorded tasks = floor score (300, unrated, $0 limit), never a seeded demo
value.

**The score → rating and score → risk-level thresholds are not hardcoded.**
`ratingForScore()`/`riskLevelForScore()` in `scoring.ts` take an optional
`ScoreRule[]` (a DMN-style decision table: "score ≥ threshold → outcome")
and default to `DEFAULT_RATING_RULES`/`DEFAULT_RISK_RULES` when none is
passed. `lib/credit-rules.ts` reads the live policy from
`credit_rating_rules` (falling back to the defaults if empty) and
`recalculateCredit()` threads it through on every run. An admin with the
`credit_rules` permission edits this from `/admin/credit-rules` — actual
lending policy, changeable without a code deploy. Keep `scoring.ts` pure
(no DB/network calls) — that's a load-bearing property other code relies on
(it's testable/reasoned-about without mocking I/O).

## The two grades of credit signal

Every behavioral event is one of two kinds, and the scoring engine (and the
UI) must never blur them:

1. **Self-evaluated** (`TASK_COMPLETED`/`TASK_FAILED`) — the agent runtime
   grading its own output. An opinion, not a fact.
2. **Ground-truth verified** (`VERIFIED_TASK_COMPLETED`/`_FAILED`,
   `JOB_COMPLETED`) — graded by an independent party against a hidden
   answer or an on-chain-escrowed real deliverable. A fact.

This is why Proving Ground (`app/actions/verified.ts`,
`contracts/src/VerifiedTaskEscrow.sol`) exists: the server generates the
problem *and* the hidden answer (grader ≠ solver — never the same agent),
escrows a bounty, sends only the problem to the solver, and grades
server-side on callback. It's also why Labor Market disputes
(`raiseDisputeAction`/`resolveDisputeAction` in `app/actions/labor.ts`)
route to an independent admin rather than trusting the requester's word
alone — a requester saying "this is bad work" isn't a verified signal
either.

**Cross-user Proving Ground** (a solver and requester owned by different
users) works via a propose/accept split, not a direct dispatch. The reason
it can't be a direct dispatch: kicking off a solve means inserting an
`agentTask` row and calling the runtime *as* the solver, billed (on BYOK)
to the solver owner's own Anthropic key — doing that unilaterally on
someone else's agent is commanding it without consent, not a limitation of
grader≠solver itself (the hidden answer holds regardless of who owns what).
So `startVerifiedTask()` checks `solver.userId !== requester's userId`: same
owner still dispatches immediately (unchanged); different owners escrows
the bounty (the requester's own money — no permission issue there) and
sends a `verified_task_proposal` agent message (see "Agent-to-agent
negotiation" below) instead, landing the task in `awaiting_solver`. The
solver's own owner calls `acceptVerifiedTaskProposal()` — which is what
actually inserts the `agentTask` row and dispatches, now under their own
session/BYOK — or `rejectVerifiedTaskProposal()`, which cancels the
still-on-chain-Open escrow immediately rather than leaving the requester's
money locked until they notice and reclaim it manually.
`dispatchSolve()` is the one shared helper both the same-owner path and
`acceptVerifiedTaskProposal()` call, so they can't drift. `getVerifiedTasks()`
returns tasks where the caller owns either side (`iAmSolver`/`iAmRequester`),
not just requester-owned ones, so a solver sees proposals addressed to them
on `/verify` itself, not only in their message inbox.

**Auto-graded code jobs** extend this to the Labor Market: a job may carry
requester-authored Python acceptance tests (`jobSpec.testCode`). At
submission, `settleLaborMarketJob` (in `/api/runtime/callback`) extracts the
LAST ```python block from the output (`extractPythonCode` in
`lib/code-grading.ts`) and grades it via the **platform** runtime's `/grade`
endpoint — never the runtime that produced the work, so a BYO webhook agent
can't grade its own homework. The verdict lands three places: as
`jobSpec.testResult` evidence (job card, guest page, dispute review), as a
`JOB_TESTS_PASSED/FAILED` credit event (graded-fact class — reputation boost
on pass, risk penalty on fail; see `lib/credit-engine/scoring.ts`), and in
the platform feed. Grading unavailability is `passed: null` — an infra fact
about us, so it writes NO credit event about the worker. The sandbox
(`execute_python` in `agent-runtime/runtime/tools.py`, also the agent-facing
`run_python` tool) is subprocess isolation — scrubbed env (no secrets),
temp cwd, 10s timeout, rlimits — honest-but-limited (no network isolation;
not a boundary against a determined attacker with network access), flagged
as a known gap for real-money stages.

**`/grade`'s pass/fail verdict is decided by a marker, never the bare exit
code** (`_build_grading_script` in `agent-runtime/runtime/server.py`).
Naively running `solution_code + test_code` as one script and reading the
process's exit code is exploitable: any early exit inside the solution
phase — `sys.exit(0)`, `quit()`, `os._exit(0)` (accidental, from a model's
leftover `if __name__ == "__main__"` block, or deliberate) — skips the
test code entirely while the subprocess still exits 0, which read as a
pass under the old check. That stopped being a style nit the moment a
passing verdict could auto-release real escrow with no human review
(`autoApprovePassedJob`). The fix wraps each phase in `try/except
SystemExit` and only prints an unguessable marker after both phases
provably ran to completion; the caller checks for that marker's presence
in stdout, not the exit code — `os._exit()`/a kill signal skip Python's
own exception handling, but they also skip ever printing the marker, so
the parent still reads that correctly as a failure. Verified against
`os._exit(0)`/`sys.exit(0)`/`quit()` submissions directly (all now grade
as failing; previously all three graded as passing).

**Failed tests auto-return the job to the market**
(`returnFailedJobToMarket()` in `/api/runtime/callback`): the tests are the
agreed contract, so an objective failure doesn't park in Submitted waiting
for the requester — the escrow is auto-disputed and refunded (both
platform-signed, justified by the grader's output) and the same spec is
reposted as a fresh job with `repostCount+1` and the failed worker added to
`failedWorkerIds` (blocked from re-accepting in `acceptJobAction`). Capped
at 2 auto-reposts per lineage so an impossible test suite can't recycle
escrow forever; past the cap it stays Submitted for manual judgment. A
mid-sequence failure (disputed but not resolved) lands in the existing
admin dispute queue — that's the designed manual fallback, not a bug.

**Passed tests auto-release the escrow, symmetrically** (`autoApprovePassedJob()`,
same file): before this existed, a worker could pass grading and simply
never get paid — the job just sat Submitted waiting for a human "Approve &
pay" click that might never come (a seeded/house-agent job, an idle
requester). Same authority as the failure path: the tests are the agreed
contract, so a pass calls `approveJob` + `creditWorkerForJob` immediately.

This only fires when `jobSpec.autoApprove` is true — the requester's own
explicit choice, recorded on the authenticated `postJobAction` call THEY
made when posting the job (a checkbox in the Post-a-Job form next to the
test-code field, default checked). `approveJob` itself has no authorization
logic of its own — it just signs as `spec.requesterAgentId` — so this flag
is the actual gate, not an inference drawn after the fact from `testCode`'s
mere presence (an earlier version of this feature made exactly that
mistake: it treated "acceptance tests exist" as sufficient authorization to
auto-release funds, with no record of the requester ever having agreed to
skip manual review). Manual approval is still required for jobs with no
`testCode` (nothing objective to auto-trust), for any requester who
unchecked auto-approve, and — regardless of consent — for any job whose
bounty exceeds `AUTO_APPROVE_MAX_BOUNTY_USD` (default 50), a second,
independent cap on how much a single grader mistake can release
unattended. Both auto-paths (`autoApprovePassedJob`, `returnFailedJobToMarket`)
retry their post-irreversible-on-chain-step DB/RPC writes a few times and
emit a `logPlatformEvent` (`JOB_AUTO_APPROVE_INCOMPLETE` /
`JOB_REPOST_FAILED`) if they still fail, since by that point money has
already moved and the only thing left to protect is visibility. An
auto-reposted job (after a failed verdict) carries the original
`autoApprove` choice forward rather than silently resetting it.

**Graded verdicts override the self-report, they don't just sit next to
it** (`overrideSelfReportsWithGradedVerdicts()` in
`lib/credit-engine/index.ts`). The runtime's own `TASK_COMPLETED`/
`TASK_FAILED` event only knows "did I produce non-empty output" — it has
no idea whether that output was actually *correct*. Before this fix, a job
whose acceptance tests genuinely FAILED still counted as a completed task
toward Performance (40% weight) and Reputation (20%) in `scoring.ts`,
because the self-report said success regardless; the real failure only
dinged Risk (10%) via `testsFailed`. A confidently-wrong deliverable could
net a credit *increase* despite failing grading — exactly the "who grades
the grader" failure mode the whole graded-fact design exists to prevent,
just reintroduced one level up by summing the opinion and the fact as if
they were independent signals instead of the fact correcting the opinion.
Fix: `recalculateCredit()` looks up which of the agent's tasks were
auto-graded (`jobSpec.testCode` set, `jobSpec.testResult.passed` not null)
and rewrites the matching self-reported event's `eventType`/`success` to
the graded verdict before it ever reaches `assessCredit()` — the fact
replaces the opinion for that specific task. Self-correcting on the
agent's next credit recalculation; no backfill migration needed since
`recalculateCredit()` always re-reads full history, never increments.

## On-chain layer

Fully optional — gated on env vars (`isOnchainConfigured()`,
`isAgentAccountConfigured()`, `isLaborMarketConfigured()`,
`isVerifiedEscrowConfigured()` in `lib/onchain/config.ts`). With them unset
the app runs off-chain exactly the same way; every server action that
touches chain state lazy-imports its on-chain module and checks
configuration first.

- **Chain is env-selected** (`ONCHAIN_CHAIN`: `sepolia` default,
  `giwa-sepolia` for GIWA — an OP Stack L2, chain id 91342). Explorer links
  come from `EXPLORER_URL` in `lib/onchain/config.ts`; never hardcode
  `sepolia.etherscan.io` in UI. EAS defaults per chain too (Sepolia
  standalone deployment vs GIWA's OP Stack predeploy `0x4200…0021`).
- **Agent accounts run in one of two modes** (`agentAccountMode` in
  `lib/onchain/config.ts`, both implemented in `lib/onchain/account.ts`
  behind the same `getAgentAccountAddress`/`sendAgentCall` API):
  - `kernel` — deterministic ERC-4337 Kernel account per agent, sponsored
    gas via ZeroDev paymaster. Requires live 4337 infra (Sepolia).
  - `eoa` — deterministic per-agent EOA derived
    `keccak256(ownerKey ‖ agentId)`; the oracle auto-tops-up gas before
    sends. Exists because GIWA (as of 2026-07) has EntryPoint v0.7 as a
    predeploy but **no** public bundler/paymaster and no Kernel factory
    (verified via `eth_getCode`) — so 4337 simply isn't usable there yet.
    Still one secret total; still "the agent's own address transacts."
- **Registry + Vault**: the scoring engine mirrors each recalculated limit
  to `AgentCreditRegistry` and writes an EAS attestation
  (`mirrorOnchain()` in `credit-engine/index.ts`); agents draw/repay real
  test USDC from `AgentCreditVault`, which enforces the limit on-chain.
  - **Owner-level exposure, not just per-agent**: `AgentCreditVault.outstanding`
    is keyed per agent address, so a fresh agent always reads `outstanding
    == 0` there — without a fix, a user could leave one agent's draw unpaid
    and spin up a brand-new agent with an independent credit line. Fixed by
    netting owner-wide exposure (`creditTransaction.userId` already records
    the owner on every draw) at the two places that actually decide "can
    this be drawn": `ownerOutstandingBalance()` in `credit-engine/index.ts`
    reduces what `mirrorOnchain()` publishes to the registry (the only
    on-chain lever available without a contract redeploy — `agent.
    availableCredit` itself stays per-agent, since risk.ts sums that field
    across a user's agents and owner-netting it there would double-count
    the same debt once per agent), and `drawCredit()` in
    `app/actions/credit.ts` adds the same owner-wide check for pure
    off-chain draws.
- **LaborMarket.sol**: `Open → Accepted → Submitted → {Completed |
  Disputed → {Completed | Refunded}}`. `resolveDispute()` is restricted to
  an immutable `arbiter` address (the oracle EOA) — not the requester, not
  the worker. Redeploy *only this contract* with
  `contracts/script/DeployLaborMarket.s.sol` when it changes; it's wired
  to the already-deployed `MockUSDC`/`AgentCreditRegistry`, so agent
  balances and credit lines are untouched by a LaborMarket-only redeploy.
- **VerifiedTaskEscrow.sol**: commit-reveal settlement (front-running
  resistant) — the solver's answer is committed as a hash, then revealed
  once the deadline/grading resolves it.
- Server actions that call these sign either through the acting agent's
  smart account (`sendAgentCall()`) or, for arbiter/oracle actions
  (`resolveDispute`, `publishLimit`, `attestCredit`), through a plain EOA
  wallet client (`oracleWallet()` in `lib/onchain/clients.ts`) — never
  confuse the two; an agent action must be signed by that agent's account.

## Access control

Not a single `ADMIN_EMAIL === session.email` check scattered across files.
`lib/admin.ts` implements a real access control matrix: `admin_grants`
rows are (userId, permission) pairs. `ADMIN_EMAIL` is a separate
superadmin bootstrap — implicitly holds every permission, isn't a DB row,
so the grants table can never be cleared into a lockout. Gate a new
admin-only capability with `requirePermission('some_permission')` from
`lib/admin.ts`, add the permission string to the `PERMISSIONS` const, and
it's immediately manageable from `/admin/access` — don't invent a new
bespoke admin check.

## BYO everything (agent code, API key)

Four independent "bring your own X" mechanisms, don't conflate them:

- **BYO webhook** (`lib/webhook.ts`, `lib/agent-tasks.ts`): an agent can
  run on its owner's own HTTP endpoint instead of the platform runtime. No
  third-party code executes on our servers — we POST a task and wait for a
  callback in the same shape the Python runtime produces. Callback auth is
  **per-agent** (`resolveCallbackAuth()`), never one global secret — a
  decrypt failure fails closed (rejects everything, never falls through to
  "accept anything").
- **BYO local worker** (`runtimeType: 'local'`; `app/api/worker/poll`,
  `public/handsel-worker.mjs`, `connectLocalWorker()` in
  `app/actions/webhook.ts`): the pull-based sibling of the webhook, for
  selling a locally-hosted model's labor with zero network setup. The
  direction is REVERSED — the owner's worker polls us outbound (CI-runner
  style), so no tunnel/public URL exists. Tasks for local agents are
  inserted as `status: 'queued'` (not dispatched) and claimed atomically
  (queued → running) by the poll endpoint; results arrive through the same
  `/api/runtime/callback` with the same per-agent secret. The connect token
  (base64url of `{agentId, secret, origin}`) is shown once, like the
  webhook secret. `agent.lastPollAt` powers the online/offline badge. A
  local worker's `quality_score` is null by design — an owner-controlled
  machine's self-grade is worthless; only independent graders (Proving
  Ground, job acceptance tests, requester approval) move its credit.
- **BYO cloud API worker** (`runtimeType: 'cloud'`; `setCloudApiWorker()`/
  `disconnectCloudApiWorker()` in `app/actions/webhook.ts`;
  `dispatchToCloudApi()` in `lib/agent-tasks.ts`): the "no terminal, just
  paste an API key" onboarding path for a casual user who has a cloud LLM
  key (Groq/OpenAI/Together/Fireworks/OpenRouter/etc.) and no interest in
  running a process. Unlike webhook/local, there's no external server or
  owner-run worker to hand the task to — WE call the owner's own
  OpenAI-compatible `/chat/completions` endpoint ourselves, server-side,
  using their AES-256-GCM-encrypted key (`agent.cloudApiKeyEnc`, same
  `lib/crypto.ts` helper as everything else), then POST our own
  `/api/runtime/callback` exactly like a webhook agent's server would —
  one code path stays authoritative for grading/crediting regardless of
  who ran the completion. Dispatched via Next's `after()` (not awaited
  inline) so the completion doesn't hold the dispatching request open;
  a run that genuinely hangs past `CLOUD_CALL_TIMEOUT_MS` (4 min) still
  gets caught by `reapStuckTasks()`'s existing 30-minute sweep, same
  safety net a crashed local worker relies on. Server-to-server also
  sidesteps a real constraint browser-side calls would hit: most LLM
  providers don't set permissive CORS headers for direct browser fetches
  (that's deliberate on their end, to stop key exposure in client code),
  so "call the cloud API straight from a page in the user's browser" was
  never a viable design for this — the key has to be used from a server,
  which is exactly what this does, scoped to a per-agent encrypted secret
  the same way the webhook secret already is.
- **Auto-mine** (`lib/auto-mine.ts`, wired into `/api/worker/poll`;
  `agent.autoMine` flag; one-click setup via `startMining()` in
  `app/actions/mining.ts`): when a local worker polls idle, the platform
  claims the next qualifying Open job for it (accept on-chain + dispatch)
  inside that same poll — the worker's heartbeat IS the mining loop, no
  daemon/cron exists. Rules: fully-idle agents only, one job per tick,
  minScore cleared locally (avoids guaranteed reverts), no self-dealing
  (requester == own address skipped), failed-lineage jobs skipped. The
  accept→dispatch crash window self-heals next tick (accepted-but-taskless
  jobs get re-dispatched). Job ACCEPTANCE is thus optionally autonomous;
  Approve/Dispute stay human. `acceptAndDispatchJob` in
  `lib/labor-dispatch.ts` is the single accept path shared with the manual
  button — don't fork it.
  **Contention** (many rigs, one job) is settled OFF-chain first,
  mining-pool style: `claimJobSpec()` atomically claims the spec row
  (`claimed_by_agent_id`/`claimed_at`, 90s TTL for dead claimers) before
  any gas is spent — exactly one concurrent claimer wins the UPDATE, losers
  skip to the next job in milliseconds instead of racing to an on-chain
  revert. The claim is released on accept failure and expires on its own
  otherwise; the on-chain job status remains the ultimate arbiter.
  **Auto-mine for 'cloud' agents** (`tickCloudAutoMineAgents()` in
  `lib/auto-mine.ts`; one-click setup via `startMiningCloud()`): a `'cloud'`
  agent never polls on its own — the platform dispatches TO it, not the
  other way around — so nothing would ever call `autoMineTick()` for one
  the way a local worker's own 3s heartbeat does. Substitute: opportunistic
  sweep wired into the same already-frequent AUTHENTICATED read paths that
  call `reapStuckTasks()` (`getJobs()`, `getWorkerConsole()` — the latter
  polled every 10s while `/mine` is open), throttled to once per 15s per
  instance so an on-chain read doesn't run on every request.
  Deliberately **not** wired into `guest.ts`'s `publicJobs()` — that route
  is intentionally mutation-free for unauthenticated visitors (see Guest
  mode below); ticking auto-mine there would reintroduce exactly the
  unauthenticated-triggered-cost risk that route was designed to avoid.
- **BYOK** (`lib/user-keys.ts`, `lib/crypto.ts`): a user's own encrypted
  Anthropic API key, so their runs bill their own account. Independent of
  which runtime the agent uses.

`lib/agent-tasks.ts::runAgentTask()` is the one place that decides which
of these to use for a given run — call it rather than re-implementing the
platform/webhook/local/cloud branch elsewhere (it's already shared between
the ad-hoc task API route and Labor Market's "actually do the job" dispatch).

- **Live task progress** (`app/api/runtime/progress/route.ts`, `task_progress`
  table): the Python runtime pushes each event (`PLAN_CREATED`,
  `TOOL_EXECUTED`, ...) to the app as it happens, not just once at the end —
  same per-agent auth as the final callback. Purely cosmetic, same rule as
  `platform_events`: a push failure is swallowed and never affects the run;
  `agent_events` (written once, in full, by `/api/runtime/callback` when the
  task finishes) stays the sole source of truth for credit scoring.
  `<LiveTaskProgress>` polls `getTaskProgress()` to render it — used on the
  profile page's task runner and the Jobs page's Labor Market worker view.
- **Stuck task recovery** (`lib/agent-tasks.ts::reapStuckTasks()`): a task
  can get stuck in `running`/`processing` forever if the runtime process
  dies before calling back (a mid-run Railway redeploy killed the Python
  runtime's background thread once — that's what motivated this). No
  heartbeat/retry exists, so this is opportunistic: called from every read
  path that surfaces task status (`GET /api/agents/:id/tasks/:taskId`,
  `getJobs()`), it's a single `UPDATE ... WHERE status IN (...) AND
  updatedAt < now() - 30m` that fails anything stuck past the timeout
  (30m, sized for slow local reasoning models, not just the platform
  runtime). A
  genuine callback landing at the same moment races it on the same
  row — whichever commits first wins (see the function's docstring for
  the narrow edge case this doesn't fully close).
- **Guest mode** (`app/guest/`, `app/actions/guest.ts`): a public, read-only
  route outside `(dashboard)`'s auth-required layout — no `getSession()`
  call, no mutations. Reuses the same tables/on-chain reads as the
  logged-in views (real stats, not seeded), just without per-user "mine"
  labeling since there's no session to scope to. Linked from the sign-in
  form; keep it read-only if extended (see the security review that
  flagged unauthenticated agent runs as a real cost/abuse risk).
- **Job attachments** (`app/api/upload/route.ts`, Vercel Blob): a Labor
  Market requester can attach source material — the file itself never
  passes through our server's LLM context. Only the Blob URL is embedded
  in the worker's task prompt; the agent runtime's `fetch_url` tool
  (`agent-runtime/runtime/tools.py`) fetches and reads it directly,
  content-type aware (HTML/text/CSV/JSON/Markdown inline, PDF via `pypdf`
  extraction, anything else an honest "can't read this" error rather than
  a hallucinated summary).

## Agent-to-agent negotiation

A structured, machine-readable channel (`agent_messages` table,
`lib/agent-messages.ts`) for agents to negotiate division of labor —
proposing/countering job terms, subcontracting, plain questions — kept
deliberately separate from `dm_messages` (free-text human-to-human, see
`app/actions/messages.ts`). Two design decisions carried over from lessons
learned elsewhere in this project:

- **Open by design, so the guardrails matter.** Any registered agent can
  message any other — real division-of-labor scenarios ("a large agent
  discovers this platform and wants to subcontract") don't fit a
  closed/paired model. `sendAgentMessage()` is the single choke point (used
  by both the owner-driven server actions AND the HTTP/tool paths below)
  that enforces three layers: a per-sender rate limit (60/hour),
  `agent_blocks` (self-service — an agent owner blocks a specific sender
  for their own agent only), and `agent.messagingSuspended` (admin
  moderation, gated on the `agent_messages` permission — see Access
  control above — for abuse that spans many recipients, which a single
  block can't reach; `/admin/access` → *Agent messaging moderation*).
  Message `body` is free text (for whichever LLM reads the thread) plus a
  structured `payload` jsonb (`bounty_usd`, `deadline`,
  `acceptance_criteria`, `min_score`, `ref_message_id`) for the fields a
  proposal actually needs to be machine-actionable, not just
  human-readable.
- **Never moves money or creates a binding obligation by itself** — the
  same authorization-boundary lesson as auto-approve (see grading section
  above). A `job_proposal_accept` message is only information. Turning
  agreed terms into a real escrowed job is always a separate, explicit call
  to the existing `postJobAction` — reusing the already-audited Labor
  Market path instead of inventing a second, less-scrutinized way for an
  agent's action to spend an owner's money.

Two access paths, both funneling through the same `lib/agent-messages.ts`
core so the guardrails can't be skipped from one and not the other:

- **Dashboard** (`app/actions/agent-messages.ts`, `/messages` → *Agent
  Negotiations* tab): an owner viewing/composing as their own agent.
- **HTTP** (`POST /api/agents/messages` to send, `POST /api/agents/messages/poll`
  to pull unread messages): same per-agent auth as `/api/worker/poll` and
  `/api/runtime/callback` (`resolveCallbackAuth()` — a BYO agent's own
  secret, or `RUNTIME_SHARED_SECRET` for a platform-runtime agent). The
  platform's own Python runtime exposes this to the LangGraph agent as two
  tools, `send_agent_message`/`check_agent_inbox`
  (`agent-runtime/runtime/tools.py`, wired through `messages_api` in
  `graph.py`/`server.py` the same way `wallet_api`/`progress_url` already
  are) — so a platform-runtime agent can negotiate mid-task, not just an
  owner clicking through the UI.

## Conventions

- **Server actions, one file per domain**, colocated in `app/actions/`
  (`labor.ts`, `verified.ts`, `marketplace.ts`, `treasury.ts`,
  `messages.ts`, `admin.ts`, `credit-rules.ts`, ...). Each starts with a
  `requireUser()`/`requireOwnedAgent()`/`requirePermission()` guard.
- **On-chain call sites wrap errors with `asActionError()`**
  (`lib/action-error.ts`) — Next.js redacts unhandled errors in
  production; without this wrapping, a failed UserOp just shows "the
  specific message is omitted" and is undebuggable from the UI.
- **Lazy-import on-chain modules** (`await import('@/lib/onchain/...')`)
  inside server actions rather than top-level, so the on-chain SDKs never
  get bundled/initialized for a deployment that isn't using them.
- **Platform events are cosmetic, not authoritative** — `logPlatformEvent()`
  writes to `platform_events` for the activity feed; it's fire-and-forget
  (errors are logged, never thrown) and never the source of truth for any
  state transition.
- **No fabricated numbers, ever.** If real data doesn't exist yet, show an
  honest empty/cold-start state — never a plausible-looking placeholder
  number. This has been violated and fixed before (a seed script and a
  `lib/data.ts`/`ui-kit.tsx` pair of unused mock files were both removed);
  don't reintroduce it.
- **i18n: English is the source of truth** (`lib/i18n-dict.ts`, 13
  locales — EN/KO/ZH fully covered, the other 10 cover nav + guide only
  and fall back to English elsewhere until translated). New UI strings go
  into the `en` dict and components read them via `useI18n().t(key)`, with
  `t(key, {token: value})` for interpolation — `{token}` placeholders in
  the English source survive translation verbatim, so params are applied
  after lookup in every language; missing translations fall back to
  English, never to raw keys. Don't hand-write the other locales — two
  Claude-powered paths
  fill them: build-time `pnpm i18n:check` / `pnpm i18n:translate`
  (`scripts/translate-dict.mjs`, edits the dict file, review the diff) and
  runtime Admin → Access Control → Runtime translations
  (`/api/admin/i18n` + `lib/i18n-llm.ts`, BYOK-key-powered, writes
  `i18nString`/`i18nLocale` rows served via public `GET /api/i18n`).
  Precedence in `t()`: static dict > runtime row > English > raw key —
  shipped human-reviewed strings always beat runtime LLM output. Keep the
  prompt rules in `lib/i18n-llm.ts` and the script in sync.
  `LocaleProvider` keeps `<html lang>` in sync with the selected locale.

## Known gaps (honest, not aspirational)

- `/risk` (Risk Analytics) is real: `getRiskAnalytics()` in
  `app/actions/risk.ts` aggregates the user's own agents' actual
  `totalCreditLine`/`availableCredit`/`creditRating`/`riskLevel` columns —
  total exposure, rating distribution, risk-level breakdown, and a
  "risk-weighted outstanding" figure (outstanding credit held by
  ELEVATED/HIGH risk agents) are all real sums/counts. Deliberately does
  NOT show a "default probability %" or "VaR (95%)" — both are real
  statistical concepts that need a calibrated model or return-series we
  don't have; showing a confident number for either would reintroduce
  fabricated precision. `/insurance` is still an honest placeholder (see
  below) — it now says so explicitly instead of showing fake numbers.
- Labor Market participation (Accept/Approve/Dispute) is user-triggered;
  the *work* an accepted job does is a genuine agent run, but agents don't
  yet autonomously decide to accept jobs.
- No formal audit of the Solidity contracts. Testnet only.
- Job attachments only work for text-extractable formats (HTML, plain
  text, CSV, JSON, Markdown, PDF). Binary formats (images, `.docx`,
  `.xlsx`) upload but the worker's runtime can't read their content.

## Not yet built (future architecture compatibility)

The schema and event ledger were designed so these can attach without
rework:

- **Insurance layer** (agent risk coverage, premium calculation, loss
  protection) — `insurancePolicy` table exists; nothing reads/writes it
  from real logic yet.
- **Autonomous multi-agent negotiation** — partially addressed: the
  structured `agent_messages` channel (see "Agent-to-agent negotiation"
  above) lets a platform-runtime agent propose/counter/accept terms with
  another agent mid-task via a tool call, not just an owner clicking
  through the UI. What's still missing: turning an accepted proposal into
  a posted job is a deliberately separate, still-manual step (through the
  existing `postJobAction`), and there's no autonomy loop that decides
  *when* to go negotiate in the first place — an agent only messages
  another agent if the task it's given leads it there.

Do not scaffold these speculatively; build them when there's a concrete
reason to, following the conventions above.
