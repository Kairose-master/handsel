/**
 * Storage for auto-mine scope (lib/mine-scope.ts).
 *
 * A side table, not a column on `agent`, for the reason documented at the top
 * of lib/db/ensure-columns.ts and repeated in lib/office.ts: `agent` is read
 * as `db.select().from(agent)` at dozens of call sites and drizzle expands
 * that to name every declared column, so a new column breaks all of them from
 * the moment it deploys until someone runs a migration by hand. A brand-new
 * table nothing else selects from has no such window.
 *
 * Only EXPLICIT choices are stored. Absence is meaningful: it means the
 * worker's scope is still the derived default, which is what lets the fix
 * apply to offices hired long before scope existed.
 */
import { pool } from '@/lib/db'
import { normalizeMineScope, resolveMineScope, type MineScope } from '@/lib/mine-scope'

let ready: Promise<void> | null = null
async function ensureTable(): Promise<void> {
  // Not cached on failure — a transient error must not leave every later call
  // believing the table exists.
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS agent_mine_scope (
           agent_id text PRIMARY KEY,
           scope text NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        ready = null
        throw e
      })
  }
  return ready
}

/** The explicitly chosen scope for each of the given agents, where one was
 *  chosen. Agents absent from the map have made no choice. */
export async function storedMineScopes(agentIds: string[]): Promise<Map<string, MineScope>> {
  const out = new Map<string, MineScope>()
  if (agentIds.length === 0) return out
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string; scope: string }>(
    `SELECT agent_id, scope FROM agent_mine_scope WHERE agent_id = ANY($1)`,
    [agentIds],
  )
  for (const row of rows) {
    const scope = normalizeMineScope(row.scope)
    if (scope) out.set(row.agent_id, scope)
  }
  return out
}

/** Record an owner's explicit choice. */
export async function setMineScope(agentId: string, scope: MineScope): Promise<void> {
  await ensureTable()
  await pool.query(
    `INSERT INTO agent_mine_scope (agent_id, scope) VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET scope = $2, updated_at = now()`,
    [agentId, scope],
  )
}

export type EffectiveMineScope = { scope: MineScope; explicit: boolean }

/**
 * The scope actually in force for one agent, and whether the owner chose it.
 *
 * Degrades to the derived default on a read failure rather than throwing:
 * a database hiccup must not decide a worker's mandate, and the derived
 * default is the conservative half of the pair for exactly the agents that
 * needed protecting.
 */
export async function effectiveMineScope(agentId: string): Promise<EffectiveMineScope> {
  const [stored, roleIds] = await Promise.all([
    storedMineScopes([agentId]).catch(() => new Map<string, MineScope>()),
    (async () => {
      const { officeRoleAgentIds } = await import('@/lib/office')
      return officeRoleAgentIds([agentId]).catch(() => new Set<string>())
    })(),
  ])
  const explicit = stored.get(agentId) ?? null
  return {
    scope: resolveMineScope({ stored: explicit, hiredForOfficeRole: roleIds.has(agentId) }),
    explicit: explicit !== null,
  }
}
