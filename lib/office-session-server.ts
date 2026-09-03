/**
 * Storage, observation and side effects for office sessions.
 *
 * The pure halves decide everything (lib/office-session.ts is the state,
 * lib/office-session-loop.ts the decisions, lib/approval-policy.ts the
 * money rules). This file is what touches the world:
 *
 *   - the tables (self-migrating, side tables only — never a column on
 *     `agent`; lib/office.ts's header says why);
 *   - `appendEvents`: the one write path. Row-locked per session, idempotent
 *     on the event key, invariant-checked before commit. A tick, a worker
 *     report and an owner's click all go through it, so they serialise;
 *   - the observation a tick needs: which workers are alive, what the chain
 *     says about escrow tasks, what the office spent today;
 *   - the commands a tick emits: hand a run to a worker, ask a reviewer,
 *     post an escrow job, flip an approved job's autoApprove and let the
 *     existing release site pay it, write the office's session memory;
 *   - the worker protocol: the run handed out on `/api/worker/poll`, the
 *     reports that ride on the same poll, the finish report.
 *
 * Money never leaves from here. `settle_escrow` sets `jobSpec.autoApprove`
 * and calls lib/labor-settle.ts's `autoApprovePassedJob`, which is the one
 * release site every other path uses, with its on-chain status check, its
 * peer-review hold and its cap intact. The session only decides WHEN that
 * site may say yes.
 */
import { pool, db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  DEFAULT_WORKSPACE_GRANT,
  STATUS_META,
  applyEvent,
  eventKey,
  initialState,
  narrowGrant,
  replay,
  sessionInvariants,
  type ApprovalRecord,
  type Checkpoint,
  type NewEvent,
  type OfficeSession,
  type SessionCreatedPayload,
  type SessionEvent,
  type SessionEventType,
  type SessionKind,
  type SessionSchedule,
  type SessionState,
  type SessionTask,
  type TestReport,
  type WorkspaceGrant,
} from '@/lib/office-session'
import {
  latestCheckpoint,
  learnFromSession,
  renderLessons,
  tickSession,
  workerHistoryFrom,
  type Command,
  type Observation,
  type SessionLesson,
  type WorkerCandidate,
} from '@/lib/office-session-loop'
import { DEFAULT_APPROVAL_POLICY, parsePolicy, type ApprovalPolicy } from '@/lib/approval-policy'
import { triggerMatches } from '@/lib/session-triggers'
import {
  MAX_BINDINGS_PER_OFFICE,
  MAX_CONSULT_BYTES,
  TOOL_CALL_TIMEOUT_MS,
  consultQuery,
  notifyText,
  parseBinding,
  renderConsult,
  type BindingInput,
  type SessionToolBinding,
} from '@/lib/session-tools'
import { defaultPlan, planFromSubtasks } from '@/lib/office-session-plan'
import { MAX_PER_WAVE, morningReport, triageIssues, type RepoCareSettings, type Triage } from '@/lib/repo-care'
import { SESSION_DELIVERABLE_PATH, redactSecrets, remoteRunBrief, sessionRunBrief, type HarnessEvent } from '@/lib/coding-harness'
import type { CompleteFn } from '@/lib/delegation'

/* ── Tables ───────────────────────────────────────────────────────────── */

