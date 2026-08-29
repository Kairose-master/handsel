/**
 * The lineage mandate — the switch that lets selection actually act.
 *
 * lib/agent-lineage.ts decides; lib/agent-lineage-server.ts reports; this
 * module is the only place that DOES anything about it: seeds a child from a
 * proven parent, retires an agent that is failing or starved. It is
 * therefore the file where every guard lives.
 *
 * **The deployment gate comes first, because it is the one an owner cannot
 * add later.** This codebase deploys to two live markets from one branch:
 * handsel-main (Base mainnet, real Circle USDC) and handsel-nu (Base
 * Sepolia, faucet USDC with no monetary value). An evolutionary loop is
 * exactly the wrong thing to debug against real money — its whole point is
 * to run unattended, compounding, over days, and its failure mode is
 * spending. So it refuses to run on a real-money deployment unless someone
 * has deliberately set LINEAGE_MANDATE_ALLOW_REAL_MONEY=true, which nothing
 * in this repo sets. The rehearsal deployment runs it freely.
 *
 * That is a policy the code enforces, not a habit the operator has to keep.
 * `lineageMandateAllowed` is pure and tested; the tick asks it first and
 * reports the refusal rather than silently doing nothing.
 *
 * Everything else is the shape lib/office-automaton.ts already established
 * and this file deliberately copies rather than reinvents: opt-in per
 * office, a per-window budget, a per-tick action cap, recorded before it is
 * spent, and never anything but the owner's own money between the owner's
 * own wallets. Two additions specific to breeding:
 *
 *  - **A population cap.** MAX_AGENTS_PER_ACCOUNT already bounds how many
 *    agents an account may have; a lineage that ignored it would be the
 *    first thing to hit it, and the sweep must refuse cleanly rather than
 *    fail per child.
 *  - **Retirement is reversible and lossless.** It turns auto-mining off
 *    and writes a row. It deletes nothing, refunds nothing, and burns
 *    nothing — the agent's proofs and credit history stay public, and an
 *    owner can put it back to work by hand.
 */
import { pool as pgPool } from '@/lib/db'
import { DEFAULT_LIFECYCLE_POLICY } from '@/lib/agent-lineage'

/** Children one office may seed in a window. Two, because the point of a
 *  generation is to compare it, and a cohort that arrives faster than the
 *  graded evidence to judge it is just spending. */
export const MAX_BIRTHS_PER_WINDOW = 2

/** Ceiling on seed money per office per window, independent of the per-child
 *  seed — the same belt-and-braces the gas pool and the Automaton use. */
export const MAX_SEED_PER_WINDOW_USD = 2

/** Retirements one office may perform per window. Bounded for the same
 *  reason as births: a rule change that suddenly reads a whole desk as
 *  failing should stop a desk gradually, where someone can notice. */
export const MAX_RETIREMENTS_PER_WINDOW = 2

export const LINEAGE_WINDOW_MS = 24 * 60 * 60 * 1000

export type MandateGate =
  | { allowed: true }
  | { allowed: false; why: 'real-money-not-allowed' }

/**
 * May the mandate act on this deployment? Pure.
 *
 * Real money is refused by default and allowed only by an explicit env
 * opt-in. The default is the safe one on purpose: a misconfigured
 * rehearsal deployment falls back to "no evolution", never to "evolution
 * with real USDC".
 */
export function lineageMandateAllowed(input: {
  realMoney: boolean
  allowRealMoneyEnv: string | undefined
}): MandateGate {
  if (!input.realMoney) return { allowed: true }
  return input.allowRealMoneyEnv?.trim().toLowerCase() === 'true'
    ? { allowed: true }
    : { allowed: false, why: 'real-money-not-allowed' }
}

/** How many births and how much seed a window still has room for. Pure, so
 *  the budget arithmetic is testable without a database. */
export function remainingBirthBudget(input: {
  birthsInWindow: number
  seededInWindowUsd: number
  agentCount: number
  maxAgents: number
}): { births: number; seedUsd: number } {
  const byCount = Math.max(0, MAX_BIRTHS_PER_WINDOW - input.birthsInWindow)
  const byPopulation = Math.max(0, input.maxAgents - input.agentCount)
  return {
    births: Math.min(byCount, byPopulation),
    seedUsd: Math.max(0, MAX_SEED_PER_WINDOW_USD - input.seededInWindowUsd),
  }
}

/* ── Storage ─────────────────────────────────────────────────────────── */

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS lineage_mandate (
         user_id text NOT NULL,
         slot integer NOT NULL,
         enabled boolean NOT NULL DEFAULT true,
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, slot)
       )`,
    )
  })()
  return tableReady
}

export type LineageMandate = { enabled: boolean; updatedAt: string } | null

export async function getLineageMandate(userId: string, slot: number): Promise<LineageMandate> {
  await ensureTables()
  const { rows } = await pgPool.query<{ enabled: boolean; updated_at: Date }>(
    `SELECT enabled, updated_at FROM lineage_mandate WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  const row = rows[0]
  return row ? { enabled: row.enabled, updatedAt: row.updated_at.toISOString() } : null
}

export async function setLineageMandate(userId: string, slot: number, enabled: boolean): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `INSERT INTO lineage_mandate (user_id, slot, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, slot) DO UPDATE SET enabled = $3, updated_at = now()`,
    [userId, slot, enabled],
  )
}

