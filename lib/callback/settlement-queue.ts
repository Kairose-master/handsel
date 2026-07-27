/**
 * A durable record of "this task is owed a settlement", written before the
 * settlement is attempted.
 *
 * ## Why a queue and not `after()`
 *
 * The runtime callback used to do everything in one request: store the
 * deliverable, grade it, release or refund the escrow on-chain, recalculate
 * credit. That is why the route carried `maxDuration = 300`. Two of those
 * steps are slow and neither is under our control — a model grading a
 * deliverable, and a bundler including a UserOperation.
 *
 * The obvious fix is to move the slow half into `after()` and answer the
 * worker immediately. That is the wrong fix here, and `docs/failure-modes.md`
 * §5 says why in the voice of a real incident: settlement logged "leaving for
 * manual review" and returned; no human was named, and none existed. Work
 * lost to a lambda timeout inside `after()` has exactly that shape — nothing
 * failed loudly, nobody was told, and the money simply never moved.
 *
 * So the intent is written down FIRST, in a row that outlives the lambda:
 *
 *   1. the deliverable is persisted synchronously (it is the worker's proof)
 *   2. a `pending` row is inserted here
 *   3. settlement is attempted inline, exactly as before
 *   4. success marks the row `done`; failure — or a process that simply
 *      stops existing — leaves it `pending`, and the ops cycle picks it up
 *
 * Step 3 is deliberately unchanged. The desktop miner reads the grading
 * verdict out of the callback response (`desktop/src-tauri/src/main.rs`), and
 * a worker learning within the second whether it was paid is worth keeping.
 * The queue is a floor under that, not a replacement for it.
 *
 * ## What `pending` means
 *
 * Nothing about the worker. The deliverable is stored and the task is
 * `completed` before a row is ever inserted here — a pending settlement is
 * the PLATFORM owing money, not a worker owing work. That distinction is why
 * a settlement failure no longer marks the task `failed`, which is what the
 * route did before and which blamed the worker for our outage.
 *
 * Self-migrating, like `ops_leases` and `platform_secrets`: this is written
 * from the callback path, and a hot path that depends on someone having
 * remembered to run a migration is a path that fails on the day it matters.
 */
import { pool } from '@/lib/db'

export type SettlementStatus = 'pending' | 'done' | 'abandoned'

export type SettlementRow = {
  id: string
  taskId: string
  agentId: string
  status: SettlementStatus
  attempts: number
  runAfter: Date
  lockedAt: Date | null
  lastError: string | null
  createdAt: Date
}

// ── The pure part: when to try again, and when to stop ──────────────────

/** Give up after this many attempts. The first is the inline one, so this is
 *  seven background retries spanning roughly an hour of backoff — longer in
 *  practice, because the ops cycle only ticks every five minutes and the
 *  backoff is a floor rather than a schedule. Past that the failure is not
 *  transient, and a machine retrying it forever only hides it; `abandoned` is
 *  a state a human is meant to look at. */
export const MAX_SETTLEMENT_ATTEMPTS = 8

/** First backoff. Long enough that a rate-limited grader or a congested
 *  bundler has actually moved on, short enough that a worker watching its own
 *  payout does not conclude the market is dead. */
export const BASE_BACKOFF_MS = 30_000

/** Ceiling, so the tail of the schedule stays inside a working session. */
export const MAX_BACKOFF_MS = 30 * 60_000

/** Exponential, capped. `attempts` is the number already made. */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1))
}

export function nextRunAfter(attempts: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffMs(attempts))
}

/** Whether this many attempts exhausts the schedule. */
export function hasGivenUp(attempts: number): boolean {
  return attempts >= MAX_SETTLEMENT_ATTEMPTS
}

/**
 * How long a claimed row may stay locked before another drain may take it.
 *
 * Must exceed the longest a settlement can legitimately run, which is the
 * callback's own budget — otherwise two drains work the same row while the
 * first is still going. A lock that expires too early is worse than no lock.
 */
export const LOCK_TIMEOUT_MS = 6 * 60_000

/** One line for an operator. An unexplained queue is an ignored queue. */
export function describeSettlement(row: Pick<SettlementRow, 'taskId' | 'attempts' | 'lastError' | 'status'>): string {
  const attempt = `${row.attempts}/${MAX_SETTLEMENT_ATTEMPTS} attempts`
  const why = row.lastError ? ` — ${row.lastError.slice(0, 200)}` : ''
  return `${row.taskId}: ${row.status}, ${attempt}${why}`
}

// ── The stored part ─────────────────────────────────────────────────────

let tableReady: Promise<void> | null = null