let ready: Promise<void> | null = null
async function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session (
           id text PRIMARY KEY,
           user_id text NOT NULL,
           slot integer NOT NULL,
           kind text NOT NULL,
           goal text NOT NULL,
           status text NOT NULL,
           status_reason text,
           priority integer NOT NULL DEFAULT 0,
           next_wake_at timestamptz,
           deadline_at timestamptz,
           budget_limit_usd numeric NOT NULL DEFAULT 0,
           spent_usd numeric NOT NULL DEFAULT 0,
           worker_agent_id text,
           version integer NOT NULL DEFAULT 0,
           state jsonb NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_owner ON office_session (user_id, slot, created_at DESC)`)
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_wake ON office_session (next_wake_at) WHERE next_wake_at IS NOT NULL`)
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_event (
           seq bigserial PRIMARY KEY,
           id text NOT NULL,
           session_id text NOT NULL,
           type text NOT NULL,
           occurred_at timestamptz NOT NULL,
           actor_type text NOT NULL,
           actor_id text,
           payload jsonb NOT NULL DEFAULT '{}',
           idempotency_key text NOT NULL UNIQUE
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_event_session ON office_session_event (session_id, seq)`)
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_dispatch (
           run_id text PRIMARY KEY,
           session_id text NOT NULL,
           task_id text NOT NULL,
           agent_id text NOT NULL,
           status text NOT NULL DEFAULT 'queued',
           brief text NOT NULL,
           workspace_grant jsonb NOT NULL,
           verify_command text,
           resume jsonb,
           timeout_ms integer NOT NULL,
           harness_id text,
           created_at timestamptz NOT NULL DEFAULT now(),
           claimed_at timestamptz,
           finished_at timestamptz
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_dispatch_agent ON office_session_dispatch (agent_id, status, created_at)`)
      // Added after the first deploy: a paused session stops its live harness
      // process on the worker (SIGSTOP), and the poll carries this flag there.
      await pool.query(`ALTER TABLE office_session_dispatch ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false`)
      // A run on a cloud / MCP / webhook worker is an agent_tasks row the
      // platform dispatched itself (status 'remote'); the poll never hands it
      // out, and its result arrives on /api/runtime/callback.
      await pool.query(`ALTER TABLE office_session_dispatch ADD COLUMN IF NOT EXISTS agent_task_id text`)
      // What this office talks to outside itself (lib/session-tools.ts). The
      // auth header, when there is one, is encrypted like every other
      // outbound credential and never leaves this module in the clear.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_tool (
           id text PRIMARY KEY,
           user_id text NOT NULL,
           slot integer NOT NULL,
           session_id text,
           label text NOT NULL,
           server_url text NOT NULL,
           tool_name text NOT NULL,
           purpose text NOT NULL,
           events jsonb NOT NULL DEFAULT '[]'::jsonb,
           auth_header_enc text,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_tool_owner ON office_session_tool (user_id, slot)`)
      // Repo Care (lib/repo-care.ts): the backlog one session looks after.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_repo_care (
           session_id text PRIMARY KEY,
           user_id text NOT NULL,
           repo_full_name text NOT NULL,
           labels jsonb NOT NULL DEFAULT '[]'::jsonb,
           max_per_wave integer NOT NULL DEFAULT 3,
           verify_command text,
           open_prs boolean NOT NULL DEFAULT true,
           base_branch text,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_run_log (
           id bigserial PRIMARY KEY,
           session_id text NOT NULL,
           run_id text NOT NULL,
           at timestamptz NOT NULL,
           kind text NOT NULL,
           text text NOT NULL,
           path text
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS office_session_run_log_run ON office_session_run_log (run_id, id)`)
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_policy (
           user_id text NOT NULL,
           slot integer NOT NULL,
           policy jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, slot)
         )`,
      )
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_session_memory (
           user_id text NOT NULL,
           slot integer NOT NULL,
           lessons jsonb NOT NULL DEFAULT '[]',
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, slot)
         )`,
      )
      await pool.query(
        `CREATE TABLE IF NOT EXISTS office_worker_grant (
           agent_id text PRIMARY KEY,
           user_id text NOT NULL,
           slot integer NOT NULL,
           workspace_grant jsonb NOT NULL,
           verify_command text,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
    })()
      .then(() => undefined)
      .catch((e) => {
        ready = null // not cached on failure, or every later call believes it exists
        throw e
      })
  }
  return ready
}

/* ── Event log ────────────────────────────────────────────────────────── */

const newId = (prefix: string) => `${prefix}-${nanoid(12)}`

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`office session ${id} not found`)
  }
}

export class InvariantViolation extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly violations: string[],
  ) {
    super(`office session ${sessionId} would violate: ${violations.join('; ')}`)
  }
}

type SessionRow = { id: string; user_id: string; slot: number; version: number; state: SessionState }

/** Load the materialized state. Falls back to replay when the row's JSON is unreadable. */
export async function loadSessionState(sessionId: string): Promise<SessionState> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow>(`SELECT id, user_id, slot, version, state FROM office_session WHERE id = $1`, [sessionId])
  const row = rows[0]
  if (!row) throw new SessionNotFound(sessionId)
  if (row.state && typeof row.state === 'object' && row.state.session && row.state.version === row.version) return row.state
  return replaySession(sessionId)
}

/** The truth: rebuild from the log alone. */
export async function replaySession(sessionId: string): Promise<SessionState> {
  await ensureTables()
  const { rows } = await pool.query<{
    id: string
    type: SessionEventType
    occurred_at: Date
    actor_type: SessionEvent['actorType']
    actor_id: string | null
    payload: Record<string, unknown>
    idempotency_key: string
  }>(`SELECT id, type, occurred_at, actor_type, actor_id, payload, idempotency_key FROM office_session_event WHERE session_id = $1 ORDER BY seq ASC`, [sessionId])
  if (rows.length === 0) throw new SessionNotFound(sessionId)
  return replay(
    rows.map((r) => ({
      id: r.id,
      sessionId,
      type: r.type,
      occurredAt: r.occurred_at.getTime(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      payload: r.payload ?? {},
      idempotencyKey: r.idempotency_key,
    })),
  )
}

/** Materialized row vs replay — the integrity check a doctor page or a test runs. */
export async function verifySessionIntegrity(sessionId: string): Promise<{ ok: boolean; materializedVersion: number; replayedVersion: number; violations: string[] }> {
  const replayed = await replaySession(sessionId)
  const { rows } = await pool.query<{ version: number }>(`SELECT version FROM office_session WHERE id = $1`, [sessionId])
  const materializedVersion = rows[0]?.version ?? -1
  const violations = sessionInvariants(replayed)
  return { ok: materializedVersion === replayed.version && violations.length === 0, materializedVersion, replayedVersion: replayed.version, violations }
}

function materialize(client: { query: typeof pool.query }, state: SessionState): Promise<unknown> {
  const s = state.session
  return client.query(
    `UPDATE office_session SET status = $2, status_reason = $3, next_wake_at = $4, deadline_at = $5, budget_limit_usd = $6, spent_usd = $7,
        worker_agent_id = $8, version = $9, state = $10::jsonb, priority = $11, updated_at = now()
      WHERE id = $1`,
    [
      s.id,
      s.status,
      s.statusReason,
      s.nextWakeAt === null ? null : new Date(s.nextWakeAt),
      s.deadlineAt === null ? null : new Date(s.deadlineAt),
      s.budgetLimitUsd,
      s.spentUsd,
      s.workerAgentId,
      state.version,
      JSON.stringify(state),
      s.priority,
    ],
  )
}

/**
 * Append events. Serialised per session by a row lock; duplicates (by
 * idempotency key) are skipped, and the batch is refused whole if the
 * resulting state breaks an invariant. Returns the state after the batch.
 */
export async function appendEvents(sessionId: string, events: readonly NewEvent[]): Promise<SessionState> {
  await ensureTables()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<SessionRow>(`SELECT id, user_id, slot, version, state FROM office_session WHERE id = $1 FOR UPDATE`, [sessionId])
    const row = rows[0]
    if (!row) throw new SessionNotFound(sessionId)
    let state: SessionState = row.state && row.state.version === row.version ? row.state : await replaySession(sessionId)
    let changed = false
    for (const e of events) {
      const full: SessionEvent = {
        id: newId('ev'),
        sessionId,
        type: e.type,
        occurredAt: e.occurredAt,
        actorType: e.actorType,
        actorId: e.actorId,
        payload: e.payload,
        idempotencyKey: e.idempotencyKey ?? eventKey(sessionId, e.type, `${e.occurredAt}:${nanoid(6)}`),
      }
      if (state.applied.includes(full.idempotencyKey)) continue
      const next = applyEvent(state, full)
      if (next === state) continue
      const violations = sessionInvariants(next)
      if (violations.length) throw new InvariantViolation(sessionId, violations)
      const ins = await client.query(
        `INSERT INTO office_session_event (id, session_id, type, occurred_at, actor_type, actor_id, payload, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (idempotency_key) DO NOTHING`,
        [full.id, sessionId, full.type, new Date(full.occurredAt), full.actorType, full.actorId, JSON.stringify(full.payload), full.idempotencyKey],
      )
      if (ins.rowCount === 0) continue // written by a concurrent path already folded into the row we hold
      state = next
      changed = true
    }
    if (changed) await materialize(client, state)
    await client.query('COMMIT')
    return state
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

/* ── Create / list / read ─────────────────────────────────────────────── */

export type CreateSessionInput = {
  userId: string
  slot: number
  kind: SessionKind
  goal: string
  budgetLimitUsd: number
  deadlineAt?: number | null
  schedule?: SessionSchedule | null
  triggers?: string[]
  workerAgentId?: string | null
  payerAgentId?: string | null
  workspace?: WorkspaceGrant | null
  verifyCommand?: string | null
  priority?: number
}

export async function createOfficeSession(input: CreateSessionInput): Promise<OfficeSession> {
  await ensureTables()
  const id = newId('oses')
  const now = Date.now()
  const memory = await getSessionMemory(input.userId, input.slot).catch(() => [] as SessionLesson[])
  const payload: SessionCreatedPayload = {
    userId: input.userId,
    officeSlot: input.slot,
    kind: input.kind,
    goal: input.goal,
    budgetLimitUsd: input.budgetLimitUsd,
    deadlineAt: input.deadlineAt ?? null,
    schedule: input.schedule ?? null,
    triggers: input.triggers ?? [],
    workerAgentId: input.workerAgentId ?? null,
    payerAgentId: input.payerAgentId ?? null,
    workspace: input.workspace ?? null,
    verifyCommand: input.verifyCommand ?? null,
    priority: input.priority ?? 0,
    approvalPolicyId: 'office',
    memoryRulesUsed: memory.map((l) => l.kind),
  }
  const created: SessionEvent = {
    id: newId('ev'),
    sessionId: id,
    type: 'SESSION_CREATED',
    occurredAt: now,
    actorType: 'user',
    actorId: input.userId,
    payload: payload as unknown as Record<string, unknown>,
    idempotencyKey: eventKey(id, 'SESSION_CREATED', 'create'),
  }
  const state = initialState(created)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO office_session (id, user_id, slot, kind, goal, status, status_reason, priority, next_wake_at, deadline_at, budget_limit_usd, spent_usd, worker_agent_id, version, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14::jsonb)`,
      [
        id,
        input.userId,
        input.slot,
        input.kind,
        state.session.goal,
        state.session.status,
        null,
        state.session.priority,
        new Date(now),
        input.deadlineAt ? new Date(input.deadlineAt) : null,
        input.budgetLimitUsd,
        input.workerAgentId ?? null,
        state.version,
        JSON.stringify(state),
      ],
    )
    await client.query(
      `INSERT INTO office_session_event (id, session_id, type, occurred_at, actor_type, actor_id, payload, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [created.id, id, created.type, new Date(now), created.actorType, created.actorId, JSON.stringify(created.payload), created.idempotencyKey],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
  return state.session
}

/**
 * Repo Care in one call: a scheduled session whose plan comes from the
 * repository's backlog instead of its goal (lib/repo-care.ts). Everything
 * else is an ordinary session — same policy, same grants, same approvals —
 * which is the point: the vertical is a configuration of the runtime, not a
 * second runtime.
 */
export async function startRepoCareSession(input: {
  userId: string
  slot: number
  workerAgentId: string
  care: RepoCareSettings
  budgetLimitUsd: number
  everyMinutes: number
}): Promise<{ ok: true; session: OfficeSession } | { ok: false; error: string }> {
  const grant = await getWorkerGrant(input.workerAgentId)
  if (!grant || grant.userId !== input.userId) return { ok: false, error: 'that worker has no workspace grant on this account — connect it with a working directory first' }
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.care.repoFullName)) return { ok: false, error: 'repo must be owner/name' }
  const { repoCareGoal } = await import('@/lib/repo-care')
  const care: RepoCareSettings = { ...input.care, verifyCommand: input.care.verifyCommand ?? grant.verifyCommand }
  const session = await createOfficeSession({
    userId: input.userId,
    slot: input.slot,
    kind: 'scheduled',
    goal: repoCareGoal(care),
    budgetLimitUsd: input.budgetLimitUsd,
    schedule: { kind: 'interval', everyMs: Math.max(15, input.everyMinutes) * 60_000 },
    workerAgentId: input.workerAgentId,
    workspace: grant.grant,
    verifyCommand: care.verifyCommand,
  })
  await setRepoCare(session.id, input.userId, care)
  await tickOfficeSession(session.id).catch((e) => console.error('[office-session] repo-care first tick failed:', e))
  await tickOfficeSession(session.id).catch((e) => console.error('[office-session] repo-care second tick failed:', e))
  return { ok: true, session }
}

/**
 * The morning report for a Repo Care session: what landed, what needs a
 * decision, what failed, what was left for a person. Assembled per read
 * from the session state, so it cannot go stale.
 */
export async function repoCareReport(userId: string, sessionId: string): Promise<string | null> {
  const state = await ownedSession(userId, sessionId)
  const care = await getRepoCare(sessionId)
  if (!care) return null
  const wave = state.session.wave
  const lines = Object.values(state.tasks)
    .filter((t) => t.wave === wave)
    .map((t) => {
      const pr = Object.values(state.artifacts).find((a) => a.taskId === t.id && a.name.startsWith('pr-'))
      const open = Object.values(state.approvals).some((a) => a.taskId === t.id && a.decidedAt === null)
      return {
        taskId: t.id,
        title: t.title,
        status: t.status,
        statusReason: t.statusReason,
        testsPassed: t.outcome?.tests ? t.outcome.tests.passed : null,
        changedFiles: t.outcome?.changedFiles.length ?? 0,
        prUrl: pr?.ref ?? null,
        needsYou: open,
      }
    })
  const triage = Object.values(state.artifacts).find((a) => a.taskId === null && a.name.startsWith('left-for-a-person'))
  const cost = Object.values(state.runs).reduce((n, r) => n + (r.costUsd ?? 0), 0)
  return [
    morningReport({ repoFullName: care.repoFullName, lines, skipped: [], costUsd: cost || null }),
    ...(triage?.inline ? ['', '## Left for a person', '', triage.inline] : []),
  ].join('\n')
}

export type SessionListRow = Pick<OfficeSession, 'id' | 'kind' | 'goal' | 'status' | 'statusReason' | 'nextWakeAt' | 'budgetLimitUsd' | 'spentUsd' | 'createdAt' | 'wave' | 'officeSlot' | 'lastHeartbeatAt'> & {
  openApprovals: number
  liveRuns: number
  tasksDone: number
  tasksTotal: number
  tasksFailed: number
  /** Attempts beyond the first, summed over the wave — what "retries" means on the strip. */
  retries: number
  /** The task the loop is on right now, and who has it. */
  currentTask: { id: string; title: string; status: string; workerAgentId: string | null; attempt: number } | null
  /** What the loop will do next, in the status table's words. */
  nextStep: string
  lastArtifact: { kind: string; name: string; at: number; sha256: string } | null
  memoryRulesUsed: number
}

export async function listOfficeSessions(userId: string, slot?: number, limit = 50): Promise<SessionListRow[]> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, user_id, slot, version, state FROM office_session WHERE user_id = $1 ${slot !== undefined ? 'AND slot = $3' : ''} ORDER BY created_at DESC LIMIT $2`,
    slot !== undefined ? [userId, limit, slot] : [userId, limit],
  )
  return rows.map((r) => {
    const st = r.state
    const tasks = Object.values(st.tasks ?? {}).filter((t) => t.wave === st.session.wave)
    const current =
      (st.session.currentNodeId ? st.tasks[st.session.currentNodeId] : undefined) ??
      tasks.find((t) => t.status === 'running' || t.status === 'dispatched') ??
      tasks.find((t) => t.status === 'awaiting_approval' || t.status === 'verifying' || t.status === 'submitted') ??
      null
    const artifacts = Object.values(st.artifacts ?? {}).sort((a, b) => b.createdAt - a.createdAt)
    return {
      lastHeartbeatAt: st.session.lastHeartbeatAt,
      tasksFailed: tasks.filter((t) => t.status === 'failed').length,
      retries: tasks.reduce((n, t) => n + Math.max(0, t.attempts - 1), 0),
      currentTask: current ? { id: current.id, title: current.title, status: current.status, workerAgentId: current.assignedWorkerId, attempt: current.attempts } : null,
      nextStep: STATUS_META[st.session.status].onHeartbeat,
      lastArtifact: artifacts[0] ? { kind: artifacts[0].kind, name: artifacts[0].name, at: artifacts[0].createdAt, sha256: artifacts[0].sha256 } : null,
      memoryRulesUsed: st.session.memoryRulesUsed.length,
      id: st.session.id,
      kind: st.session.kind,
      goal: st.session.goal,
      status: st.session.status,
      statusReason: st.session.statusReason,
      nextWakeAt: st.session.nextWakeAt,
      budgetLimitUsd: st.session.budgetLimitUsd,
      spentUsd: st.session.spentUsd,
      createdAt: st.session.createdAt,
      wave: st.session.wave,
      officeSlot: st.session.officeSlot,
      openApprovals: Object.values(st.approvals ?? {}).filter((a) => a.decidedAt === null && (a.policyOutcome === 'REQUIRE_OWNER' || a.policyOutcome === 'REQUIRE_REVIEWER')).length,
      liveRuns: Object.values(st.runs ?? {}).filter((x) => x.status === 'dispatched' || x.status === 'started' || x.status === 'running').length,
      tasksDone: tasks.filter((t) => t.status === 'settled').length,
      tasksTotal: tasks.length,
    }
  })
}

/** The session with its event log and run logs — the timeline page's read. */
export async function readOfficeSession(userId: string, sessionId: string): Promise<{ state: SessionState; events: SessionEvent[]; runLog: RunLogLine[] } | null> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow>(`SELECT id, user_id, slot, version, state FROM office_session WHERE id = $1`, [sessionId])
  const row = rows[0]
  if (!row || row.user_id !== userId) return null
  const state = row.state && row.state.version === row.version ? row.state : await replaySession(sessionId)
  const ev = await pool.query<{
    id: string
    type: SessionEventType
    occurred_at: Date
    actor_type: SessionEvent['actorType']
    actor_id: string | null
    payload: Record<string, unknown>
    idempotency_key: string
  }>(`SELECT id, type, occurred_at, actor_type, actor_id, payload, idempotency_key FROM office_session_event WHERE session_id = $1 ORDER BY seq DESC LIMIT 400`, [sessionId])
  const log = await pool.query<{ run_id: string; at: Date; kind: string; text: string; path: string | null }>(
    `SELECT run_id, at, kind, text, path FROM office_session_run_log WHERE session_id = $1 ORDER BY id DESC LIMIT 300`,
    [sessionId],
  )
  return {
    state,
    events: ev.rows
      .map((r) => ({
        id: r.id,
        sessionId,
        type: r.type,
        occurredAt: r.occurred_at.getTime(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        payload: r.payload,
        idempotencyKey: r.idempotency_key,
      }))
      .reverse(),
    runLog: log.rows.map((r) => ({ runId: r.run_id, at: r.at.getTime(), kind: r.kind, text: r.text, path: r.path })).reverse(),
  }
}

export type RunLogLine = { runId: string; at: number; kind: string; text: string; path: string | null }

async function ownedSession(userId: string, sessionId: string): Promise<SessionState> {
  const state = await loadSessionState(sessionId)
  if (state.session.userId !== userId) throw new SessionNotFound(sessionId)
  return state
}

/* ── Owner actions ────────────────────────────────────────────────────── */

const userEvent = (type: SessionEventType, payload: Record<string, unknown>, userId: string, key: string, sessionId: string): NewEvent => ({
  type,
  occurredAt: Date.now(),
  actorType: 'user',
  actorId: userId,
  payload,
  idempotencyKey: eventKey(sessionId, type, key),
})

export async function pauseOfficeSession(userId: string, sessionId: string, reason = 'paused by owner'): Promise<SessionState> {
  await ownedSession(userId, sessionId)
  const state = await appendEvents(sessionId, [userEvent('SESSION_PAUSED', { reason }, userId, `${Date.now()}`, sessionId)])
  // The live harness process pauses too: the worker SIGSTOPs it on its next
  // poll and SIGCONTs on resume. Nothing is dispatched meanwhile (the loop
  // returns early on `paused`), and the wall clock is not charged.
  await setDispatchesPaused(sessionId, true)
  return state
}

