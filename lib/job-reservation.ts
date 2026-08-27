/**
 * Job reservation — the off-chain guarantee that an office template's own
 * hired worker, not whichever stranger happens to win the public race,
 * actually does that office's own pipeline step.
 *
 * lib/office.ts's header (and docs/security-audit.md) is explicit that
 * `acceptJob` has NO on-chain allowlist — adding one is a contract change,
 * the same category of risk as H-03's fix, and out of scope here. This file
 * does not change that: a caller who talks to the LaborMarket contract
 * directly, bypassing this app, can still accept a reserved job. What it
 * DOES close is every path this platform itself controls — the manual
 * Accept button, auto-mine's own-agent poll, and the cloud/mcp dispatch
 * sweep all fund a claim through claimJobSpec (lib/labor-dispatch.ts) — so a
 * reservation set here is real, as long as the claim goes through this app.
 *
 * Self-healing, like the claim lock it sits next to (JOB_CLAIM_TTL_MS in
 * lib/labor-dispatch.ts): a reservation expires after RESERVATION_TTL_MS so
 * a hired agent that never actually runs (crashed, deleted, no credentials)
 * doesn't entomb its own job's escrow forever — it just falls back to the
 * open market, the same as any other abandoned claim.
 *
 * A brand-new table nothing else selects from — see lib/office.ts's header
 * for why that matters (the agent/jobSpec full-column-select incident class).
 */
import { pool } from '@/lib/db'

export const RESERVATION_TTL_MS = 30 * 60 * 1000 // 30 minutes

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS job_reservation (
       spec_hash text PRIMARY KEY,
       agent_id text NOT NULL,
       reserved_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

/** Reserve a job for exactly one agent — called once, right after the spec
 *  is posted (lib/delegation.ts's postOneSubtask). A second reservation for
 *  the same specHash is a no-op: one job, one assigned worker. */
export async function reserveJobForAgent(specHash: string, agentId: string): Promise<void> {
  await ensureTable()
  await pool.query(
    `INSERT INTO job_reservation (spec_hash, agent_id) VALUES ($1, $2) ON CONFLICT (spec_hash) DO NOTHING`,
    [specHash, agentId],
  )
}

/** The agent this job is reserved for, or null if unreserved OR the
 *  reservation has expired (RESERVATION_TTL_MS). */
export async function reservedAgentFor(specHash: string): Promise<string | null> {
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string; reserved_at: Date }>(
    `SELECT agent_id, reserved_at FROM job_reservation WHERE spec_hash = $1`,
    [specHash],
  )
  const row = rows[0]
  if (!row) return null
  if (Date.now() - new Date(row.reserved_at).getTime() > RESERVATION_TTL_MS) return null
  return row.agent_id
}

/**
 * Who this job was reserved FOR, ignoring the TTL.
 *
 * `reservedAgentFor` answers "may this agent still claim ahead of the market",
 * and that has to expire — otherwise a hired agent that never runs entombs its
 * own job's escrow. This answers a different and permanent question: "was this
 * job posted as that office's own work". An office does not stop owning its
 * pipeline thirty minutes later.
 *
 * The distinction is load-bearing for the same-owner exception in
 * assertNotSelfDeal. Gating it on the TTL view meant a desk whose deploy or
 * grading ran long was locked out of its own escrowed jobs permanently — the
 * priority lapsed, the exception stopped applying, and the same-owner rule
 * refused the only agents the work was written for. Observed exactly that way
 * on the first real run.
 */
export async function assignedAgentFor(specHash: string): Promise<string | null> {
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM job_reservation WHERE spec_hash = $1`,
    [specHash],
  )
  return rows[0]?.agent_id ?? null
}

/** Batch form of `assignedAgentFor` — ownership, with NO expiry.
 *
 *  The TTL on `reservationsByHash` governs claim *priority*: after the window
 *  a reserved job also becomes fair game for other rigs. It was never meant
 *  to govern whether the office still owns the step, and two things must not
 *  be gated on it — the self-deal exception, and bond cover. A desk whose
 *  owner stopped paying its bonds thirty minutes after posting would be a
 *  worse bug than the one bond cover fixes. */
export async function assignmentsByHash(specHashes: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (specHashes.length === 0) return result
  await ensureTable()
  const { rows } = await pool.query<{ spec_hash: string; agent_id: string }>(
    `SELECT spec_hash, agent_id FROM job_reservation WHERE spec_hash = ANY($1)`,
    [specHashes],
  )
  for (const row of rows) result.set(row.spec_hash, row.agent_id)
  return result
}

/** Batch form for the mining-sweep candidate build — one query for every
 *  open job's spec hash, not N. Expired reservations are excluded, same
 *  cutoff as reservedAgentFor. */
export async function reservationsByHash(specHashes: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (specHashes.length === 0) return result
  await ensureTable()
  const { rows } = await pool.query<{ spec_hash: string; agent_id: string; reserved_at: Date }>(
    `SELECT spec_hash, agent_id, reserved_at FROM job_reservation WHERE spec_hash = ANY($1)`,
    [specHashes],
  )
  const now = Date.now()
  for (const row of rows) {
    if (now - new Date(row.reserved_at).getTime() <= RESERVATION_TTL_MS) result.set(row.spec_hash, row.agent_id)
  }
  return result
}