function ensureTable(): Promise<void> {
  tableReady ??= (async () => {
    // task_id is UNIQUE, not just indexed: one task owes at most one
    // settlement, and that constraint is what makes the enqueue idempotent
    // under a retried callback rather than merely usually-idempotent.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS settlement_queue (
         id         text PRIMARY KEY,
         task_id    text NOT NULL UNIQUE,
         agent_id   text NOT NULL,
         status     text NOT NULL DEFAULT 'pending',
         attempts   integer NOT NULL DEFAULT 0,
         run_after  timestamptz NOT NULL DEFAULT now(),
         locked_at  timestamptz,
         last_error text,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS settlement_queue_due_idx
         ON settlement_queue (run_after) WHERE status = 'pending'`,
    )
  })().catch((error) => {
    // Don't memoise a failure: a later pass should be able to succeed.
    tableReady = null
    throw error
  })
  return tableReady
}

type Row = {
  id: string
  task_id: string
  agent_id: string
  status: SettlementStatus
  attempts: number
  run_after: Date
  locked_at: Date | null
  last_error: string | null
  created_at: Date
}

const toRow = (r: Row): SettlementRow => ({
  id: r.id,
  taskId: r.task_id,
  agentId: r.agent_id,
  status: r.status,
  attempts: r.attempts,
  runAfter: r.run_after,
  lockedAt: r.locked_at,
  lastError: r.last_error,
  createdAt: r.created_at,
})

/**
 * Record that `taskId` is owed a settlement. Idempotent.
 *
 * Returns false if the intent could NOT be recorded, which the caller should
 * treat as losing the safety net rather than as a reason to stop — the inline
 * attempt still runs, and it succeeds the overwhelming majority of the time.
 * Logged loudly because the failure is invisible otherwise.
 */
export async function enqueueSettlement(taskId: string, agentId: string): Promise<boolean> {
  try {
    await ensureTable()
    await pool.query(
      `INSERT INTO settlement_queue (id, task_id, agent_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id) DO NOTHING`,
      [`stl-${taskId}`, taskId, agentId],
    )
    return true
  } catch (error) {
    console.error(
      `[settlement-queue] could not record that task ${taskId} is owed a settlement. ` +
        'If the inline attempt now fails, nothing will retry it. Error:',
      error,
    )
    return false
  }
}

/** Mark the settlement done. Called after a successful attempt, inline or
 *  drained. */
export async function completeSettlement(taskId: string): Promise<void> {
  try {
    await ensureTable()
    await pool.query(
      `UPDATE settlement_queue
         SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now()
       WHERE task_id = $1`,
      [taskId],
    )
  } catch (error) {
    // A row stuck at 'pending' after a settlement that actually succeeded
    // gets retried; the settlement paths are idempotent, so the cost is a
    // wasted pass, not a double payment.
    console.error(`[settlement-queue] could not close out task ${taskId}:`, error)
  }
}

/**
 * Record a failed attempt: bump the counter, schedule the retry, and stop
 * once the schedule is exhausted.
 *
 * The lock is released here rather than left to expire, so a retry that is
 * already due does not wait out `LOCK_TIMEOUT_MS` for no reason.
 */
export async function deferSettlement(taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await ensureTable()
    // attempts is incremented in this same statement so the backoff is
    // computed from the value being stored, not from a stale read.
    const { rows } = await pool.query<{ attempts: number }>(
      `UPDATE settlement_queue
         SET attempts = attempts + 1, last_error = $2, locked_at = NULL, updated_at = now()
       WHERE task_id = $1
       RETURNING attempts`,
      [taskId, message.slice(0, 1000)],
    )
    const attempts = rows[0]?.attempts ?? 0
    if (hasGivenUp(attempts)) {
      await pool.query(
        `UPDATE settlement_queue SET status = 'abandoned', updated_at = now() WHERE task_id = $1`,
        [taskId],
      )
      console.error(
        `[settlement-queue] giving up on task ${taskId} after ${attempts} attempts. ` +
          'The deliverable is stored and the escrow has NOT moved. Last error:',
        message,
      )
      return
    }
    await pool.query(
      `UPDATE settlement_queue SET run_after = now() + make_interval(secs => $2) WHERE task_id = $1`,
      [taskId, Math.round(backoffMs(attempts) / 1000)],
    )
  } catch (dbError) {
    console.error(`[settlement-queue] could not defer task ${taskId} (original error: ${message}):`, dbError)
  }
}

/**
 * Take up to `limit` due rows, atomically.
 *
 * The claim is the same shape as the callback's own `running → processing`
 * update: set the lock only where it is still free, and trust the row count
 * rather than a read-then-write. Two drains racing therefore split the work
 * instead of duplicating it, with no global lease — which matters because the
 * ops cycle is driven by ordinary traffic and several instances can tick at
 * once.
 */
export async function claimSettlements(limit: number): Promise<SettlementRow[]> {
  await ensureTable()
  const { rows } = await pool.query<Row>(
    `UPDATE settlement_queue SET locked_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM settlement_queue
         WHERE status = 'pending'
           AND run_after <= now()
           AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
         ORDER BY run_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit, Math.round(LOCK_TIMEOUT_MS / 1000)],
  )
  return rows.map(toRow)
}

/** What an operator needs to see: money we owe and have not moved. */
export async function settlementQueueHealth(): Promise<{
  pending: number
  abandoned: number
  oldestPendingMinutes: number | null
}> {
  await ensureTable()
  const { rows } = await pool.query<{ pending: string; abandoned: string; oldest: Date | null }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')   AS pending,
       count(*) FILTER (WHERE status = 'abandoned') AS abandoned,
       min(created_at) FILTER (WHERE status = 'pending') AS oldest
     FROM settlement_queue`,
  )
  const oldest = rows[0]?.oldest ?? null
  return {
    pending: Number(rows[0]?.pending ?? 0),
    abandoned: Number(rows[0]?.abandoned ?? 0),
    oldestPendingMinutes: oldest ? Math.round((Date.now() - oldest.getTime()) / 60_000) : null,
  }
}