export async function resumeOfficeSession(userId: string, sessionId: string): Promise<SessionState> {
  await ownedSession(userId, sessionId)
  const state = await appendEvents(sessionId, [userEvent('SESSION_RESUMED', {}, userId, `${Date.now()}`, sessionId)])
  await setDispatchesPaused(sessionId, false)
  await tickOfficeSession(sessionId).catch((e) => console.error(`[office-session] tick after resume failed for ${sessionId}:`, e))
  return state
}

async function setDispatchesPaused(sessionId: string, paused: boolean): Promise<void> {
  await pool.query(`UPDATE office_session_dispatch SET paused = $2 WHERE session_id = $1 AND status IN ('queued', 'claimed')`, [sessionId, paused])
}

/** Run ids this worker holds that the owner paused — the poll's `session_pause` list. */
export async function pausedRunsFor(agentId: string): Promise<string[]> {
  await ensureTables()
  const { rows } = await pool.query<{ run_id: string }>(`SELECT run_id FROM office_session_dispatch WHERE agent_id = $1 AND status = 'claimed' AND paused`, [agentId])
  return rows.map((r) => r.run_id)
}

export async function cancelOfficeSession(userId: string, sessionId: string, reason = 'cancelled by owner'): Promise<SessionState> {
  const before = await ownedSession(userId, sessionId)
  const state = await appendEvents(sessionId, [userEvent('SESSION_CANCELLED', { reason }, userId, 'cancel', sessionId)])
  // Tell every live run to stop — the poll carries the cancel to the worker.
  for (const run of Object.values(before.runs)) {
    if (run.status === 'dispatched' || run.status === 'started' || run.status === 'running') await markDispatchCancelled(run.id)
  }
  return state
}

export async function raiseSessionBudget(userId: string, sessionId: string, budgetLimitUsd: number): Promise<SessionState> {
  await ownedSession(userId, sessionId)
  if (!Number.isFinite(budgetLimitUsd) || budgetLimitUsd < 0) throw new Error('budget must be a non-negative number')
  const state = await appendEvents(sessionId, [userEvent('BUDGET_RAISED', { budgetLimitUsd }, userId, `${budgetLimitUsd}:${Date.now()}`, sessionId)])
  await tickOfficeSession(sessionId).catch((e) => console.error(`[office-session] tick after budget raise failed for ${sessionId}:`, e))
  return state
}

/** The owner answers an approval the policy could not decide. */
export async function decideApproval(userId: string, sessionId: string, approvalId: string, granted: boolean, reason?: string): Promise<SessionState> {
  const state = await ownedSession(userId, sessionId)
  const approval = state.approvals[approvalId]
  if (!approval) throw new Error('no such approval')
  if (approval.decidedAt !== null) return state
  const next = await appendEvents(sessionId, [
    userEvent(
      granted ? 'APPROVAL_GRANTED' : 'APPROVAL_DENIED',
      { approvalId, decidedBy: 'owner', decidedById: userId, ...(reason ? { reason } : {}) },
      userId,
      approvalId,
      sessionId,
    ),
  ])
  await tickOfficeSession(sessionId).catch((e) => console.error(`[office-session] tick after approval failed for ${sessionId}:`, e))
  return next
}

/* ── Policy, memory, grants ───────────────────────────────────────────── */

export async function getOfficePolicy(userId: string, slot: number): Promise<ApprovalPolicy> {
  await ensureTables()
  const { rows } = await pool.query<{ policy: unknown }>(`SELECT policy FROM office_policy WHERE user_id = $1 AND slot = $2`, [userId, slot])
  if (!rows[0]) return { ...DEFAULT_APPROVAL_POLICY, id: 'office' }
  const parsed = parsePolicy(rows[0].policy)
  return parsed.ok ? parsed.policy : { ...DEFAULT_APPROVAL_POLICY, id: 'office' }
}

export async function setOfficePolicy(userId: string, slot: number, raw: unknown): Promise<{ ok: true; policy: ApprovalPolicy } | { ok: false; error: string }> {
  await ensureTables()
  const parsed = parsePolicy(raw)
  if (!parsed.ok) return parsed
  const current = await getOfficePolicy(userId, slot)
  const policy: ApprovalPolicy = { ...parsed.policy, id: 'office', version: Math.max(parsed.policy.version, current.version + 1) }
  await pool.query(
    `INSERT INTO office_policy (user_id, slot, policy) VALUES ($1, $2, $3::jsonb) ON CONFLICT (user_id, slot) DO UPDATE SET policy = $3::jsonb, updated_at = now()`,
    [userId, slot, JSON.stringify(policy)],
  )
  return { ok: true, policy }
}

export const MAX_SESSION_LESSONS = 30

export async function getSessionMemory(userId: string, slot: number): Promise<SessionLesson[]> {
  await ensureTables()
  const { rows } = await pool.query<{ lessons: SessionLesson[] }>(`SELECT lessons FROM office_session_memory WHERE user_id = $1 AND slot = $2`, [userId, slot])
  return Array.isArray(rows[0]?.lessons) ? rows[0].lessons : []
}

async function recordSessionMemory(state: SessionState, wave: number): Promise<SessionLesson[]> {
  const lessons = learnFromSession(state, wave).map((l) => ({ ...l, text: `${state.session.id}/w${wave}: ${l.text}` }))
  if (lessons.length === 0) return []
  await ensureTables()
  // Read-modify-write under the session row lock's neighbour: a per-office
  // advisory lock, so two sessions finishing at once do not clobber each
  // other's lessons (the office_memory writer has exactly that defect).
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`office_session_memory:${state.session.userId}:${state.session.officeSlot}`])
    const { rows } = await client.query<{ lessons: SessionLesson[] }>(`SELECT lessons FROM office_session_memory WHERE user_id = $1 AND slot = $2`, [
      state.session.userId,
      state.session.officeSlot,
    ])
    const existing = Array.isArray(rows[0]?.lessons) ? rows[0].lessons : []
    const merged = [...existing.filter((l) => !lessons.some((n) => n.text === l.text)), ...lessons].slice(-MAX_SESSION_LESSONS)
    await client.query(
      `INSERT INTO office_session_memory (user_id, slot, lessons) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, slot) DO UPDATE SET lessons = $3::jsonb, updated_at = now()`,
      [state.session.userId, state.session.officeSlot, JSON.stringify(merged)],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
  return lessons
}

export type WorkerGrantRow = { agentId: string; userId: string; slot: number; grant: WorkspaceGrant; verifyCommand: string | null }

/** The owner's grant for one of their local workers — set on connect, read on every dispatch. */
export async function setWorkerGrant(userId: string, agentId: string, slot: number, grant: WorkspaceGrant, verifyCommand: string | null): Promise<void> {
  await ensureTables()
  const [row] = await db.select({ id: agent.id, userId: agent.userId }).from(agent).where(eq(agent.id, agentId))
  if (!row || row.userId !== userId) throw new Error('not your agent')
  await pool.query(
    `INSERT INTO office_worker_grant (agent_id, user_id, slot, workspace_grant, verify_command) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (agent_id) DO UPDATE SET slot = $3, workspace_grant = $4::jsonb, verify_command = $5, updated_at = now()`,
    [agentId, userId, slot, JSON.stringify(grant), verifyCommand],
  )
}

export async function getWorkerGrant(agentId: string): Promise<WorkerGrantRow | null> {
  await ensureTables()
  const { rows } = await pool.query<{ agent_id: string; user_id: string; slot: number; grant: WorkspaceGrant; verify_command: string | null }>(
    `SELECT agent_id, user_id, slot, workspace_grant AS grant, verify_command FROM office_worker_grant WHERE agent_id = $1`,
    [agentId],
  )
  const r = rows[0]
  return r ? { agentId: r.agent_id, userId: r.user_id, slot: r.slot, grant: r.grant, verifyCommand: r.verify_command } : null
}

export async function workerGrantsFor(userId: string, slot: number): Promise<WorkerGrantRow[]> {
  await ensureTables()
  const { rows } = await pool.query<{ agent_id: string; user_id: string; slot: number; grant: WorkspaceGrant; verify_command: string | null }>(
    `SELECT agent_id, user_id, slot, workspace_grant AS grant, verify_command FROM office_worker_grant WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  return rows.map((r) => ({ agentId: r.agent_id, userId: r.user_id, slot: r.slot, grant: r.grant, verifyCommand: r.verify_command }))
}

/* ── Observation ──────────────────────────────────────────────────────── */

async function dailySpent(userId: string, slot: number): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM((e.payload->>'amountUsd')::numeric), 0)::text AS total
       FROM office_session_event e JOIN office_session s ON s.id = e.session_id
      WHERE s.user_id = $1 AND s.slot = $2 AND e.type = 'PAYMENT_SETTLED' AND e.occurred_at > now() - interval '24 hours'`,
    [userId, slot],
  )
  const n = Number(rows[0]?.total ?? '0')
  return Number.isFinite(n) ? n : 0
}

async function candidateWorkers(state: SessionState): Promise<WorkerCandidate[]> {
  const { classifyWorker } = await import('@/lib/worker-fleet')
  const { harnessesFor } = await import('@/lib/agent-harness-server')
  const rows = await db
    .select({
      id: agent.id,
      runtimeType: agent.runtimeType,
      lastPollAt: agent.lastPollAt,
      smartAccountAddress: agent.smartAccountAddress,
      webhookSecretEnc: agent.webhookSecretEnc,
      autoMine: agent.autoMine,
      capabilities: agent.capabilities,
      webhookUrl: agent.webhookUrl,
      cloudBaseUrl: agent.cloudBaseUrl,
      cloudApiKeyEnc: agent.cloudApiKeyEnc,
      mcpServerUrl: agent.mcpServerUrl,
      mcpToolName: agent.mcpToolName,
    })
    .from(agent)
    .where(eq(agent.userId, state.session.userId))
  const harness = await harnessesFor(rows.map((r) => r.id)).catch(() => new Map<string, string>())
  const busy = await pool.query<{ agent_id: string; n: string }>(
    `SELECT agent_id, COUNT(*)::text AS n FROM office_session_dispatch WHERE status IN ('queued', 'claimed', 'remote') GROUP BY agent_id`,
  )
  const busyBy = new Map(busy.rows.map((r) => [r.agent_id, Number(r.n)]))
  // Real history: every run this account's sessions ever gave each worker,
  // by outcome and task kind. Recent sessions only — a worker is scored on
  // what it did lately, and a jsonb scan of 200 states is cheap.
  const past = await pool.query<{ state: SessionState }>(`SELECT state FROM office_session WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`, [state.session.userId])
  const history = workerHistoryFrom(past.rows.map((r) => r.state))
  const now = new Date()
  return rows
    .filter((r) => remoteRuntimeOf(r) !== null || r.runtimeType === 'local')
    .map((r) => {
      const status = classifyWorker(
        { runtimeType: r.runtimeType, lastPollAt: r.lastPollAt, provisioned: true, hasKey: Boolean(r.webhookSecretEnc), autoMine: r.autoMine },
        now,
      )
      return {
        agentId: r.id,
        runtimeType: remoteRuntimeOf(r) ?? ('local' as const),
        harnessId: harness.get(r.id) ?? null,
        alive: status.phase === 'Ready',
        successRate: history.get(r.id)?.successRate ?? null,
        kindSuccess: history.get(r.id)?.kindSuccess ?? {},
        estCostUsd: history.get(r.id)?.estCostUsd ?? null,
        bondReady: Boolean(r.smartAccountAddress),
        sameAccount: true,
        busyRuns: busyBy.get(r.id) ?? 0,
        capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
      }
    })
}

/**
 * A worker the platform can invoke itself (lib/agent-tasks.ts `runAgentTask`),
 * as opposed to a local worker that polls. Configured, not just declared:
 * a cloud agent without a key or an MCP agent without a tool is not a
 * candidate, however its row is labelled.
 */
