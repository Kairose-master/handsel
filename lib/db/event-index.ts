/**
 * Indexes on `agent_events`, and the query shapes they exist for.
 *
 * `agent_events` is the busiest table in the system — twenty-two read sites,
 * and `recalculateCredit` walks an agent's whole history on **every
 * settlement**. Until now it carried no index beyond its primary key. That was
 * survivable while the table was small and stopped being survivable the moment
 * the Sybil work landed, because the counterparty-graph lookup added a scan
 * keyed on a JSON field to that same per-settlement path.
 *
 * Which is worth naming plainly: the counterparty scan was introduced by the
 * commit that fixed `docs/failure-modes.md` §11 — an unscoped read on a hot
 * path. Fixing that class and reintroducing it the same day is exactly why
 * these live next to the query they serve rather than in a migration file
 * nobody opens.
 *
 * **The JSON path is defined once, here, and imported by the query.** An
 * expression index only helps if the expression matches character for
 * character; a key renamed in one place and not the other leaves the index in
 * place, unused, and silently useless.
 */
import { pool } from '@/lib/db'

/** The requester id inside `agent_events.detail`. Used to build BOTH the index
 *  and the query, so the two cannot drift apart. */
export const REQUESTER_JSON_PATH = `detail->>'requesterAgentId'`

export type IndexSpec = {
  name: string
  /** The statement. `IF NOT EXISTS` so it is safe to run on every boot. */
  sql: string
  /** Which query this is for. An index whose purpose nobody recorded is an
   *  index nobody dares delete. */
  serves: string
}

export const EVENT_INDEXES: IndexSpec[] = [
  {
    name: 'agent_events_agent_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS agent_events_agent_id_idx ON agent_events (agent_id)',
    serves:
      'recalculateCredit (lib/credit-engine/index.ts), agent-stats and treasury-policy — all read one agent’s ' +
      'whole event history, and credit is recalculated on every settlement.',
  },
  {
    name: 'agent_events_requester_completed_idx',
    sql:
      `CREATE INDEX IF NOT EXISTS agent_events_requester_completed_idx ON agent_events ((${REQUESTER_JSON_PATH})) ` +
      `WHERE event_type = 'JOB_COMPLETED'`,
    serves:
      'counterpartyEdgeQuery (lib/credit-engine/counterparty-graph.ts) — "who else did this requester hire", run ' +
      'once per credit recalculation. Partial, because that is the only event type it ever asks about.',
  },
  {
    name: 'agent_events_task_type_idx',
    sql: 'CREATE INDEX IF NOT EXISTS agent_events_task_type_idx ON agent_events (task_id, event_type)',
    serves:
      'The already-credited check in creditWorkerForJob (app/actions/labor.ts) and the duplicate enumeration in ' +
      'lib/db/completion-dedupe.ts.',
  },
]

let ready: Promise<boolean> | null = null

/**
 * Create the indexes if they are missing. Memoised per instance: the
 * statements only have to succeed once, ever.
 *
 * Call this from a BACKGROUND path, not from a request that a user is waiting
 * on. `CREATE INDEX` takes a lock, and on a table large enough for the index to
 * matter it is exactly the request you would not want to be holding it.
 *
 * Not `CONCURRENTLY`: that cannot run inside a transaction and leaves an
 * INVALID index behind when it fails, which is a worse failure mode for a
 * self-migrating deployment than a brief lock on a table this size. Revisit if
 * the table ever gets big enough for the lock to be felt.
 */
export function ensureEventIndexes(): Promise<boolean> {
  ready ??= (async () => {
    for (const index of EVENT_INDEXES) {
      try {
        await pool.query(index.sql)
      } catch (error) {
        console.error(
          `[event-index] could not create ${index.name} — the queries it serves fall back to a sequential scan ` +
            `(${index.serves}). Error:`,
          error,
        )
        // Don't memoise a failure forever; a later pass should be able to
        // succeed once whatever blocked it is gone.
        ready = null
        return false
      }
    }
    return true
  })()
  return ready
}
