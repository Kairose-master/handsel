/**
 * Where a run's telemetry lives.
 *
 * A side table, not columns on `agent_tasks`, for the reason at the top of
 * lib/db/ensure-columns.ts and repeated in lib/agent-harness-server.ts:
 * drizzle expands `db.select().from(agentTask)` to name every declared
 * column, so a new one breaks every read of that table from the moment it
 * deploys until someone runs a migration by hand. This table creates itself
 * on first use and nothing that already reads tasks has to know it exists.
 *
 * Two tables rather than one JSON blob, because the two halves have opposite
 * shapes: a run is one row that is updated on every poll, and its events are
 * many rows that are only ever appended. Rewriting a growing JSON array on
 * every three-second poll is a write amplification bug waiting to be found
 * in production by a worker that runs for an hour.
 *
 * Everything here is best-effort by contract. Telemetry is a nice-to-have
 * riding on the poll that hands out paid work; a failure to record a log
 * line must never cost a worker its task. Callers are expected to
 * `.catch(() => {})` and the functions are written so that is safe.
 */
import { pool } from '@/lib/db'
import {
  MAX_EVENTS_KEPT,
  NO_SAMPLE,
  RUN_PHASES,
  furthestPhase,
  sanitizeEvents,
  sanitizePhase,
  sanitizeSample,
  type HarnessRun,
  type RunEvent,
  type RunPhase,
} from '@/lib/harness-run'

let ready: Promise<void> | null = null

async function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS harness_run (
           task_id text PRIMARY KEY,
           agent_id text NOT NULL,
           harness_id text,
           model text,
           phase text NOT NULL DEFAULT 'plan',
           started_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now(),
           finished_at timestamptz,
           ok boolean,
           cpu_pct double precision,
           mem_used_mb double precision,
           mem_total_mb double precision,
           tokens_used double precision
         )`,
      )
      await pool.query(
        `CREATE TABLE IF NOT EXISTS harness_run_event (
           id bigserial PRIMARY KEY,
           task_id text NOT NULL,
           at timestamptz NOT NULL,
           phase text NOT NULL,
           level text NOT NULL,
           path text,
           text text NOT NULL
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS harness_run_event_task ON harness_run_event (task_id, at)`)
      await pool.query(`CREATE INDEX IF NOT EXISTS harness_run_agent ON harness_run (agent_id, started_at DESC)`)
    })()
      .then(() => undefined)
      .catch((e) => {
        ready = null // not cached on failure, or every later call believes it exists
        throw e
      })
  }
  return ready
}

export type RunReport = {
  taskId: unknown
  harnessId?: unknown
  model?: unknown
  phase?: unknown
  events?: unknown
  sample?: unknown
  tokensUsed?: unknown
  /** Present only on the final report. */
  finished?: unknown
  ok?: unknown
}

/** Ids the platform recognises. A worker sends whatever it likes. */
const KNOWN_HARNESS = new Set(['claude', 'codex', 'opencode', 'cline', 'gemini', 'dsh', 'custom'])

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

/**
 * Fold one worker report into the run.
 *
 * `agentId` comes from the AUTHENTICATED poll, never from the report body —
 * otherwise any worker with a valid secret could write telemetry onto
 * another account's run just by naming its task id.
 */
export async function recordRunReport(agentId: string, report: RunReport): Promise<void> {
  const taskId = str(report.taskId, 120)
  if (!taskId) return
  const now = Date.now()
  const events = sanitizeEvents(report.events, now)
  const sample = sanitizeSample(report.sample)
  const reportedPhase = sanitizePhase(report.phase)
  const harnessRaw = str(report.harnessId, 40)
  const harnessId = harnessRaw && KNOWN_HARNESS.has(harnessRaw) ? harnessRaw : null
  const model = str(report.model, 80)
  const tokens = typeof report.tokensUsed === 'number' && Number.isFinite(report.tokensUsed) ? report.tokensUsed : null
  const finished = report.finished === true
  const ok = finished ? report.ok === true : null

  await ensureTables()

  // The phase can only advance. A worker that reports 'code' after a failing
  // test would otherwise drag the stepper backwards on the console, which
  // reads as the run losing progress it has not lost.
  const advanced = furthestPhase(events, reportedPhase)

  await pool.query(
    `INSERT INTO harness_run
       (task_id, agent_id, harness_id, model, phase, updated_at, finished_at, ok,
        cpu_pct, mem_used_mb, mem_total_mb, tokens_used)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id) DO UPDATE SET
       harness_id   = COALESCE(EXCLUDED.harness_id, harness_run.harness_id),
       model        = COALESCE(EXCLUDED.model, harness_run.model),
       -- GREATEST over the phase ORDINAL, not the string: alphabetically
       -- 'code' beats 'test', so a text comparison here would silently make
       -- the stepper run backwards for exactly the case it exists to stop.
       phase        = CASE WHEN $12 >= array_position($13::text[], harness_run.phase)
                           THEN EXCLUDED.phase ELSE harness_run.phase END,
       updated_at   = now(),
       finished_at  = COALESCE(EXCLUDED.finished_at, harness_run.finished_at),
       ok           = COALESCE(EXCLUDED.ok, harness_run.ok),
       cpu_pct      = COALESCE(EXCLUDED.cpu_pct, harness_run.cpu_pct),
       mem_used_mb  = COALESCE(EXCLUDED.mem_used_mb, harness_run.mem_used_mb),
       mem_total_mb = COALESCE(EXCLUDED.mem_total_mb, harness_run.mem_total_mb),
       tokens_used  = COALESCE(EXCLUDED.tokens_used, harness_run.tokens_used)`,
    [
      taskId,
      agentId,
      harnessId,
      model,
      advanced,
      finished ? new Date(now) : null,
      ok,
      sample.cpuPct,
      sample.memUsedMb,
      sample.memTotalMb,
      tokens,
      RUN_PHASES.indexOf(advanced) + 1, // array_position is 1-based
      [...RUN_PHASES],
    ],
  )

  if (events.length > 0) {
    const values: unknown[] = []
    const COLS = 6
    const rows = events.map((e, i) => {
      const b = i * COLS
      values.push(taskId, new Date(e.at), e.phase, e.level, e.path, e.text)
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`
    })
    await pool.query(
      `INSERT INTO harness_run_event (task_id, at, phase, level, path, text) VALUES ${rows.join(', ')}`,
      values,
    )
  }
}

