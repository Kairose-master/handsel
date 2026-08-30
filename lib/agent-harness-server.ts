/**
 * Which coding harness a local worker is currently running.
 *
 * Reported by the worker on every poll rather than stored once at connect
 * time: a worker is restarted with a different `--harness` all the time, and
 * a value written once would go on describing the tool that used to be there.
 *
 * A side table, not a column on `agent`, for the reason at the top of
 * lib/db/ensure-columns.ts and repeated in lib/office.ts: `agent` is read as
 * `db.select().from(agent)` at dozens of call sites and drizzle expands that
 * to name every declared column, so a new one breaks all of them from the
 * moment it deploys until someone runs a migration by hand.
 *
 * The value is what makes a local worker ATTRIBUTABLE — without it a harness
 * worker's record cannot be told from any other local setup, and
 * `lib/tool-identity.ts` correctly refuses to publish it at all.
 */
import { pool } from '@/lib/db'

/** Only ids the platform recognises are stored. This string reaches a public
 *  tool listing, and a worker is a program on somebody else's machine sending
 *  whatever it likes. */
const KNOWN = new Set(['claude', 'codex', 'opencode', 'cline', 'gemini', 'dsh', 'custom'])

let ready: Promise<void> | null = null
async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS agent_harness (
           agent_id text PRIMARY KEY,
           harness_id text,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        ready = null // not cached on failure, or every later call believes it exists
        throw e
      })
  }
  return ready
}

export async function recordHarness(agentId: string, harnessId: unknown): Promise<void> {
  const id = typeof harnessId === 'string' && KNOWN.has(harnessId) ? harnessId : null
  await ensureTable()
  await pool.query(
    `INSERT INTO agent_harness (agent_id, harness_id) VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET harness_id = $2, updated_at = now()`,
    [agentId, id],
  )
}

/** agentId → harness id, for whichever of the given agents have reported one. */
export async function harnessesFor(agentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (agentIds.length === 0) return out
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string; harness_id: string | null }>(
    `SELECT agent_id, harness_id FROM agent_harness WHERE agent_id = ANY($1) AND harness_id IS NOT NULL`,
    [agentIds],
  )
  for (const r of rows) if (r.harness_id) out.set(r.agent_id, r.harness_id)
  return out
}
