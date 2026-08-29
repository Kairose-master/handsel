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
  applyMutation,
  buildLineage,
  chooseMutation,
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
    .select({
      agentId: agentEvent.agentId,
      eventType: agentEvent.eventType,
      detail: agentEvent.detail,
      createdAt: agentEvent.createdAt,
    })
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
    // The real timestamp, not the window edge: scoreFitness ignores it, but
    // skill evidence splits these outcomes at each skill's install time, and
    // a placeholder date would put every outcome on one side of every split.
    list.push({ at: e.createdAt, passed: PASS_EVENT_TYPES.includes(e.eventType) })
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

/** Exported so lib/lineage-mandate.ts can read agent_lineage without
 *  depending on an invisible ordering: its budget queries hit this table
 *  before anything else in a tick necessarily has, and a missing relation
 *  there throws inside the sweep — safe (nothing acts) but silently broken. */
export function ensureLineageTables(): Promise<void> {
  return ensureTables()
}

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

/* ── The two acting functions ────────────────────────────────────────── */

/**
 * Retire an agent: stop it working, record why.
 *
 * Everything it is NOT is the point. No delete, no wallet sweep, no burn,
 * no credit adjustment. Its signed work proofs, its score and its failures
 * stay exactly where they are and stay public, because that record is what
 * other people price decisions against — and because an owner who disagrees
 * with the call should be able to switch auto-mining back on and carry on.
 */
export async function retireAgent(userId: string, agentId: string, reason: string): Promise<void> {
  // Ownership re-checked here rather than trusted from the caller: this is
  // the entry point that stops an agent working, and every other
  // money-or-lifecycle path in this repo re-checks at its own boundary.
  const [owned] = await db.select({ id: agent.id }).from(agent).where(and(eq(agent.id, agentId), eq(agent.userId, userId)))
  if (!owned) return
  await db.update(agent).set({ autoMine: false }).where(eq(agent.id, agentId))
  await markRetired(userId, agentId, reason)
  console.info(`[lineage] retired ${agentId} (${reason}) — auto-mining off, history untouched`)
}

export type BreedResult = { ok: true; childAgentId: string; childName: string } | { ok: false; error: string }

/**
 * Seed a child from a proven parent.
 *
 * The child inherits the GENOTYPE — instructions, skills, MCP wiring, model
 * — and nothing else. It starts at credit score zero with no history, which
 * is `agent_templates`' rule and the thing that makes this selection rather
 * than dynasty: a child of a good parent still has to earn its own record
 * before it can breed in turn.
 *
 * Order is chosen so every partial failure leaves something safe:
 *
 *  1. Read the parent's genome and its measured skill evidence.
 *  2. Choose the one mutation (pure, evidence-driven — see chooseMutation).
 *  3. Create and provision the child. If this fails nothing was spent.
 *  4. Record the birth WITH its seed amount, before any money moves — the
 *     birth record is the budget's ledger, so a crash between recording and
 *     funding under-counts the budget in the safe direction.
 *  5. Fund the seed. A failure here leaves a real, unfunded child that its
 *     owner can fund by hand; it never leaves money moved without a record.
 *  6. Install inherited skills and wiring, best-effort. A child that failed
 *     to inherit a skill is a worse child, not a broken one.
 */
export async function breedChild(input: {
  userId: string
  parentAgentId: string
  parentName: string
  slot: number
  seedUsd: number
}): Promise<BreedResult> {
  const { userId, parentAgentId, slot, seedUsd } = input

  const [parent] = await db.select().from(agent).where(and(eq(agent.id, parentAgentId), eq(agent.userId, userId)))
  if (!parent) return { ok: false, error: 'parent not found or not yours' }

  const { listAgentSkills } = await import('@/lib/agent-skills')
  const parentSkills = await listAgentSkills(userId, parentAgentId).catch(() => [])
  const genome = {
    customInstructions: parent.customInstructions ?? '',
    skillSlugs: parentSkills.map((s) => s.slug),
    connector:
      parent.mcpServerUrl && parent.mcpToolName
        ? { serverUrl: parent.mcpServerUrl, toolName: parent.mcpToolName }
        : null,
    model: parent.cloudModel ?? null,
  }

  const mutation = await chooseMutationFor(userId, parentAgentId, genome, parentSkills)
  const childGenome = applyMutation(genome, mutation)

  const { nanoid } = await import('nanoid')
  const { randomBytes } = await import('node:crypto')
  const childId = nanoid()
  const childName = await uniqueChildName(userId, input.parentName)

  await db.insert(agent).values({
    id: childId,
    userId,
    name: childName,
    walletAddress: `0x${randomBytes(20).toString('hex')}`,
    description: `Seeded from ${input.parentName} by the lineage mandate (${mutation.kind}).`,
    modelVersion: parent.modelVersion,
    // A genuine cold start. Not inherited, on purpose — see this function's
    // doc comment and the agent_templates rule it follows.
    creditScore: '0',
    creditRating: 'unrated',
    riskLevel: 'UNKNOWN',
    riskRating: 'unrated',
    totalCreditLine: '0',
    availableCredit: '0',
    customInstructions: childGenome.customInstructions || null,
    runtimeType: parent.runtimeType,
    cloudModel: parent.cloudModel,
  })

  try {
    const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
    if (isAgentAccountConfigured()) {
      const { getAgentAccountAddress } = await import('@/lib/onchain/account')
      const address = await getAgentAccountAddress(childId)
      await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, childId))
    }
  } catch (error) {
    console.error('[lineage] child provisioning failed (non-fatal):', error)
  }

  const { setAgentOfficeSlot } = await import('@/lib/office')
  await setAgentOfficeSlot(childId, slot).catch(() => undefined)

  // Recorded before the money moves, like every other spend in this repo.
  await recordBirth({ userId, childAgentId: childId, parentAgentId, mutation, seededUsd: seedUsd })

  const { fundAgentUsdc } = await import('@/lib/agent-usdc-funding')
  const funded = await fundAgentUsdc(userId, parentAgentId, childId, { amountUsd: seedUsd })
  if (!funded.ok) {
    console.warn(`[lineage] ${childName} was born but the seed transfer failed: ${funded.error}`)
  }

  // Inheritance of skills and wiring is best-effort: a child missing a skill
  // is a worse child, not a failed birth, and throwing here would strand one
  // that already exists and is already funded.
  for (const slug of childGenome.skillSlugs) {
    try {
      const { installAgentSkill } = await import('@/lib/agent-skills')
      await installAgentSkill({ userId, agentId: childId, slug })
    } catch (error) {
      console.warn(`[lineage] ${childName} could not inherit skill ${slug}:`, error)
    }
  }
  if (childGenome.connector) {
    await db
      .update(agent)
      .set({
        runtimeType: 'mcp',
        mcpServerUrl: childGenome.connector.serverUrl,
        mcpToolName: childGenome.connector.toolName,
      })
      .where(eq(agent.id, childId))
      .catch(() => undefined)
  }

  console.info(`[lineage] ${input.parentName} → ${childName} (${mutation.kind}), seeded $${seedUsd.toFixed(2)}`)
  return { ok: true, childAgentId: childId, childName }
}