function remoteRuntimeOf(r: { runtimeType: string | null; webhookUrl: string | null; cloudBaseUrl: string | null; cloudApiKeyEnc: string | null; mcpServerUrl: string | null; mcpToolName: string | null }): 'cloud' | 'mcp' | 'webhook' | null {
  if (r.runtimeType === 'cloud' && r.cloudBaseUrl && r.cloudApiKeyEnc) return 'cloud'
  if (r.runtimeType === 'mcp' && r.mcpServerUrl && r.mcpToolName) return 'mcp'
  if (r.runtimeType === 'webhook' && r.webhookUrl) return 'webhook'
  return null
}

async function escrowObservation(state: SessionState): Promise<Observation['escrow']> {
  const out: Observation['escrow'] = {}
  const withSpec = Object.values(state.tasks).filter((t) => t.settlement === 'escrow' && t.specHash)
  if (withSpec.length === 0) return out
  let jobs: Array<{ specHash: string; status: string }> = []
  try {
    const { readJobs } = await import('@/lib/onchain/labor')
    jobs = await readJobs()
  } catch {
    // Unreadable chain: every escrow task reads as unknown. Never as any status.
    for (const t of withSpec) out[t.id] = { jobStatus: null, paid: false, txHash: null, gradePassed: null }
    return out
  }
  const { jobSpec } = await import('@/lib/db/schema')
  for (const t of withSpec) {
    const job = jobs.find((j) => j.specHash.toLowerCase() === t.specHash!.toLowerCase())
    let gradePassed: boolean | null = null
    try {
      const [spec] = await db.select({ testResult: jobSpec.testResult }).from(jobSpec).where(eq(jobSpec.specHash, t.specHash as `0x${string}`))
      const tr = spec?.testResult as { passed?: boolean | null } | null
      gradePassed = typeof tr?.passed === 'boolean' ? tr.passed : null
    } catch {
      /* pre-migration: no verdict */
    }
    out[t.id] = { jobStatus: job?.status ?? null, paid: job?.status === 'Completed', txHash: null, gradePassed }
  }
  return out
}

export async function setRepoCare(sessionId: string, userId: string, s: RepoCareSettings): Promise<void> {
  await ensureTables()
  await pool.query(
    `INSERT INTO office_session_repo_care (session_id, user_id, repo_full_name, labels, max_per_wave, verify_command, open_prs, base_branch)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (session_id) DO UPDATE SET repo_full_name = $3, labels = $4::jsonb, max_per_wave = $5, verify_command = $6, open_prs = $7, base_branch = $8`,
    [sessionId, userId, s.repoFullName, JSON.stringify(s.labels), Math.max(1, Math.min(MAX_PER_WAVE, s.maxPerWave)), s.verifyCommand, s.openPrs, s.baseBranch],
  )
}

export async function getRepoCare(sessionId: string): Promise<RepoCareSettings | null> {
  await ensureTables()
  const { rows } = await pool.query<{
    repo_full_name: string
    labels: string[]
    max_per_wave: number
    verify_command: string | null
    open_prs: boolean
    base_branch: string | null
  }>(`SELECT repo_full_name, labels, max_per_wave, verify_command, open_prs, base_branch FROM office_session_repo_care WHERE session_id = $1`, [sessionId])
  const r = rows[0]
  if (!r) return null
  return {
    repoFullName: r.repo_full_name,
    labels: Array.isArray(r.labels) ? r.labels : [],
    maxPerWave: r.max_per_wave,
    verifyCommand: r.verify_command,
    openPrs: r.open_prs,
    baseBranch: r.base_branch,
  }
}

/** Every binding this account has for the session's office. */
export async function sessionToolBindings(userId: string, slot: number): Promise<SessionToolBinding[]> {
  await ensureTables()
  const { rows } = await pool.query<{
    id: string
    slot: number
    session_id: string | null
    label: string
    server_url: string
    tool_name: string
    purpose: string
    events: string[]
    created_at: Date
  }>(`SELECT id, slot, session_id, label, server_url, tool_name, purpose, events, created_at FROM office_session_tool WHERE user_id = $1 AND slot = $2 ORDER BY created_at ASC`, [userId, slot])
  return rows.map((r) => ({
    id: r.id,
    officeSlot: r.slot,
    sessionId: r.session_id,
    label: r.label,
    serverUrl: r.server_url,
    toolName: r.tool_name,
    purpose: r.purpose === 'notify' ? 'notify' : 'consult',
    events: Array.isArray(r.events) ? (r.events as SessionEventType[]) : [],
    createdAt: r.created_at.getTime(),
  }))
}

export async function attachSessionTool(userId: string, input: BindingInput & { authHeader?: string | null }): Promise<{ ok: true; binding: SessionToolBinding } | { ok: false; error: string }> {
  await ensureTables()
  const parsed = parseBinding(input, Date.now(), newId('tool'))
  if (!parsed.ok) return parsed
  const b = parsed.binding
  const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM office_session_tool WHERE user_id = $1 AND slot = $2`, [userId, b.officeSlot])
  if (Number(rows[0]?.n ?? 0) >= MAX_BINDINGS_PER_OFFICE) return { ok: false, error: `an office may talk to at most ${MAX_BINDINGS_PER_OFFICE} external tools` }
  const authEnc = input.authHeader ? (await import('@/lib/crypto')).encryptSecret(input.authHeader) : null
  await pool.query(
    `INSERT INTO office_session_tool (id, user_id, slot, session_id, label, server_url, tool_name, purpose, events, auth_header_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [b.id, userId, b.officeSlot, b.sessionId, b.label, b.serverUrl, b.toolName, b.purpose, JSON.stringify(b.events), authEnc],
  )
  return { ok: true, binding: b }
}

export async function detachSessionTool(userId: string, id: string): Promise<boolean> {
  await ensureTables()
  const r = await pool.query(`DELETE FROM office_session_tool WHERE id = $1 AND user_id = $2`, [id, userId])
  return (r.rowCount ?? 0) > 0
}

