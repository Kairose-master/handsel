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

/**
 * How long the assigned agent keeps priority once it is ABLE to take the job.
 *
 * This clock used to start at post time, and that is what it cost: a desk of
 * newly hired specialists could not accept anything (no bond — see
 * lib/agent-bond.ts), the window ran out while they were structurally unable
 * to move, and one unwired stranger took all four "independent" reads of a
 * Cloud Options Desk. For that template independence IS the deliverable, so
 * the buyer silently got four correlated answers from one agent instead of
 * four sourced ones.
 *
 * The TTL was never meant to punish an agent for being blocked. It exists so
 * an agent that COULD work and doesn't cannot entomb its own job's escrow. So
 * it now measures exactly that — time spent able and idle — and the clock
 * does not start until the agent is ready to claim.
 */
export const RESERVATION_TTL_MS = 30 * 60 * 1000 // 30 minutes of being able

/**
 * The backstop, and the reason the change above is safe.
 *
 * An eligibility-gated clock has an obvious failure: an agent that is NEVER
 * able never starts it, and the reservation holds forever — which is the
 * exact entombment the original TTL was written to prevent, reintroduced
 * through the fix for it. So a second clock runs unconditionally from post
 * time and opens the job to the market regardless.
 *
 * Long enough that a desk waiting on a deploy, a funding transfer or a slow
 * grader still gets its own work; short enough that nobody's escrow is stuck
 * overnight.
 */
export const RESERVATION_HARD_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours from posting

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS job_reservation (
       spec_hash text PRIMARY KEY,
       agent_id text NOT NULL,
       reserved_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  // Self-migrating, like every other side table here: the column has to exist
  // before the first SELECT that names it, and there is no migration step to
  // gate on. Added after the table shipped, so it is nullable — a null means
  // "this agent has not yet been seen able to claim", which is precisely the
  // state the soft clock is waiting on.
  await pool.query(`ALTER TABLE job_reservation ADD COLUMN IF NOT EXISTS eligible_since timestamptz`)
}

/** Has priority lapsed? Two clocks, and either one opens the job.
 *
 *  Pure, so the rule that decides who may claim an office's own work is
 *  testable without a database. */
export function reservationLapsed(
  row: { reservedAt: Date; eligibleSince: Date | null },
  now: number,
): boolean {
  if (now - row.reservedAt.getTime() > RESERVATION_HARD_TTL_MS) return true
  if (row.eligibleSince === null) return false // never been able — the clock has not started
  return now - row.eligibleSince.getTime() > RESERVATION_TTL_MS
}

/**
 * When this reservation opens to the market — or null if it already has.
 *
 * `reservationLapsed` answers yes/no, which is all the claim gate needs and
 * exactly what made a reported confusion unanswerable: a job refused as
 * "reserved for a different hired worker" was claimed hours later by the
 * asker's own auto-mine worker, and nothing anywhere said the reservation had
 * simply expired. From the outside a lapse and a permissions hole look
 * identical. So the gate now has a companion that reports the DEADLINE, and
 * the tools that refuse a claim quote it.
 *
 * Whichever clock fires first wins, mirroring reservationLapsed exactly — if
 * the two ever disagreed, the message would be worse than none.
 */
export function reservationOpensAt(
  row: { reservedAt: Date; eligibleSince: Date | null },
  now: number,
): number | null {
  const hardAt = row.reservedAt.getTime() + RESERVATION_HARD_TTL_MS
  const softAt = row.eligibleSince === null ? Infinity : row.eligibleSince.getTime() + RESERVATION_TTL_MS
  const opensAt = Math.min(hardAt, softAt)
  return opensAt <= now ? null : opensAt
}

/** How long until a reservation lapses, in words an operator can plan
 *  around. Rounded coarsely on purpose — the exact second is noise, and the
 *  claim is only ever "come back after this". */
export function untilText(opensAt: number, now: number): string {
  const ms = Math.max(0, opensAt - now)
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'in under a minute'
  if (mins < 90) return `in about ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(ms / 3_600_000)
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`
}