/** Births and seed spent in the current window, read from agent_lineage —
 *  the birth record IS the budget's ledger, so there is no second number to
 *  drift. */
export async function birthsInWindow(userId: string): Promise<{ births: number; seededUsd: number }> {
  const { ensureLineageTables } = await import('@/lib/agent-lineage-server')
  await ensureLineageTables()
  const { rows } = await pgPool.query<{ births: string; seeded: string | null }>(
    `SELECT COUNT(*)::text AS births, COALESCE(SUM(seeded_usd), 0)::text AS seeded
       FROM agent_lineage
      WHERE user_id = $1 AND parent_agent_id IS NOT NULL
        AND born_at > now() - make_interval(secs => $2)`,
    [userId, Math.round(LINEAGE_WINDOW_MS / 1000)],
  )
  const r = rows[0]
  return { births: Number(r?.births ?? 0) || 0, seededUsd: Number(r?.seeded ?? 0) || 0 }
}

export async function retirementsInWindow(userId: string): Promise<number> {
  const { ensureLineageTables } = await import('@/lib/agent-lineage-server')
  await ensureLineageTables()
  const { rows } = await pgPool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agent_lineage
      WHERE user_id = $1 AND retired_at IS NOT NULL
        AND retired_at > now() - make_interval(secs => $2)`,
    [userId, Math.round(LINEAGE_WINDOW_MS / 1000)],
  )
  return Number(rows[0]?.n ?? 0) || 0
}

/* ── The tick ────────────────────────────────────────────────────────── */

/**
 * Run every enabled mandate once. Called from the ops cycle; never throws —
 * one office's failure is a report line, not the end of the sweep.
 */
export async function tickLineageMandates(): Promise<string | Record<string, unknown>> {
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  const gate = lineageMandateAllowed({
    realMoney: isRealMoney(),
    allowRealMoneyEnv: process.env.LINEAGE_MANDATE_ALLOW_REAL_MONEY,
  })
  if (!gate.allowed) {
    // Reported rather than skipped in silence: an owner who switched this on
    // is owed the reason it is not running.
    return 'refused: this is a real-money deployment and LINEAGE_MANDATE_ALLOW_REAL_MONEY is not set'
  }

  await ensureTables()
  let mandates: Array<{ user_id: string; slot: number }>
  try {
    const { rows } = await pgPool.query<{ user_id: string; slot: number }>(
      `SELECT user_id, slot FROM lineage_mandate WHERE enabled ORDER BY user_id, slot`,
    )
    mandates = rows
  } catch {
    return 'table missing (migration pending)'
  }
  if (mandates.length === 0) return 'no lineage mandates enabled'

  const report: Record<string, unknown> = {}
  for (const m of mandates) {
    const key = `${m.user_id.slice(0, 8)}…/${m.slot}`
    try {
      report[key] = await runOneMandate(m.user_id, m.slot)
    } catch (error) {
      report[key] = String(error)
    }
  }
  return report
}

async function runOneMandate(userId: string, slot: number): Promise<Record<string, unknown>> {
  const { buildLineageReport } = await import('@/lib/agent-lineage-server')
  const report = await buildLineageReport(userId, slot)
  if (report.rows.length === 0) return { note: 'office empty' }

  const maxAgents = Number(process.env.MAX_AGENTS_PER_ACCOUNT ?? 20)
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const owned = await db.select({ id: agent.id }).from(agent).where(eq(agent.userId, userId))

  const spent = await birthsInWindow(userId)
  const budget = remainingBirthBudget({
    birthsInWindow: spent.births,
    seededInWindowUsd: spent.seededUsd,
    agentCount: owned.length,
    maxAgents,
  })
  const retiredAlready = await retirementsInWindow(userId)

  const outcome = { born: 0, retired: 0, skipped: [] as string[] }

  // Retire first. A desk that is failing should stop before it breeds — and
  // retiring frees a population slot the same tick, which is the order that
  // lets a lineage turn over rather than merely grow.
  let retireRoom = Math.max(0, MAX_RETIREMENTS_PER_WINDOW - retiredAlready)
  for (const row of report.rows.filter((r) => r.decision.action === 'retire')) {
    if (retireRoom <= 0) {
      outcome.skipped.push(`retire ${row.name}: window cap`)
      break
    }
    const { retireAgent } = await import('@/lib/agent-lineage-server')
    await retireAgent(userId, row.agentId, row.decision.why)
    outcome.retired++
    retireRoom--
  }

  let birthsLeft = budget.births
  let seedLeft = budget.seedUsd
  for (const row of report.rows.filter((r) => r.decision.action === 'replicate')) {
    const seedUsd = Math.min(row.decision.seedUsd ?? DEFAULT_LIFECYCLE_POLICY.seedUsd, seedLeft)
    if (birthsLeft <= 0) {
      outcome.skipped.push(`breed ${row.name}: births/population cap`)
      break
    }
    if (seedUsd < DEFAULT_LIFECYCLE_POLICY.seedUsd) {
      outcome.skipped.push(`breed ${row.name}: seed budget spent`)
      break
    }
    const { breedChild } = await import('@/lib/agent-lineage-server')
    const res = await breedChild({ userId, parentAgentId: row.agentId, parentName: row.name, slot, seedUsd })
    if (res.ok) {
      outcome.born++
      birthsLeft--
      seedLeft -= seedUsd
    } else {
      outcome.skipped.push(`breed ${row.name}: ${res.error}`)
    }
  }

  return outcome
}