/** The call itself. Never throws: a server that is down is a note, not a failed session. */
async function callBoundTool(binding: SessionToolBinding, text: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const { rows } = await pool.query<{ auth_header_enc: string | null }>(`SELECT auth_header_enc FROM office_session_tool WHERE id = $1`, [binding.id])
    const enc = rows[0]?.auth_header_enc ?? null
    const authHeader = enc ? (await import('@/lib/crypto')).decryptSecret(enc) : null
    const { callMcpTool } = await import('@/lib/mcp-client')
    const output = await callMcpTool({ serverUrl: binding.serverUrl, toolName: binding.toolName, task: text, authHeader, timeoutMs: TOOL_CALL_TIMEOUT_MS })
    return output.trim() ? { ok: true, output } : { ok: false, error: 'the tool answered with nothing' }
  } catch (e) {
    return { ok: false, error: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
}

async function observe(state: SessionState, triggers: string[]): Promise<Observation> {
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  return {
    now: Date.now(),
    dailySpentUsd: await dailySpent(state.session.userId, state.session.officeSlot).catch(() => 0),
    candidates: await candidateWorkers(state).catch(() => []),
    escrow: await escrowObservation(state),
    realMoney: isRealMoney(),
    allowRealMoneyFlag: process.env.OFFICE_SESSION_ALLOW_REAL_MONEY,
    triggersFired: triggers,
    tools: await sessionToolBindings(state.session.userId, state.session.officeSlot).catch((e) => {
      console.error('[office-session] reading tool bindings failed:', e)
      return []
    }),
  }
}

/* ── The tick ─────────────────────────────────────────────────────────── */

/**
 * Operator knobs for the loop's clocks, bounded rather than trusted. An
 * end-to-end run wants a 30-second heartbeat timeout to prove a crash is
 * recovered; production wants five minutes so a thinking harness is not
 * declared dead. Neither should be a code change.
 */
export function loopTimingFromEnv(env: NodeJS.ProcessEnv = process.env): { heartbeatTimeoutMs?: number; pickupTimeoutMs?: number; runTimeoutMs?: number } {
  const read = (name: string, min: number, max: number): number | undefined => {
    const raw = env[name]
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
    return Math.min(max, Math.max(min, Number(raw.trim())))
  }
  const out: { heartbeatTimeoutMs?: number; pickupTimeoutMs?: number; runTimeoutMs?: number } = {}
  const hb = read('OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS', 30_000, 60 * 60_000)
  const pk = read('OFFICE_SESSION_PICKUP_TIMEOUT_MS', 30_000, 24 * 60 * 60_000)
  const rt = read('OFFICE_SESSION_RUN_TIMEOUT_MS', 60_000, 24 * 60 * 60_000)
  if (hb !== undefined) out.heartbeatTimeoutMs = hb
  if (pk !== undefined) out.pickupTimeoutMs = pk
  if (rt !== undefined) out.runTimeoutMs = rt
  return out
}

export const SESSION_TICK_LEASE_MS = 2 * 60_000

export type TickReport = { sessionId: string; status: string; events: number; commands: number; notes: string[]; skipped?: string }

/**
 * One heartbeat for one session: lease → observe → decide → persist the
 * decisions → perform the commands (each persisting its own outcome). A
 * command that fails is logged with the session id and leaves a state the
 * next tick re-derives from — never a half-applied batch.
 */
export async function tickOfficeSession(sessionId: string, opts?: { triggers?: string[] }): Promise<TickReport> {
  await ensureTables()
  const { acquireOpsLease, releaseOpsLease } = await import('@/lib/ops-lease')
  const leaseName = `office-session:${sessionId}`
  if (!(await acquireOpsLease(leaseName, SESSION_TICK_LEASE_MS))) return { sessionId, status: 'unknown', events: 0, commands: 0, notes: [], skipped: 'another tick holds the lease' }
  try {
    const state = await loadSessionState(sessionId)
    if (STATUS_META[state.session.status].terminal) return { sessionId, status: state.session.status, events: 0, commands: 0, notes: ['terminal'] }
    await closeDispatchesForTerminalRuns(state)
    // Runs on cloud / MCP / webhook workers report through agent_tasks, not
    // the poll: fold what has arrived (and a heartbeat for what is still
    // running) before the loop looks at the clock.
    const collected = await collectRemoteRuns(state)
    const policy = await getOfficePolicy(collected.session.userId, collected.session.officeSlot)
    const observation = await observe(collected, opts?.triggers ?? [])
    const result = tickSession(collected, observation, { approval: policy, newId, ...loopTimingFromEnv() })
    let after = collected
    if (result.events.length) after = await appendEvents(sessionId, result.events)
    // A run the loop closed (timed out, lost, cancelled) still holds its
    // dispatch row, and that row is what counts a worker as busy. Left
    // open, the restarted worker is "busy" forever and the retry can never
    // dispatch — the first end-to-end crash test sat in waiting_on_worker
    // for five minutes on exactly that.
    await closeDispatchesForTerminalRuns(after)
    for (const command of result.commands) {
      try {
        after = await performCommand(after, command)
      } catch (e) {
        console.error(`[office-session] ${sessionId}: command ${command.kind} failed:`, e)
        after = await appendEvents(sessionId, [
          {
            type: 'SESSION_ESCALATED',
            occurredAt: Date.now(),
            actorType: 'system',
            actorId: null,
            payload: { reason: `${command.kind} failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, taskId: 'taskId' in command ? command.taskId : null },
            idempotencyKey: eventKey(sessionId, 'SESSION_ESCALATED', `${command.kind}:${Date.now()}`),
          },
        ]).catch(() => after)
      }
    }
    if (result.notes.length) console.info(`[office-session] ${sessionId} (${after.session.status}): ${result.notes.join(' | ')}`)
    return { sessionId, status: after.session.status, events: result.events.length, commands: result.commands.length, notes: result.notes }
  } finally {
    await releaseOpsLease(leaseName)
  }
}

/** Every session that is due, for the ops cycle. Never throws. */
export async function tickOfficeSessions(): Promise<string | Record<string, unknown>> {
  try {
    await ensureTables()
  } catch {
    return 'table missing (migration pending)'
  }
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM office_session
      WHERE status NOT IN ('completed', 'partially_completed', 'failed', 'cancelled', 'expired')
        AND (next_wake_at IS NULL OR next_wake_at <= now())
        AND status NOT IN ('paused', 'awaiting_budget')
      ORDER BY priority DESC, next_wake_at ASC NULLS LAST LIMIT 25`,
  )
  // Idle event-driven sessions have next_wake_at NULL and nothing to do; a
  // tick on them is cheap (the loop returns at once), so they stay in the
  // list only to time out dead runs.
  if (rows.length === 0) return { due: 0 }
  const report: Record<string, unknown> = { due: rows.length }
  const TICK_TIMEOUT_MS = 90_000
  for (const row of rows) {
    console.info(`[office-session] tick start ${row.id}`)
    await Promise.race([
      tickOfficeSession(row.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`tick timed out after ${TICK_TIMEOUT_MS / 1000}s`)), TICK_TIMEOUT_MS)),
    ])
      .then((r) => {
        report[row.id] = r.skipped ?? `${r.status} +${r.events}ev/${r.commands}cmd`
      })
      .catch((e) => {
        report[row.id] = String(e)
        console.error(`[office-session] tick failed for ${row.id}:`, e)
      })
  }
  return report
}

/* ── Commands ─────────────────────────────────────────────────────────── */

const officeEvent = (sessionId: string, type: SessionEventType, payload: Record<string, unknown>, key: string, actorType: NewEvent['actorType'] = 'office'): NewEvent => ({
  type,
  occurredAt: Date.now(),
  actorType,
  actorId: null,
  payload,
  idempotencyKey: eventKey(sessionId, type, key),
})

async function performCommand(state: SessionState, command: Command): Promise<SessionState> {
  const sid = state.session.id
  switch (command.kind) {
    case 'plan': {
      const tasks = await planSession(state)
      return appendEvents(sid, [officeEvent(sid, 'PLAN_CREATED', { tasks: tasks.tasks, source: tasks.source, wave: state.session.wave }, `w${state.session.wave}`)])
    }
    case 'dispatch_run':
      return dispatchRun(state, command)
    case 'cancel_run':
      await markDispatchCancelled(command.runId)
      return state
    case 'run_review':
      return reviewTask(state, command.taskId)
    case 'post_escrow_job':
      return postEscrowTask(state, command.taskId)
    case 'settle_escrow':
      return settleEscrow(state, command.taskId, command.approvalId)
    case 'record_memory': {
      const lessons = await recordSessionMemory(state, command.wave)
      if (lessons.length === 0) return state
      return appendEvents(sid, [officeEvent(sid, 'MEMORY_RECORDED', { wave: command.wave, lessons }, `w${command.wave}`)])
    }
    case 'notify_owner':
      return appendEvents(sid, [
        officeEvent(sid, 'SESSION_ESCALATED', { reason: command.reason, taskId: command.taskId }, `${command.taskId ?? 'session'}:${command.reason.slice(0, 60)}`),
      ])
    case 'issue_proof':
      return issueTaskProof(state, command.taskId)
    case 'open_pr':
      return openTaskPr(state, command.taskId)
    case 'consult_tool':
      return consultTool(state, command.taskId, command.bindingId)
    case 'notify_tool':
      return notifyTool(state, command)
  }
}

/**
 * Ask an external MCP server for context before a task is worked, and
 * record what came back — as an artifact (hashed, like every other) and as
 * a `TOOL_CONSULTED` event. `dispatchRun` folds the artifact into the
 * brief, fenced, on the next tick.
 *
 * A failure is recorded too, with `ok: false`, because the record is what
 * stops the office asking the same dead server once per tick forever.
 */
async function consultTool(state: SessionState, taskId: string, bindingId: string): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[taskId]
  if (!task) return state
  const binding = (await sessionToolBindings(s.userId, s.officeSlot)).find((b) => b.id === bindingId)
  if (!binding) return state
  const query = consultQuery(s.goal, task)
  const result = await callBoundTool(binding, query)
  const events: NewEvent[] = []
  if (result.ok) {
    const { createHash } = await import('node:crypto')
    const text = result.output.slice(0, MAX_CONSULT_BYTES)
    const sha = createHash('sha256').update(text).digest('hex')
    events.push(
      officeEvent(
        s.id,
        'ARTIFACT_CREATED',
        {
          artifactId: `art-consult-${taskId}`,
          taskId,
          runId: null,
          kind: 'report',
          name: `consult-${binding.label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}.txt`,
          sha256: sha,
          bytes: Buffer.byteLength(text, 'utf8'),
          inline: text,
          ref: null,
        },
        `${taskId}:consult`,
      ),
    )
    events.push(
      officeEvent(s.id, 'TOOL_CONSULTED', { taskId, bindingId, label: binding.label, host: hostOf(binding.serverUrl), ok: true, sha256: sha, bytes: Buffer.byteLength(text, 'utf8'), query }, `${taskId}:consult`),
    )
  } else {
    events.push(
      officeEvent(s.id, 'TOOL_CONSULTED', { taskId, bindingId, label: binding.label, host: hostOf(binding.serverUrl), ok: false, sha256: null, bytes: 0, error: result.error, query }, `${taskId}:consult`),
    )
  }
  return appendEvents(s.id, events)
}

/**
 * Tell an external MCP server that something happened. One line of text,
 * built by `notifyText` and nothing else, and the answer is discarded: an
 * outbound notification is not a channel back into the session.
 */
async function notifyTool(state: SessionState, c: Extract<Command, { kind: 'notify_tool' }>): Promise<SessionState> {
  const s = state.session
  const binding = (await sessionToolBindings(s.userId, s.officeSlot)).find((b) => b.id === c.bindingId)
  if (!binding) return state
  const { absoluteUrl } = await import('@/lib/origin')
  const text = notifyText({
    session: s,
    eventType: c.eventType,
    task: c.taskId ? (state.tasks[c.taskId] ?? null) : null,
    amountUsd: c.amountUsd,
    reason: c.reason,
    origin: absoluteUrl(''),
  })
  const result = await callBoundTool(binding, text)
  return appendEvents(s.id, [
    officeEvent(
      s.id,
      'TOOL_NOTIFIED',
      { bindingId: binding.id, label: binding.label, eventType: c.eventType, ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
      `${c.bindingId}:${c.discriminator}`,
    ),
  ])
}

/**
 * A signed work proof over a settled INTERNAL task — the same EIP-712 record
 * a paid market job gets (lib/work-proof-store.ts), so a third party can
 * verify what this office decided on without trusting us. The deliverable
 * (or diff) is the content; the session's owner is the requester, the
 * worker's wallet the worker, and the grader is whatever verified it. No
 * attester key configured → no proof, and the task stays settled: the
 * sha256 receipt on the artifact is still there.
 */
async function issueTaskProof(state: SessionState, taskId: string): Promise<SessionState> {
  const task = state.tasks[taskId]
  if (!task || task.status !== 'settled' || task.settlement !== 'internal') return state
  const content = task.outcome?.deliverable ?? task.outcome?.diff
  if (!content) return state
  const already = Object.values(state.artifacts ?? {}).some((a) => a.taskId === taskId && a.kind === 'proof')
  if (already) return state
  const { issueWorkProof } = await import('@/lib/work-proof-store')
  const [worker] = task.assignedWorkerId
    ? await db.select({ smartAccountAddress: agent.smartAccountAddress }).from(agent).where(eq(agent.id, task.assignedWorkerId))
    : []
  const workerAddr = worker?.smartAccountAddress ?? `agent:${task.assignedWorkerId ?? 'unassigned'}`
  const grader = task.outcome?.review ? 'office-session:reviewer' : task.outcome?.tests ? `office-session:tests(${task.outcome.tests.command.slice(0, 80)})` : 'office-session:policy'
  const proof = await issueWorkProof({
    jobRef: `oses:${state.session.id}:${taskId}`,
    kind: task.kind,
    worker: workerAddr,
    requester: `user:${state.session.userId}`,
    grader,
    deliverable: { text: content },
    gradedAt: Math.floor((task.updatedAt || Date.now()) / 1000),
  })
  if (!proof) return state
  const text = JSON.stringify({ id: proof.id, attester: proof.attester, signature: proof.signature, cid: proof.cid, proof: proof.proof }, null, 2)
  const { createHash } = await import('node:crypto')
  return appendEvents(state.session.id, [
    officeEvent(
      state.session.id,
      'ARTIFACT_CREATED',
      {
        artifactId: `art-${taskId}-proof`,
        taskId,
        runId: task.currentRunId,
        kind: 'proof',
        name: `${taskId}.proof.json`,
        sha256: createHash('sha256').update(text).digest('hex'),
        bytes: Buffer.byteLength(text, 'utf8'),
        inline: text.length <= 64_000 ? text : null,
        ref: `/api/proof/${proof.id}`,
      },
      `${taskId}:proof`,
    ),
  ])
}

async function planSession(state: SessionState): Promise<{ tasks: ReturnType<typeof defaultPlan>; source: 'default' | 'llm' }> {
  const s = state.session
  // Repo Care plans from a real backlog, not from the goal: the goal line
  // only says which repository and how much of it (lib/repo-care.ts). A
  // wave that finds nothing takeable plans nothing, and the loop then
  // completes the wave — an empty night is a correct night.
  const care = await getRepoCare(s.id)
  if (care) {
    const triage = await triageRepoCare(care, s.wave)
    await recordTriage(state, care, triage)
    if (triage.taken.length > 0) return { tasks: triage.taken.map((t) => t.task), source: 'default' }
    console.info(`[office-session] ${s.id}: nothing takeable in ${care.repoFullName} (${triage.skipped.length} left for a person)`)
  }
  // A coding session on a workspace plans deterministically: one task, the
  // goal, verified by the command and a review. A goal for the market is
  // decomposed by the delegation planner when a model key is configured.
  if (s.kind === 'local_coding' || s.workspace !== null || !s.payerAgentId) return { tasks: defaultPlan(s), source: 'default' }
  try {
    const { planDelegation } = await import('@/lib/delegation')
    const subtasks = await planDelegation(s.userId, s.goal, Math.max(2, s.budgetLimitUsd - s.spentUsd))
    const tasks = planFromSubtasks(subtasks, s.wave)
    if (tasks.length) return { tasks, source: 'llm' }
  } catch (e) {
    console.warn(`[office-session] ${s.id}: planner unavailable, using the default plan:`, e instanceof Error ? e.message : e)
  }
  return { tasks: defaultPlan(s), source: 'default' }
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

async function dispatchRun(state: SessionState, c: Extract<Command, { kind: 'dispatch_run' }>): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[c.taskId]
  if (!task) return state
  const [workerRow] = await db.select().from(agent).where(eq(agent.id, c.workerAgentId))
  if (workerRow && workerRow.runtimeType !== 'local') return dispatchRemoteRun(state, c, workerRow)
  const grantRow = await getWorkerGrant(c.workerAgentId)
  // Layered permissions: the worker's own grant is the ceiling (what the
  // machine's owner connected it with); the session's workspace can only
  // narrow it; a task can narrow further by risk. Never widened here.
  const base: WorkspaceGrant = grantRow?.grant ?? s.workspace ?? { workdir: '', ...DEFAULT_WORKSPACE_GRANT }
  const grant: WorkspaceGrant = narrowGrant(base, grantRow ? s.workspace : null, taskGrantLayer(task))
  if (!grant.workdir) {
    return appendEvents(s.id, [
      officeEvent(s.id, 'RUN_FAILED', { runId: c.runId, failureCode: 'AUTH-001', reason: 'no workspace grant for this worker — connect it with a working directory first' }, `${c.runId}:nogrant`, 'system'),
    ])
  }
  const verifyCommand = task.verify.command ?? grantRow?.verifyCommand ?? s.verifyCommand
  const { untrustedNonce } = await import('@/lib/untrusted-input')
  const nonce = untrustedNonce()
  const memoryText = [await sessionMemoryBrief(s.userId, s.officeSlot), consultedContext(state, task.id, nonce)].filter(Boolean).join('\n\n')
  const checkpoint: Checkpoint | null = c.resumeFrom ?? latestCheckpoint(state, task.id)
  const feedback = retryFeedback(state, task)
  const brief = sessionRunBrief({
    goal: s.goal,
    taskTitle: task.title,
    taskBrief: feedback ? `${task.brief}\n\n${feedback}` : task.brief,
    acceptanceCriteria: task.acceptanceCriteria,
    grant,
    checkpoint,
    memory: memoryText,
    verifyCommand: grant.shell ? verifyCommand : null,
    nonce,
  })
  await pool.query(
    `INSERT INTO office_session_dispatch (run_id, session_id, task_id, agent_id, status, brief, workspace_grant, verify_command, resume, timeout_ms, harness_id)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6::jsonb, $7, $8::jsonb, $9, $10) ON CONFLICT (run_id) DO NOTHING`,
    [
      c.runId,
      s.id,
      task.id,
      c.workerAgentId,
      brief,
      JSON.stringify(grant),
      grant.shell ? verifyCommand : null,
      checkpoint ? JSON.stringify({ checkpointId: checkpoint.id, summary: checkpoint.summary, patch: checkpoint.patch, gitHead: checkpoint.gitHead }) : null,
      DEFAULT_RUN_TIMEOUT_MS,
      c.harnessId,
    ],
  )
  return state
}

/**
 * A run on a cloud / MCP / webhook worker: the platform invokes the worker
 * exactly as it does for a market job (`runAgentTask` — same skills, same
 * custom instructions, same callback), records the agent_tasks id on the
 * dispatch row as status 'remote', and marks the run started now, because
 * there is no pickup to wait for. The result lands on /api/runtime/callback
 * (which ticks the session) and is folded by `collectRemoteRuns` on the
 * next tick. No workspace, so no grant, no diff and no verify command: the
 * output is the deliverable, and the review layer is what verifies it.
 */
async function dispatchRemoteRun(state: SessionState, c: Extract<Command, { kind: 'dispatch_run' }>, worker: typeof agent.$inferSelect): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[c.taskId]
  if (!task) return state
  const { untrustedNonce } = await import('@/lib/untrusted-input')
  const nonce = untrustedNonce()
  const feedback = retryFeedback(state, task)
  // A tool-backed worker gets one query line: its tool is a search box, and
  // the market's own briefs hand it a phrase the same way (lib/mcp-client.ts).
  const { scopeForQuery } = await import('@/lib/mcp-client')
  const mcpQuery = worker.runtimeType === 'mcp' ? scopeForQuery(task.brief || task.title) : null
  const brief = remoteRunBrief({
    goal: s.goal,
    taskTitle: task.title,
    taskBrief: feedback ? `${task.brief}\n\n${feedback}` : task.brief,
    acceptanceCriteria: task.acceptanceCriteria,
    // Whatever this office knows, plus whatever it consulted for this task:
    // a remote worker is as entitled to the context as a local one, and the
    // fence travels with the text either way.
    memory: [await sessionMemoryBrief(s.userId, s.officeSlot), consultedContext(state, task.id, nonce)].filter(Boolean).join('\n\n'),
    nonce,
    previousAttempt: task.attempts > 1 ? (task.outcome?.deliverable?.slice(0, 4000) ?? null) : null,
    mcpQuery,
  })
  const { runAgentTask } = await import('@/lib/agent-tasks')
  const { absoluteUrl } = await import('@/lib/origin')
  let agentTaskId: string
  try {
    agentTaskId = (await runAgentTask({ agent: worker, task: brief, callbackUrl: absoluteUrl('/api/runtime/callback') })).taskId
  } catch (e) {
    return appendEvents(s.id, [
      officeEvent(s.id, 'RUN_FAILED', { runId: c.runId, failureCode: 'DEP-002', reason: `could not invoke ${worker.runtimeType} worker: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}` }, `${c.runId}:invoke`, 'system'),
    ])
  }
  await pool.query(
    `INSERT INTO office_session_dispatch (run_id, session_id, task_id, agent_id, status, brief, workspace_grant, verify_command, resume, timeout_ms, harness_id, agent_task_id, claimed_at)
     VALUES ($1, $2, $3, $4, 'remote', $5, $6::jsonb, NULL, NULL, $7, NULL, $8, now()) ON CONFLICT (run_id) DO NOTHING`,
    [c.runId, s.id, task.id, c.workerAgentId, brief, JSON.stringify({ workdir: '', ...DEFAULT_WORKSPACE_GRANT, write: false, shell: false }), DEFAULT_RUN_TIMEOUT_MS, agentTaskId],
  )
  return appendEvents(s.id, [officeEvent(s.id, 'RUN_STARTED', { runId: c.runId, agentTaskId }, c.runId, 'worker')])
}

/** Remote runs of this session that have not been folded yet. */
async function openRemoteDispatches(sessionId: string): Promise<Array<{ run_id: string; task_id: string; agent_id: string; agent_task_id: string; claimed_at: Date }>> {
  const { rows } = await pool.query<{ run_id: string; task_id: string; agent_id: string; agent_task_id: string; claimed_at: Date }>(
    `SELECT run_id, task_id, agent_id, agent_task_id, claimed_at FROM office_session_dispatch WHERE session_id = $1 AND status = 'remote' AND agent_task_id IS NOT NULL`,
    [sessionId],
  )
  return rows
}

export const REMOTE_HEARTBEAT_MS = 60_000

/**
 * Fold every remote run's agent_tasks row into the session: completed →
 * the same events a local worker's finish report produces (the output is
 * the deliverable); failed → RUN_FAILED; still running → a heartbeat at most
 * once a minute, so the loop's dead-worker timeout means "the platform lost
 * the task", not "the callback has not come yet". Returns the folded state.
 */
export async function collectRemoteRuns(state: SessionState): Promise<SessionState> {
  const open = await openRemoteDispatches(state.session.id)
  if (open.length === 0) return state
  let cur = state
  for (const d of open) {
    const run = cur.runs[d.run_id]
    if (!run || RUN_CLOSED.has(run.status)) {
      await pool.query(`UPDATE office_session_dispatch SET status = 'done', finished_at = COALESCE(finished_at, now()) WHERE run_id = $1`, [d.run_id])
      continue
    }
    const { agentTask } = await import('@/lib/db/schema')
    const [t] = await db.select({ status: agentTask.status, output: agentTask.output, result: agentTask.result, error: agentTask.error }).from(agentTask).where(eq(agentTask.id, d.agent_task_id))
    if (!t) {
      cur = await foldRunReport(cur.session.id, d.task_id, d.run_id, { ok: false, failureCode: 'DEP-003', error: 'the dispatched agent task vanished' }, 'system')
      continue
    }
    if (t.status === 'completed') {
      const result = (t.result ?? {}) as { success?: unknown; tokenCost?: unknown }
      const output = typeof t.output === 'string' ? t.output : ''
      cur =
        result.success === false || output.trim().length === 0
          ? await foldRunReport(cur.session.id, d.task_id, d.run_id, { ok: false, failureCode: 'DET-002', error: output.trim().length === 0 ? 'the worker returned nothing' : 'the worker reported failure' }, 'worker')
          : await foldRunReport(cur.session.id, d.task_id, d.run_id, { ok: true, deliverable: output, ...(typeof result.tokenCost === 'number' ? { tokensUsed: result.tokenCost } : {}) }, 'worker')
    } else if (t.status === 'failed') {
      cur = await foldRunReport(cur.session.id, d.task_id, d.run_id, { ok: false, failureCode: 'DEP-002', error: t.error ?? 'the worker runtime failed' }, 'worker')
    } else {
      const last = run.lastHeartbeatAt ?? run.startedAt ?? run.dispatchedAt
      if (Date.now() - last >= REMOTE_HEARTBEAT_MS) {
        cur = await appendEvents(cur.session.id, [officeEvent(cur.session.id, 'RUN_HEARTBEAT', { runId: d.run_id, agentTaskStatus: t.status }, `${d.run_id}:hb:${Math.floor(Date.now() / REMOTE_HEARTBEAT_MS)}`, 'system')])
      }
    }
  }
  return cur
}

/** The runtime callback's hook: an agent task that belongs to a session run ticks that session now. */
export async function tickSessionForAgentTask(agentTaskId: string): Promise<boolean> {
  await ensureTables()
  const { rows } = await pool.query<{ session_id: string }>(`SELECT session_id FROM office_session_dispatch WHERE agent_task_id = $1 AND status = 'remote' LIMIT 1`, [agentTaskId])
  if (!rows[0]) return false
  await tickOfficeSession(rows[0].session_id).catch((e) => console.error(`[office-session] tick for agent task ${agentTaskId} failed:`, e))
  return true
}

/**
 * The per-task layer of the grant. A review or verification task reads and
 * runs; it never writes the workspace or pushes. Everything else keeps the
 * session's grant — the risk tier the plan assigned is what the policy
 * engine judges the RESULT by, not a reason to pre-empt the tools.
 */
function taskGrantLayer(task: SessionTask): Partial<WorkspaceGrant> | null {
  if (task.kind === 'review' || task.kind === 'verify') return { write: false, gitPush: false, install: false }
  return null
}

/**
 * The external context this task was given, ready for the brief: fenced,
 * attributed, and carrying the sentence that says a stranger's server does
 * not get to instruct the worker (lib/session-tools.ts `renderConsult`).
 */
function consultedContext(state: SessionState, taskId: string, nonce: string): string {
  const consult = (state.toolConsults ?? {})[taskId]
  if (!consult || !consult.ok) return ''
  const artifact = Object.values(state.artifacts ?? {}).find((a) => a.taskId === taskId && a.kind === 'report' && a.name.startsWith('consult-'))
  if (!artifact?.inline) return ''
  return renderConsult({ label: consult.label, host: consult.host }, artifact.inline, nonce)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'an external server'
  }
}

/**
 * Tonight's triage of a Repo Care repository. A backlog that cannot be read
 * (the App is not installed on that repo, the token is refused) is an empty
 * triage with the reason on the timeline — never a thrown tick.
 */
async function triageRepoCare(care: RepoCareSettings, wave: number): Promise<Triage> {
  try {
    const { listOpenIssues } = await import('@/lib/github-app')
    const issues = await listOpenIssues(care.repoFullName, 50)
    return triageIssues(issues, care, wave)
  } catch (e) {
    console.error(`[office-session] reading the backlog of ${care.repoFullName} failed:`, e)
    return { taken: [], skipped: [] }
  }
}

/**
 * The skip list, on the record. It is the product's honesty — an office
 * that quietly ignored half the backlog would look better than it is — so
 * it becomes an artifact the owner can read next to the work.
 */
async function recordTriage(state: SessionState, care: RepoCareSettings, triage: Triage): Promise<void> {
  if (triage.skipped.length === 0) return
  const text = triage.skipped.map((s) => `- #${s.issue.number} ${s.issue.title} — ${s.detail}`).join('\n')
  const { createHash } = await import('node:crypto')
  await appendEvents(state.session.id, [
    officeEvent(
      state.session.id,
      'ARTIFACT_CREATED',
      {
        artifactId: `art-triage-w${state.session.wave}`,
        taskId: null,
        runId: null,
        kind: 'report',
        name: `left-for-a-person-w${state.session.wave}.md`,
        sha256: createHash('sha256').update(text).digest('hex'),
        bytes: Buffer.byteLength(text, 'utf8'),
        inline: text.slice(0, 32_000),
        ref: null,
      },
      `w${state.session.wave}:triage`,
    ),
  ]).catch((e) => console.error('[office-session] recording the triage failed:', e))
  void care
}

/**
 * Land a settled task's diff as a pull request through the GitHub App —
 * the same `openPrFromDiff` the market's repo lane uses, which validates
 * every hunk against the CURRENT base before it opens anything. The PR URL
 * becomes an artifact, so a failure to land is as visible as a landing.
 */
async function openTaskPr(state: SessionState, taskId: string): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[taskId]
  const target = task?.deliverPr
  const diff = task?.outcome?.diff
  if (!task || !target || !diff) return state
  if (Object.values(state.artifacts ?? {}).some((a) => a.taskId === taskId && a.name.startsWith('pr-'))) return state
  const { createHash } = await import('node:crypto')
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  try {
    const { openPrFromDiff } = await import('@/lib/github-app')
    const pr = await openPrFromDiff({
      repoFullName: target.repoFullName,
      baseBranch: target.baseBranch ?? '',
      diff,
      title: task.title.slice(0, 120),
      body:
        `${task.outcome?.deliverable?.slice(0, 4000) ?? 'Opened by a Handsel office session.'}\n\n---\n` +
        `Session \`${s.id}\`, task \`${task.id}\`, attempt ${task.attempts}. ` +
        `Verification: ${task.outcome?.tests ? `\`${task.outcome.tests.command}\` exit ${task.outcome.tests.exitCode}` : 'none recorded'}. ` +
        `Approved under policy \`${s.approvalPolicyId}\`.`,
      branchHint: `${s.id}-${task.id}`,
    })
    const text = `${pr.prUrl}\n\nbranch ${pr.branch}`
    return appendEvents(s.id, [
      officeEvent(
        s.id,
        'ARTIFACT_CREATED',
        { artifactId: `art-pr-${taskId}`, taskId, runId: task.currentRunId, kind: 'report', name: `pr-${pr.prNumber}.md`, sha256: sha(text), bytes: text.length, inline: text, ref: pr.prUrl },
        `${taskId}:pr`,
      ),
    ])
  } catch (e) {
    const reason = redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 400)
    return appendEvents(s.id, [
      officeEvent(s.id, 'SESSION_ESCALATED', { reason: `could not open a pull request on ${target.repoFullName}: ${reason}`, taskId }, `${taskId}:prfail`),
    ])
  }
}