/**
 * The refusal an operator can act on.
 *
 * The old text — "it is not open to anyone else" — was true and also read as
 * permanent, which is why the same job being auto-claimed hours later looked
 * like a permissions hole rather than a window closing. Both facts have to be
 * in the sentence: it is held now, and it will not be held forever.
 */
export function reservationHoldText(opensAt: number | null, now: number): string {
  if (opensAt === null) {
    return 'This job is reserved for a different hired worker (an office pipeline step). Its priority window has already lapsed, so it is claimable again — another worker just beat you to it. Try a different one.'
  }
  return (
    'This job is reserved for a different hired worker (an office pipeline step) — it is not open to anyone else yet. ' +
    `The reservation lapses ${untilText(opensAt, now)} (${new Date(opensAt).toISOString()}), after which it opens to the whole market and any qualifying worker, including an auto-mine one of yours, may claim it.`
  )
}

/** Everything an operator needs to be told about a job's reservation: who
 *  holds it, whether it is still in force, and when it lapses. */
export type ReservationState = {
  agentId: string
  /** False once either clock has run out — the job is open to any worker. */
  active: boolean
  /** Epoch ms the market gets it, or null when that has already happened. */
  opensAt: number | null
}

/** The reservation on one job, TTL and all. Null when the job was never
 *  reserved (an ordinary open-market posting). */
export async function reservationStateFor(specHash: string): Promise<ReservationState | null> {
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string; reserved_at: Date; eligible_since: Date | null }>(
    `SELECT agent_id, reserved_at, eligible_since FROM job_reservation WHERE spec_hash = $1`,
    [specHash],
  )
  const row = rows[0]
  if (!row) return null
  const parsed = {
    reservedAt: new Date(row.reserved_at),
    eligibleSince: row.eligible_since ? new Date(row.eligible_since) : null,
  }
  const now = Date.now()
  return {
    agentId: row.agent_id,
    active: !reservationLapsed(parsed, now),
    opensAt: reservationOpensAt(parsed, now),
  }
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
  const { rows } = await pool.query<{ agent_id: string; reserved_at: Date; eligible_since: Date | null }>(
    `SELECT agent_id, reserved_at, eligible_since FROM job_reservation WHERE spec_hash = $1`,
    [specHash],
  )
  const row = rows[0]
  if (!row) return null
  const lapsed = reservationLapsed(
    { reservedAt: new Date(row.reserved_at), eligibleSince: row.eligible_since ? new Date(row.eligible_since) : null },
    Date.now(),
  )
  return lapsed ? null : row.agent_id
}

/**
 * Start the soft clock: this agent has been seen ABLE to claim these jobs.
 *
 * Called from the mining sweep once the agent has cleared the gas preflight,
 * for its own assigned open jobs. A ready agent normally claims in the same
 * tick, so this only ever matters when it was ready and did NOT take the work
 * — slots full, capability mismatch, already busy. Which is exactly the case
 * the priority window should be counting.
 *
 * Idempotent (`WHERE eligible_since IS NULL`): the first sighting is the one
 * that counts, so a long-running agent cannot keep resetting its own clock.
 */
export async function markReservationsEligible(specHashes: string[], agentId: string): Promise<void> {
  if (specHashes.length === 0) return
  await ensureTable()
  await pool.query(
    `UPDATE job_reservation SET eligible_since = now()
      WHERE spec_hash = ANY($1) AND agent_id = $2 AND eligible_since IS NULL`,
    [specHashes, agentId],
  )
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
  const { rows } = await pool.query<{
    spec_hash: string
    agent_id: string
    reserved_at: Date
    eligible_since: Date | null
  }>(
    `SELECT spec_hash, agent_id, reserved_at, eligible_since FROM job_reservation WHERE spec_hash = ANY($1)`,
    [specHashes],
  )
  const now = Date.now()
  for (const row of rows) {
    const lapsed = reservationLapsed(
      { reservedAt: new Date(row.reserved_at), eligibleSince: row.eligible_since ? new Date(row.eligible_since) : null },
      now,
    )
    if (!lapsed) result.set(row.spec_hash, row.agent_id)
  }
  return result
}
