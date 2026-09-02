#!/usr/bin/env node
/**
 * External revenue, from the ledger, with the faucet and the operator taken out.
 *
 *   DATABASE_URL=… ADMIN_EMAIL=… node scripts/external-revenue.mjs [days]
 *
 * Node 22.18+ (imports lib/external-revenue.ts directly). Reads JOB_COMPLETED
 * events — written only for arm's-length requester/worker pairs — and resolves
 * each requester agent to its owning account so operator-owned requesters can
 * be excluded by owner, not by agent name.
 */
import { Pool } from 'pg'

const days = Number(process.argv[2]) || 3650
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const { rows } = await pool.query(
  `SELECT e.detail, e.created_at, a.id AS req_agent, a."userId" AS req_user
     FROM agent_events e
     LEFT JOIN agent a ON a.id = (e.detail->>'requesterAgentId')
    WHERE e.event_type = 'JOB_COMPLETED'
      AND e.created_at > now() - ($1 || ' days')::interval`,
  [String(days)],
)

// Faucet agent by its fixed email; operator by ADMIN_EMAIL. Both resolved to
// ids here so the pure module never sees an email.
const { rows: faucet } = await pool.query(
  `SELECT a.id FROM agent a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1 LIMIT 1`,
  ['faucet@handsel.internal'],
)
const internal = new Set()
if (process.env.ADMIN_EMAIL) {
  const { rows: ops } = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [process.env.ADMIN_EMAIL])
  for (const r of ops) internal.add(r.id)
}
for (const extra of (process.env.INTERNAL_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) internal.add(extra)

const jobs = rows.map((r) => ({
  jobId: Number(r.detail?.jobId),
  bountyUsd: Number(r.detail?.bounty) || 0,
  requesterAgentId: r.req_agent ?? r.detail?.requesterAgentId ?? null,
  requesterUserId: r.req_user ?? null,
  settledAt: new Date(r.created_at),
}))

const { externalRevenue, renderExternalRevenue } = await import('../lib/external-revenue.ts')
console.log(renderExternalRevenue(externalRevenue(jobs, { faucetAgentId: faucet[0]?.id ?? null, internalUserIds: internal })))
await pool.end()