type RunRow = {
  task_id: string
  agent_id: string
  harness_id: string | null
  model: string | null
  phase: string
  started_at: Date
  updated_at: Date
  finished_at: Date | null
  ok: boolean | null
  cpu_pct: number | null
  mem_used_mb: number | null
  mem_total_mb: number | null
  tokens_used: number | null
}

function toRun(row: RunRow, events: RunEvent[]): HarnessRun {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    harnessId: row.harness_id,
    model: row.model,
    phase: (RUN_PHASES as readonly string[]).includes(row.phase) ? (row.phase as RunPhase) : 'plan',
    startedAt: row.started_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    finishedAt: row.finished_at ? row.finished_at.getTime() : null,
    ok: row.ok,
    events,
    sample:
      row.cpu_pct === null && row.mem_used_mb === null
        ? NO_SAMPLE
        : { cpuPct: row.cpu_pct, memUsedMb: row.mem_used_mb, memTotalMb: row.mem_total_mb },
    tokensUsed: row.tokens_used,
  }
}

/**
 * The runs on an account's agents, newest first.
 *
 * Degrades to an empty list rather than throwing: this renders a console
 * that is worth showing even when the telemetry table is momentarily
 * unavailable, and the tasks themselves are read from somewhere else.
 */
export async function runsForAgents(agentIds: string[], limit = 12): Promise<HarnessRun[]> {
  if (agentIds.length === 0) return []
  try {
    await ensureTables()
    const { rows } = await pool.query<RunRow>(
      `SELECT * FROM harness_run WHERE agent_id = ANY($1) ORDER BY started_at DESC LIMIT $2`,
      [agentIds, Math.min(50, Math.max(1, limit))],
    )
    if (rows.length === 0) return []
    const { rows: evs } = await pool.query<{
      task_id: string
      at: Date
      phase: string
      level: string
      path: string | null
      text: string
    }>(
      `SELECT task_id, at, phase, level, path, text FROM harness_run_event
       WHERE task_id = ANY($1) ORDER BY at ASC LIMIT $2`,
      [rows.map((r) => r.task_id), MAX_EVENTS_KEPT * rows.length],
    )
    const byTask = new Map<string, RunEvent[]>()
    for (const e of evs) {
      const list = byTask.get(e.task_id) ?? []
      list.push({
        at: e.at.getTime(),
        phase: (RUN_PHASES as readonly string[]).includes(e.phase) ? (e.phase as RunPhase) : 'code',
        level: e.level === 'good' || e.level === 'bad' ? e.level : 'info',
        path: e.path,
        text: e.text,
      })
      byTask.set(e.task_id, list)
    }
    return rows.map((r) => toRun(r, byTask.get(r.task_id) ?? []))
  } catch {
    return []
  }
}
