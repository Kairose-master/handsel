/**
 * Lineage, against real data — the DB and chain half of lib/agent-lineage.ts
 * (which stays pure; same split as office-world-data / office-world-server).
 *
 * Two jobs, and the order they shipped in is the point:
 *
 *  1. **The dry run.** `buildLineageReport` reads what actually happened —
 *     independently graded verdicts, USDC that actually settled, live wallet
 *     balances, real agent ages — and reports what the selection rules WOULD
 *     do. It changes nothing. Nothing in this file spends money, creates an
 *     agent, or retires one.
 *  2. **The lineage record.** `recordBirth` / `markRetired` are the writes
 *     the wiring step will need, and the table they use is what makes
 *     generation depth answerable. Retirement lives here rather than as a
 *     column on `agent` on purpose: `agent` is selected with
 *     `db.select().from(agent)` at dozens of call sites, and a new column
 *     there breaks all of them until a migration runs (the incident class at
 *     the top of lib/db/ensure-columns.ts). A fresh table nothing selects
 *     from yet is safe to self-migrate.
 *
 * A dry run exists because the rules decide irreversible things. An owner
 * should be able to read "these three would be copied, this one would be
 * retired, and here is the graded record behind each call" and argue with it
 * while it is still a report.
 */
import { db, pool as pgPool } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { usdcBalanceOf } from '@/lib/onchain/treasury'
import { officeSlotsByAgentId } from '@/lib/office'
import { GRADED_PASS_EVENTS, GRADED_FAIL_EVENTS } from '@/lib/skill-eval'
import {
  DEFAULT_LIFECYCLE_POLICY,
  buildLineage,
  decideLifecycle,
  scoreFitness,
  type LifecyclePolicy,
  type LineageReport,
  type LineageReportRow,
  type LineageRow,
  type Mutation,
} from '@/lib/agent-lineage'

export type { LineageReport, LineageReportRow }

/** How far back fitness is measured. Selection should reward what an agent
 *  is doing now, not what it did in a quarter it has since drifted away
 *  from — but short enough windows starve of evidence, and this market's
 *  volume is low. Thirty days is the compromise, and the report always
 *  states it rather than implying "all time". */
export const LINEAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const GRADED_EVENT_TYPES: string[] = [...GRADED_PASS_EVENTS, ...GRADED_FAIL_EVENTS]
const PASS_EVENT_TYPES: string[] = [...GRADED_PASS_EVENTS]

/**
 * What selection would do to this account's agents right now. Read-only.
 *
 * `slot` scopes it to one office; omit for every agent on the account.
 */
export async function buildLineageReport(
  userId: string,
  slot?: number,
  policy?: Partial<LifecyclePolicy>,
): Promise<LineageReport> {
  const effectivePolicy = { ...DEFAULT_LIFECYCLE_POLICY, ...policy }
  const everyAgent = await db
    .select({
      id: agent.id,
      name: agent.name,
      smartAccountAddress: agent.smartAccountAddress,
      createdAt: agent.createdAt,
    })
    .from(agent)
    .where(eq(agent.userId, userId))

  let scoped = everyAgent
  if (slot !== undefined) {
    const slotByAgentId = await officeSlotsByAgentId(everyAgent.map((a) => a.id))
    scoped = everyAgent.filter((a) => slotByAgentId.get(a.id) === slot)
  }
  if (scoped.length === 0) {
    return {
      windowDays: Math.round(LINEAGE_WINDOW_MS / 86_400_000),
      policy: effectivePolicy,
      rows: [],
      counts: { replicate: 0, hold: 0, retire: 0 },
      balanceReadErrors: 0,
    }
  }

  const now = Date.now()
  const since = new Date(now - LINEAGE_WINDOW_MS)
  const ids = scoped.map((a) => a.id)

  // One windowed read for the whole cohort — graded verdicts and settled
  // payments in the same pass, using the event vocabulary skill-eval and the
  // Labor Index already share. JOB_COMPLETED is the payment record (it has no
  // symmetric failure event, so it never counts toward fitness) and is read
  // only for "is anything coming in?".
  const events = await db
    .select({ agentId: agentEvent.agentId, eventType: agentEvent.eventType, detail: agentEvent.detail })
    .from(agentEvent)
    .where(
      and(
        inArray(agentEvent.agentId, ids),
        inArray(agentEvent.eventType, [...GRADED_EVENT_TYPES, 'JOB_COMPLETED']),
        gte(agentEvent.createdAt, since),
      ),
    )

  const gradedByAgent = new Map<string, { at: Date; passed: boolean }[]>()
  const earnedByAgent = new Map<string, number>()
  for (const e of events) {
    if (e.eventType === 'JOB_COMPLETED') {
      const bounty = (e.detail as { bounty?: number } | null)?.bounty
      if (typeof bounty === 'number') earnedByAgent.set(e.agentId, (earnedByAgent.get(e.agentId) ?? 0) + bounty)
      continue
    }
    const list = gradedByAgent.get(e.agentId) ?? []
    // The date is unused by scoreFitness (the window is already applied) but
    // the shape is skill-eval's GradedOutcome, kept so the two agree.
    list.push({ at: since, passed: PASS_EVENT_TYPES.includes(e.eventType) })
    gradedByAgent.set(e.agentId, list)
  }

  const balances = new Map<string, number | null>()
  await Promise.all(
    scoped.map(async (a) => {
      if (!a.smartAccountAddress) {
        // No wallet is not an unreadable wallet: an unprovisioned agent
        // genuinely holds nothing, and saying "unknown" would exempt it from
        // the starvation rule forever.
        balances.set(a.id, 0)
        return
      }
      balances.set(a.id, await usdcBalanceOf(a.smartAccountAddress as `0x${string}`).catch(() => null))
    }),
  )

  const { depthOf } = buildLineage(await lineageRowsFor(userId))

  const rows: LineageReportRow[] = scoped.map((a) => {
    const fitness = scoreFitness(gradedByAgent.get(a.id) ?? [])
    const heldUsd = balances.get(a.id) ?? null
    const earnedUsd = earnedByAgent.get(a.id) ?? 0
    const ageMs = now - a.createdAt.getTime()
    return {
      agentId: a.id,
      name: a.name,
      generation: depthOf.get(a.id) ?? 0,
      ageDays: Math.floor(ageMs / 86_400_000),
      graded: { passed: fitness.passed, total: fitness.total, passRate: fitness.passRate },
      earnedUsd,
      heldUsd,
      decision: decideLifecycle({ fitness, heldUsd, earnedUsd, ageMs, policy: effectivePolicy }),
    }
  })

  const counts = { replicate: 0, hold: 0, retire: 0 }
  for (const r of rows) counts[r.decision.action]++

  return {
    windowDays: Math.round(LINEAGE_WINDOW_MS / 86_400_000),
    policy: effectivePolicy,
    rows: rows.sort((a, b) => {
      const rank = { replicate: 0, retire: 1, hold: 2 }
      return rank[a.decision.action] - rank[b.decision.action] || b.graded.total - a.graded.total
    }),
    counts,
    balanceReadErrors: rows.filter((r) => r.heldUsd === null).length,
  }
}

