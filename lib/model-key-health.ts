/**
 * Model-key health — did the platform's last LLM call actually work?
 *
 * Found live (2026-08-31): the heartbeat was healthy, delegation ticks ran
 * every five minutes, and every single one died on the same line — the
 * Anthropic key's credit balance was zero — while `self-ops` reported "all
 * clear". Grading, assisted MCP writes and auto-replies all sit on that key;
 * when it dies, the platform doesn't fail, it goes silently inert, which is
 * the exact shape of failure `lib/self-ops.ts` exists to name.
 *
 * One row, last outcome wins. Not a metrics store: self-ops needs "is the
 * key usable right now", and the freshest call answers that better than any
 * aggregate. Recording is best-effort and never throws into a caller — a
 * health tracker that can break grading would cost more than it reports.
 * Self-migrating like ops_leases, so no migration gates it.
 */
import { pool } from '@/lib/db'

export type ModelCallHealth = {
  ok: boolean
  /** Error text when !ok (truncated); null on success. */
  reason: string | null
  /** ms epoch of the recorded call. */
  at: number
}

let tableReady: Promise<void> | null = null
function ensureTable(): Promise<void> {
  tableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS model_call_health (
         id text PRIMARY KEY,
         ok boolean NOT NULL,
         reason text,
         at timestamptz NOT NULL
       )`,
    )
    .then(() => undefined)
  return tableReady
}

export async function recordModelCallOutcome(ok: boolean, reason?: unknown): Promise<void> {
  try {
    await ensureTable()
    const text = ok
      ? null
      : String(reason instanceof Error ? reason.message : (reason ?? 'unknown')).slice(0, 500)
    await pool.query(
      `INSERT INTO model_call_health (id, ok, reason, at) VALUES ('llm', $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET ok = $1, reason = $2, at = now()`,
      [ok, text],
    )
  } catch (error) {
    console.warn('[model-key-health] recording failed (ignored):', error)
  }
}

export async function readModelCallHealth(): Promise<ModelCallHealth | null> {
  try {
    await ensureTable()
    const { rows } = await pool.query(`SELECT ok, reason, at FROM model_call_health WHERE id = 'llm'`)
    if (!rows[0]) return null
    return { ok: rows[0].ok, reason: rows[0].reason ?? null, at: new Date(rows[0].at).getTime() }
  } catch {
    return null
  }
}
