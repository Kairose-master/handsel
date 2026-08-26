/**
 * Per-agent MCP connector mode, in its own self-migrating table.
 *
 * Deliberately NOT a column on `agents`. `select().from(agent)` expands to
 * every column schema.ts declares, so a column that ships before its
 * migration takes down every reader of that table rather than just the
 * feature using it — the failure lib/db/ensure-columns.ts's header records as
 * having bitten twice, and `agents` has no self-heal of its own. A side table
 * keyed by agent id is the pattern `agent_office_slot` already uses for the
 * same reason.
 *
 * Absent row = 'proxy', which is the behavior every MCP worker had before
 * modes existed, so nothing registered earlier changes.
 */
import { pool } from '@/lib/db'
import { isMcpMode, type McpMode } from '@/lib/mcp-assist'

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS agent_mcp_mode (
       agent_id text PRIMARY KEY,
       mode text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

/** One agent's mode. Never throws: a dispatch must not fail because a
 *  bookkeeping table could not be read — it falls back to the old behavior,
 *  which is the safe direction (proxy submits what the tool said; assisted
 *  spends the owner's model tokens). */
export async function getMcpMode(agentId: string): Promise<McpMode> {
  try {
    await ensureTable()
    const { rows } = await pool.query<{ mode: string }>(
      `SELECT mode FROM agent_mcp_mode WHERE agent_id = $1`,
      [agentId],
    )
    const mode = rows[0]?.mode
    return isMcpMode(mode) ? mode : 'proxy'
  } catch (error) {
    console.error('[mcp-mode] read failed, falling back to proxy:', error)
    return 'proxy'
  }
}

/** Modes for several agents at once, for the roster view. */
export async function getMcpModes(agentIds: string[]): Promise<Map<string, McpMode>> {
  const out = new Map<string, McpMode>(agentIds.map((id) => [id, 'proxy' as McpMode]))
  if (agentIds.length === 0) return out
  try {
    await ensureTable()
    const { rows } = await pool.query<{ agent_id: string; mode: string }>(
      `SELECT agent_id, mode FROM agent_mcp_mode WHERE agent_id = ANY($1)`,
      [agentIds],
    )
    for (const r of rows) if (isMcpMode(r.mode)) out.set(r.agent_id, r.mode)
    return out
  } catch (error) {
    console.error('[mcp-mode] bulk read failed, falling back to proxy:', error)
    return out
  }
}

/** Write an agent's mode. 'proxy' deletes the row rather than storing the
 *  default, so the table only ever holds the exceptions. */
export async function setMcpMode(agentId: string, mode: McpMode): Promise<void> {
  await ensureTable()
  if (mode === 'proxy') {
    await pool.query(`DELETE FROM agent_mcp_mode WHERE agent_id = $1`, [agentId])
    return
  }
  await pool.query(
    `INSERT INTO agent_mcp_mode (agent_id, mode) VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET mode = $2, updated_at = now()`,
    [agentId, mode],
  )
}