/** Unique on the account, because agent names are. Generation-suffixed so a
 *  lineage is readable at a glance in any roster. */
async function uniqueChildName(userId: string, parentName: string): Promise<string> {
  const owned = await db.select({ name: agent.name }).from(agent).where(eq(agent.userId, userId))
  const taken = new Set(owned.map((a) => a.name.toLowerCase()))
  const stem = parentName.replace(/\s+g\d+$/i, '')
  for (let gen = 2; gen < 100; gen++) {
    const candidate = `${stem} g${gen}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${stem} ${Date.now()}`
}

/** Assemble the real evidence chooseMutation needs: what each of the
 *  parent's own skills measurably did to its graded pass rate, and which
 *  skills are measurably helping elsewhere on this account. */
async function chooseMutationFor(
  userId: string,
  parentAgentId: string,
  genome: { customInstructions: string; skillSlugs: string[]; connector: { serverUrl: string; toolName: string } | null; model: string | null },
  parentSkills: ReadonlyArray<{ slug: string; installedAt: Date }>,
) {
  const { evaluateSkillWindows } = await import('@/lib/skill-eval')
  const outcomes = await gradedOutcomesFor([parentAgentId])
  const mine = outcomes.get(parentAgentId) ?? []
  const skillEvidence = parentSkills.map((s) => ({
    slug: s.slug,
    deltaPoints: evaluateSkillWindows(s.installedAt, mine).deltaPoints,
  }))

  // Skills measured to help on OTHER agents of this account, best first.
  const siblings = await db
    .select({ id: agent.id })
    .from(agent)
    .where(eq(agent.userId, userId))
  const siblingIds = siblings.map((s) => s.id).filter((id) => id !== parentAgentId)
  const siblingOutcomes = await gradedOutcomesFor(siblingIds)
  const scored = new Map<string, number>()
  const { listAgentSkills } = await import('@/lib/agent-skills')
  for (const id of siblingIds) {
    const theirs = await listAgentSkills(userId, id).catch(() => [])
    for (const s of theirs) {
      const delta = evaluateSkillWindows(s.installedAt, siblingOutcomes.get(id) ?? []).deltaPoints
      if (delta !== null && delta > 0) scored.set(s.slug, Math.max(scored.get(s.slug) ?? 0, delta))
    }
  }
  const provenElsewhere = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug)

  return chooseMutation({ genome, skillEvidence, provenElsewhere })
}

/** Every graded outcome for these agents, all time — skill evidence splits
 *  on install date, so unlike the fitness window this must not be clipped. */
async function gradedOutcomesFor(agentIds: string[]): Promise<Map<string, { at: Date; passed: boolean }[]>> {
  const out = new Map<string, { at: Date; passed: boolean }[]>()
  if (agentIds.length === 0) return out
  const rows = await db
    .select({ agentId: agentEvent.agentId, eventType: agentEvent.eventType, createdAt: agentEvent.createdAt })
    .from(agentEvent)
    .where(and(inArray(agentEvent.agentId, agentIds), inArray(agentEvent.eventType, GRADED_EVENT_TYPES)))
  for (const r of rows) {
    const list = out.get(r.agentId) ?? []
    list.push({ at: r.createdAt, passed: PASS_EVENT_TYPES.includes(r.eventType) })
    out.set(r.agentId, list)
  }
  return out
}