/* ── The lineage record ──────────────────────────────────────────────── */

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS agent_lineage (
         child_agent_id text PRIMARY KEY,
         parent_agent_id text,
         user_id text NOT NULL,
         mutation jsonb NOT NULL DEFAULT '{}'::jsonb,
         seeded_usd numeric NOT NULL DEFAULT 0,
         born_at timestamptz NOT NULL DEFAULT now(),
         retired_at timestamptz,
         retire_reason text
       )`,
    )
    await pgPool.query(`CREATE INDEX IF NOT EXISTS agent_lineage_user ON agent_lineage (user_id)`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS agent_lineage_parent ON agent_lineage (parent_agent_id)`)
  })()
  return tableReady
}

/** Parent pointers for this account. Empty until replication is wired —
 *  which reads correctly as "every agent is a founder", not as missing data. */
export async function lineageRowsFor(userId: string): Promise<LineageRow[]> {
  await ensureTables()
  const { rows } = await pgPool.query<{ child_agent_id: string; parent_agent_id: string | null }>(
    `SELECT child_agent_id, parent_agent_id FROM agent_lineage WHERE user_id = $1`,
    [userId],
  )
  return rows.map((r) => ({ childAgentId: r.child_agent_id, parentAgentId: r.parent_agent_id }))
}

/** Record that `childAgentId` was spawned from `parentAgentId`. The caller
 *  creates the agent; this only remembers where it came from and what was
 *  changed, so a lineage stays auditable gene by gene. */
export async function recordBirth(input: {
  userId: string
  childAgentId: string
  parentAgentId: string | null
  mutation: Mutation
  seededUsd: number
}): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `INSERT INTO agent_lineage (child_agent_id, parent_agent_id, user_id, mutation, seeded_usd)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (child_agent_id) DO NOTHING`,
    [input.childAgentId, input.parentAgentId, input.userId, JSON.stringify(input.mutation), input.seededUsd],
  )
}

/** Mark an agent retired. Deliberately NOT a delete and NOT a flag on
 *  `agent`: its work proofs, credit score and failures stay exactly where
 *  they are and stay public. Retirement means "stop working it, stop funding
 *  it", never "erase it". */
export async function markRetired(userId: string, agentId: string, reason: string): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `INSERT INTO agent_lineage (child_agent_id, parent_agent_id, user_id, retired_at, retire_reason)
     VALUES ($1, NULL, $2, now(), $3)
     ON CONFLICT (child_agent_id) DO UPDATE SET retired_at = now(), retire_reason = $3`,
    [agentId, userId, reason],
  )
}

/** Agent ids this account has retired. */
export async function retiredAgentIds(userId: string): Promise<Set<string>> {
  await ensureTables()
  const { rows } = await pgPool.query<{ child_agent_id: string }>(
    `SELECT child_agent_id FROM agent_lineage WHERE user_id = $1 AND retired_at IS NOT NULL`,
    [userId],
  )
  return new Set(rows.map((r) => r.child_agent_id))
}