/** The grader's or reviewer's words for a retried attempt, fenced for the brief. */
function retryFeedback(state: SessionState, task: SessionTask): string | null {
  if (task.attempts <= 1) return null
  const o = task.outcome
  const parts: string[] = []
  if (o?.tests && o.tests.passed === false) parts.push(`The previous attempt's verification command (\`${o.tests.command}\`) failed with exit ${o.tests.exitCode}. Its output ended:\n${o.tests.tail.slice(-1500)}`)
  if (o?.review && o.review.approve === false) parts.push(`An independent reviewer asked for revision: ${o.review.note.slice(0, 1500)}`)
  if (task.statusReason && !parts.length) parts.push(`The previous attempt ended: ${task.statusReason}`)
  if (!parts.length) return null
  return `### Feedback on attempt ${task.attempts - 1}\n\n${parts.join('\n\n')}`
}

async function sessionMemoryBrief(userId: string, slot: number): Promise<string> {
  const parts: string[] = []
  try {
    const { renderedOfficeMemory } = await import('@/lib/office-memory-server')
    const paid = await renderedOfficeMemory(userId, slot)
    if (paid) parts.push(paid)
  } catch {
    /* memory is context, never a reason not to dispatch */
  }
  const lessons = await getSessionMemory(userId, slot).catch(() => [] as SessionLesson[])
  const rendered = renderLessons(lessons.slice(-10))
  if (rendered) parts.push(rendered)
  return parts.join('\n\n')
}

const RUN_CLOSED = new Set(['finished', 'failed', 'timed_out', 'cancelled', 'lost'])

/** Close dispatch rows for runs the state already considers over. Idempotent, cheap. */
async function closeDispatchesForTerminalRuns(state: SessionState): Promise<void> {
  const ids = Object.values(state.runs)
    .filter((r) => RUN_CLOSED.has(r.status))
    .map((r) => r.id)
  if (ids.length === 0) return
  await pool
    .query(`UPDATE office_session_dispatch SET status = 'done', finished_at = COALESCE(finished_at, now()) WHERE run_id = ANY($1) AND status IN ('queued', 'claimed', 'cancel', 'remote')`, [ids])
    .catch((e) => console.error('[office-session] closing dispatch rows failed:', e))
}

async function markDispatchCancelled(runId: string): Promise<void> {
  await ensureTables()
  await pool.query(`UPDATE office_session_dispatch SET status = 'cancel' WHERE run_id = $1 AND status IN ('queued', 'claimed')`, [runId])
}

const REVIEWER_SYSTEM = `You are an independent reviewer for an autonomous engineering office. Judge whether the submitted work satisfies the acceptance criteria. The criteria are the contract: do not invent extra requirements, and do not excuse a clear failure. Output ONLY a JSON object {"approve": boolean, "note": "one or two sentences naming what you checked, quoting the deliverable where it decides the verdict"}.`

async function reviewTask(state: SessionState, taskId: string): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[taskId]
  if (!task || !task.outcome) return state
  const at = Date.now()
  const fold = (approve: boolean | null, note: string, reviewerId: string | null) =>
    appendEvents(s.id, [
      officeEvent(s.id, 'REVIEW_RECEIVED', { taskId, verdict: { reviewer: 'model', reviewerId, approve, note: note.slice(0, 2000), at } }, `${taskId}:a${task.attempts}`, 'reviewer'),
    ])
  let complete: CompleteFn | null = null
  try {
    const { resolveLlm } = await import('@/lib/delegation')
    complete = await resolveLlm(s.userId)
  } catch (e) {
    return fold(null, `no reviewer available: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, null)
  }
  const { fenceUntrusted, graderInjectionClause, untrustedNonce } = await import('@/lib/untrusted-input')
  const nonce = untrustedNonce()
  const o = task.outcome
  const body =
    `Task: ${task.title}\n\nBrief:\n${task.brief.slice(0, 6000)}\n\nAcceptance criteria:\n${task.acceptanceCriteria}\n\n` +
    (o.tests ? `Deterministic check: \`${o.tests.command}\` exited ${o.tests.exitCode} (${o.tests.passed ? 'pass' : 'fail'}).\n\n` : 'No deterministic check ran.\n\n') +
    `Files changed: ${o.changedFiles.slice(0, 40).join(', ') || 'none reported'}\n\n` +
    (o.diff ? `Diff:\n${fenceUntrusted('diff', o.diff.slice(0, 20_000), nonce)}\n\n` : '') +
    (o.deliverable ? `Worker's report:\n${fenceUntrusted('report', o.deliverable.slice(0, 8000), nonce)}` : '')
  try {
    const raw = await complete!({ stable: REVIEWER_SYSTEM, volatile: graderInjectionClause(nonce) }, body, 800, { effort: 'low' })
    const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, '')
    const parsed = JSON.parse(text) as { approve?: unknown; note?: unknown }
    if (typeof parsed.approve !== 'boolean') return fold(null, 'reviewer returned no parseable verdict', 'model')
    return fold(parsed.approve, String(parsed.note ?? ''), 'model')
  } catch (e) {
    return fold(null, `reviewer failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, 'model')
  }
}

async function postEscrowTask(state: SessionState, taskId: string): Promise<SessionState> {
  const s = state.session
  const task = state.tasks[taskId]
  if (!task || task.specHash) return state
  if (!s.payerAgentId) throw new Error('this session has no payer agent; escrow tasks need one')
  const { postSpecJob } = await import('@/lib/job-post')
  const posted = await postSpecJob({
    payerAgentId: s.payerAgentId,
    title: task.title,
    description: `${task.brief}\n\n(Office session ${s.id}, task ${task.id}.)`,
    acceptanceCriteria: task.acceptanceCriteria,
    bountyUsd: task.bountyUsd,
    reserveForAgentId: task.assignedWorkerId ?? null,
    // The session decides when this may release: posted with autoApprove
    // OFF, flipped on by settle_escrow after the policy said yes.
    autoApprove: false,
    officeOwnerId: s.userId,
  })
  return appendEvents(s.id, [officeEvent(s.id, 'TASK_POSTED', { taskId, specHash: posted.specHash, onchainJobId: posted.onchainJobId }, `${taskId}:${posted.specHash}`)])
}

async function settleEscrow(state: SessionState, taskId: string, approvalId: string): Promise<SessionState> {
  const task = state.tasks[taskId]
  const approval: ApprovalRecord | undefined = state.approvals[approvalId]
  if (!task || !task.specHash || !approval || approval.granted !== true) return state
  const { jobSpec } = await import('@/lib/db/schema')
  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, task.specHash as `0x${string}`))
  if (!spec) throw new Error(`no job spec for ${task.specHash}`)
  if (!spec.autoApprove) await db.update(jobSpec).set({ autoApprove: true }).where(eq(jobSpec.specHash, spec.specHash))
  const { autoApprovePassedJob } = await import('@/lib/labor-settle')
  // The one release site. Its own guards (on-chain Submitted, peer-review
  // hold, cap) still apply; the next tick observes whether the chain moved.
  await autoApprovePassedJob({ ...spec, autoApprove: true })
  return state
}

/* ── Worker protocol ──────────────────────────────────────────────────── */

export type SessionRunHandout = {
  run_id: string
  session_id: string
  task_id: string
  brief: string
  grant: WorkspaceGrant
  verify_command: string | null
  resume: { checkpointId: string; summary: string; patch: string | null; gitHead: string | null } | null
  timeout_ms: number
  deliverable_path: string
}

/** Hand the oldest queued run for this agent out — atomic claim. Marks it started. */
export async function claimSessionRunFor(agentId: string): Promise<SessionRunHandout | null> {
  await ensureTables()
  const { rows } = await pool.query<{
    run_id: string
    session_id: string
    task_id: string
    brief: string
    grant: WorkspaceGrant
    verify_command: string | null
    resume: SessionRunHandout['resume']
    timeout_ms: number
  }>(
    `UPDATE office_session_dispatch SET status = 'claimed', claimed_at = now()
      WHERE run_id = (SELECT run_id FROM office_session_dispatch WHERE agent_id = $1 AND status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING run_id, session_id, task_id, brief, workspace_grant AS grant, verify_command, resume, timeout_ms`,
    [agentId],
  )
  const r = rows[0]
  if (!r) return null
  await appendEvents(r.session_id, [officeEvent(r.session_id, 'RUN_STARTED', { runId: r.run_id }, r.run_id, 'worker')]).catch((e) =>
    console.error(`[office-session] RUN_STARTED for ${r.run_id} failed:`, e),
  )
  return {
    run_id: r.run_id,
    session_id: r.session_id,
    task_id: r.task_id,
    brief: r.brief,
    grant: r.grant,
    verify_command: r.verify_command,
    resume: r.resume,
    timeout_ms: r.timeout_ms,
    deliverable_path: SESSION_DELIVERABLE_PATH,
  }
}

/** Runs this agent should stop — the cancel channel on the poll. */
export async function cancelledRunsFor(agentId: string): Promise<string[]> {
  await ensureTables()
  const { rows } = await pool.query<{ run_id: string }>(`SELECT run_id FROM office_session_dispatch WHERE agent_id = $1 AND status = 'cancel'`, [agentId])
  return rows.map((r) => r.run_id)
}

export type SessionRunReport = {
  runId: unknown
  events?: unknown
  changedFiles?: unknown
  checkpoint?: unknown
  tokensUsed?: unknown
  costUsd?: unknown
}

const MAX_LOG_LINES_PER_REPORT = 60
const MAX_REPORT_FILES = 200

function strList(v: unknown, max = MAX_REPORT_FILES): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 500).slice(0, max) : []
}

/**
 * Fold one progress report from the poll. The agent id is the AUTHENTICATED
 * one; the run must be that agent's. Log lines go to the run log, bounded
 * and redacted; the domain log gets one RUN_PROGRESS per report and one
 * CHECKPOINT_CREATED per checkpoint sequence.
 */
export async function recordSessionRunReport(agentId: string, report: SessionRunReport): Promise<void> {
  const runId = typeof report.runId === 'string' ? report.runId.slice(0, 80) : null
  if (!runId) return
  await ensureTables()
  const { rows } = await pool.query<{ session_id: string; status: string }>(`SELECT session_id, status FROM office_session_dispatch WHERE run_id = $1 AND agent_id = $2`, [
    runId,
    agentId,
  ])
  const d = rows[0]
  if (!d) return
  const now = Date.now()
  const events: HarnessEvent[] = Array.isArray(report.events)
    ? (report.events as unknown[])
        .slice(0, MAX_LOG_LINES_PER_REPORT)
        .map((e): HarnessEvent | null => {
          const r = (e ?? {}) as Record<string, unknown>
          const text = typeof r.text === 'string' ? redactSecrets(r.text).slice(0, 400) : ''
          if (!text) return null
          return {
            at: typeof r.at === 'number' && Math.abs(r.at - now) < 86_400_000 ? r.at : now,
            kind: typeof r.kind === 'string' && r.kind.length < 20 ? (r.kind as HarnessEvent['kind']) : 'stdout',
            text,
            path: typeof r.path === 'string' ? r.path.slice(0, 300) : null,
            data: null,
          }
        })
        .filter((e): e is HarnessEvent => e !== null)
    : []
  if (events.length) {
    const values: unknown[] = []
    const rowsSql = events.map((e, i) => {
      const b = i * 6
      values.push(d.session_id, runId, new Date(e.at), e.kind, e.text, e.path)
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`
    })
    await pool.query(`INSERT INTO office_session_run_log (session_id, run_id, at, kind, text, path) VALUES ${rowsSql.join(', ')}`, values).catch(() => undefined)
  }
  const changed = strList(report.changedFiles)
  const domain: NewEvent[] = [
    officeEvent(
      d.session_id,
      'RUN_PROGRESS',
      {
        runId,
        changedFiles: changed,
        lines: events.length,
        ...(typeof report.tokensUsed === 'number' ? { tokensUsed: report.tokensUsed } : {}),
        ...(typeof report.costUsd === 'number' ? { costUsd: report.costUsd } : {}),
      },
      `${runId}:${now}`,
      'worker',
    ),
  ]
  const cp = report.checkpoint as Record<string, unknown> | undefined
  if (cp && typeof cp === 'object' && typeof cp.seq === 'number') {
    domain.push(
      officeEvent(
        d.session_id,
        'CHECKPOINT_CREATED',
        {
          runId,
          checkpointId: `cp-${runId}-${cp.seq}`,
          seq: cp.seq,
          summary: typeof cp.summary === 'string' ? redactSecrets(cp.summary).slice(0, 2000) : '',
          gitHead: typeof cp.gitHead === 'string' ? cp.gitHead.slice(0, 64) : null,
          patch: typeof cp.patch === 'string' ? redactSecrets(cp.patch) : null,
          filesChanged: strList(cp.filesChanged),
        },
        `${runId}:cp${cp.seq}`,
        'worker',
      ),
    )
  }
  await appendEvents(d.session_id, domain).catch((e) => console.error(`[office-session] report for ${runId} not folded:`, e))
}

export type SessionRunFinish = {
  runId: unknown
  ok?: unknown
  exitCode?: unknown
  deliverable?: unknown
  diff?: unknown
  changedFiles?: unknown
  deletedFiles?: unknown
  tests?: unknown
  costUsd?: unknown
  tokensUsed?: unknown
  harnessSessionId?: unknown
  error?: unknown
  failureCode?: unknown
  checkpoint?: unknown
}

export const MAX_DELIVERABLE_BYTES = 256 * 1024
export const MAX_DIFF_BYTES = 512 * 1024

/**
 * The finish report. Persists the artifacts (hashed), the test report and
 * the submission in one append, then ticks the session so verification
 * begins now rather than on the next cron.
 */
export async function finishSessionRun(agentId: string, report: SessionRunFinish): Promise<{ ok: true; sessionId: string } | { ok: false; error: string; status: number }> {
  const runId = typeof report.runId === 'string' ? report.runId.slice(0, 80) : null
  if (!runId) return { ok: false, error: 'runId required', status: 400 }
  await ensureTables()
  const { rows } = await pool.query<{ session_id: string; task_id: string; status: string }>(
    `SELECT session_id, task_id, status FROM office_session_dispatch WHERE run_id = $1 AND agent_id = $2`,
    [runId, agentId],
  )
  const d = rows[0]
  if (!d) return { ok: false, error: 'unknown run', status: 404 }
  if (d.status === 'done') return { ok: true, sessionId: d.session_id } // idempotent
  const deliverable = typeof report.deliverable === 'string' ? report.deliverable : null
  const diff = typeof report.diff === 'string' ? report.diff : null
  if (deliverable && Buffer.byteLength(deliverable, 'utf8') > MAX_DELIVERABLE_BYTES) return { ok: false, error: `deliverable over ${MAX_DELIVERABLE_BYTES / 1024}KB`, status: 413 }
  if (diff && Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return { ok: false, error: `diff over ${MAX_DIFF_BYTES / 1024}KB`, status: 413 }
  await foldRunReport(d.session_id, d.task_id, runId, report, 'worker')
  await tickOfficeSession(d.session_id).catch((e) => console.error(`[office-session] tick after finish failed for ${d.session_id}:`, e))
  return { ok: true, sessionId: d.session_id }
}

/**
 * One run's outcome as session events — the same fold for a local worker's
 * finish report and a remote worker's callback: RUN_FINISHED or RUN_FAILED,
 * the artifacts by hash, TASK_SUBMITTED, a test report and a checkpoint
 * when present. Closes the dispatch row. Idempotent per run id.
 */
async function foldRunReport(sessionId: string, taskId: string, runId: string, report: Omit<SessionRunFinish, 'runId'>, actor: NewEvent['actorType']): Promise<SessionState> {
  const d = { session_id: sessionId, task_id: taskId }
  const deliverable = typeof report.deliverable === 'string' ? report.deliverable.slice(0, MAX_DELIVERABLE_BYTES) : null
  const diff = typeof report.diff === 'string' ? report.diff : null
  const { createHash } = await import('node:crypto')
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const now = Date.now()
  const changed = strList(report.changedFiles)
  const events: NewEvent[] = []
  const ok = report.ok === true
  const exitCode = typeof report.exitCode === 'number' ? report.exitCode : null
  if (!ok) {
    events.push(
      officeEvent(
        d.session_id,
        'RUN_FAILED',
        {
          runId,
          exitCode,
          failureCode: typeof report.failureCode === 'string' ? report.failureCode.slice(0, 16) : 'DET-000',
          reason: typeof report.error === 'string' ? redactSecrets(report.error).slice(0, 500) : 'worker reported failure',
        },
        `${runId}:finish`,
        actor,
      ),
    )
  } else {
    events.push(
      officeEvent(
        d.session_id,
        'RUN_FINISHED',
        {
          runId,
          exitCode,
          changedFiles: changed,
          diffStat: diff ? (await import('@/lib/harness-run')).diffStat(diff) : null,
          ...(typeof report.costUsd === 'number' ? { costUsd: report.costUsd } : {}),
          ...(typeof report.tokensUsed === 'number' ? { tokensUsed: report.tokensUsed } : {}),
        },
        `${runId}:finish`,
        'worker',
      ),
    )
    const artifacts: Array<{ kind: 'diff' | 'deliverable' | 'test_report'; name: string; text: string }> = []
    if (diff) artifacts.push({ kind: 'diff', name: `${runId}.patch`, text: diff })
    if (deliverable) artifacts.push({ kind: 'deliverable', name: `${runId}.md`, text: deliverable })
    const tests = report.tests as Record<string, unknown> | undefined
    let testReport: TestReport | null = null
    if (tests && typeof tests === 'object' && typeof tests.command === 'string') {
      const ec = typeof tests.exitCode === 'number' ? tests.exitCode : null
      testReport = {
        command: tests.command.slice(0, 300),
        exitCode: ec,
        passed: ec === null ? null : ec === 0,
        tail: typeof tests.tail === 'string' ? redactSecrets(tests.tail).slice(-4000) : '',
        durationMs: typeof tests.durationMs === 'number' ? tests.durationMs : null,
      }
      artifacts.push({ kind: 'test_report', name: `${runId}.tests.txt`, text: `$ ${testReport.command}\nexit ${ec}\n${testReport.tail}` })
    }
    for (const a of artifacts) {
      events.push(
        officeEvent(
          d.session_id,
          'ARTIFACT_CREATED',
          { artifactId: `art-${runId}-${a.kind}`, taskId: d.task_id, runId, kind: a.kind, name: a.name, sha256: sha(a.text), bytes: Buffer.byteLength(a.text, 'utf8'), inline: a.text.length <= 64_000 ? a.text : null, ref: null },
          `${runId}:${a.kind}`,
          'worker',
        ),
      )
    }
    const content = diff ?? deliverable ?? ''
    events.push(
      officeEvent(
        d.session_id,
        'TASK_SUBMITTED',
        {
          taskId: d.task_id,
          deliverable,
          diff,
          changedFiles: changed,
          contentHash: content ? sha(content) : null,
          ...(typeof report.costUsd === 'number' ? { costUsd: report.costUsd } : {}),
        },
        `${runId}:submitted`,
        'worker',
      ),
    )
    if (testReport) events.push(officeEvent(d.session_id, 'TEST_REPORTED', { taskId: d.task_id, report: testReport }, `${runId}:tests`, 'worker'))
  }
  const cp = report.checkpoint as Record<string, unknown> | undefined
  if (cp && typeof cp === 'object' && typeof cp.seq === 'number') {
    events.unshift(
      officeEvent(
        d.session_id,
        'CHECKPOINT_CREATED',
        {
          runId,
          checkpointId: `cp-${runId}-${cp.seq}`,
          seq: cp.seq,
          summary: typeof cp.summary === 'string' ? redactSecrets(cp.summary).slice(0, 2000) : '',
          gitHead: typeof cp.gitHead === 'string' ? cp.gitHead.slice(0, 64) : null,
          patch: typeof cp.patch === 'string' ? redactSecrets(cp.patch) : null,
          filesChanged: strList(cp.filesChanged),
        },
        `${runId}:cp${cp.seq}`,
        'worker',
      ),
    )
  }
  const state = await appendEvents(d.session_id, events)
  await pool.query(`UPDATE office_session_dispatch SET status = 'done', finished_at = now() WHERE run_id = $1`, [runId])
  void now
  return state
}

/** An external event (webhook, CI, issue) that may wake event-driven sessions of this account. */
export async function fireSessionTrigger(userId: string, trigger: string): Promise<number> {
  return fireSessionTriggers([trigger], userId)
}

/**
 * Wake every event-driven session whose trigger list matches any of the
 * fired names (lib/session-triggers.ts). `userId` narrows to one account
 * (the HTTP lane, authenticated as that account's worker); the GitHub
 * webhook passes none — the repo-qualified names are the scope there.
 * Returns how many sessions were ticked.
 */
export async function fireSessionTriggers(fired: string[], userId?: string | null): Promise<number> {
  if (fired.length === 0) return 0
  await ensureTables()
  const { rows } = await pool.query<{ id: string; state: SessionState }>(
    `SELECT id, state FROM office_session WHERE ($1::text IS NULL OR user_id = $1) AND kind = 'event_driven'
       AND status NOT IN ('completed', 'partially_completed', 'failed', 'cancelled', 'expired', 'paused')
     ORDER BY updated_at DESC LIMIT 500`,
    [userId ?? null],
  )
  let ticked = 0
  for (const r of rows) {
    const hits = triggerMatches(r.state.session.triggers ?? [], fired)
    if (hits.length === 0) continue
    ticked += 1
    await tickOfficeSession(r.id, { triggers: hits }).catch((e) => console.error(`[office-session] trigger tick failed for ${r.id}:`, e))
  }
  return ticked
}

/**
 * Every session state of one office, for a read-only pass over the log
 * (`lib/office-metrics.ts`). Bounded: the operator's numbers come from
 * recent history, not from every session an account ever ran.
 */
export async function sessionStatesFor(userId: string, slot: number, limit = 200): Promise<SessionState[]> {
  await ensureTables()
  const { rows } = await pool.query<{ state: SessionState }>(`SELECT state FROM office_session WHERE user_id = $1 AND slot = $2 ORDER BY created_at DESC LIMIT $3`, [userId, slot, limit])
  return rows.map((r) => r.state)
}

/** Undecided approvals across an account — the inbox. */
export async function approvalInbox(userId: string): Promise<Array<{ session: OfficeSession; task: SessionTask; approval: ApprovalRecord }>> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow>(`SELECT id, user_id, slot, version, state FROM office_session WHERE user_id = $1 AND status = 'waiting_on_approval' ORDER BY updated_at DESC LIMIT 100`, [
    userId,
  ])
  const out: Array<{ session: OfficeSession; task: SessionTask; approval: ApprovalRecord }> = []
  for (const r of rows) {
    for (const a of Object.values(r.state.approvals ?? {})) {
      if (a.decidedAt !== null) continue
      if (a.policyOutcome !== 'REQUIRE_OWNER' && a.policyOutcome !== 'REQUIRE_REVIEWER') continue
      const task = r.state.tasks[a.taskId]
      if (task) out.push({ session: r.state.session, task, approval: a })
    }
  }
  return out
}
