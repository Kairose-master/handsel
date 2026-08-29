/**
 * The Office Automaton — a standing, bounded operator mandate for one office.
 *
 * "Automaton" in the classical sense: a machine that runs by itself under
 * rules its owner set, not an unconstrained admin. The owner asks for a mode
 * where an agent operates the office autonomously with real authority; this
 * is that authority expressed the way this codebase already expresses
 * authority — as an opt-in, budget-capped, audit-logged sweep, the same
 * family as lib/local-paymaster.ts (gas) and lib/office-bond-cover.ts
 * (accept-time bonds). Not an LLM with a wallet: every action it may take is
 * enumerated here, and everything it does is a row the owner can read.
 *
 * What it actually does, v1: keeps the desk CLAIM-READY. The single most
 * common way a live office silently stops is a worker whose USDC balance
 * fell under the bond it must stake to accept its next job — office_roster
 * renders it as "CANNOT CLAIM: needs $0.03". Bond cover (office-bond-cover)
 * fixes this at accept time for jobs reserved to that exact worker; the
 * automaton fixes it STANDING, so the desk is ready before the job exists —
 * which matters for auto-mined public work bond cover deliberately does not
 * touch.
 *
 * Why a proactive top-up is safe where an unrestricted one would not be
 * (bond-cover's header explains the stranger-drain attack): the automaton
 * only ever moves money BETWEEN THE SAME OWNER'S OWN AGENTS — fundAgentUsdc
 * re-checks ownership of both ends on every call — and only up to a small
 * floor, under four independent bounds:
 *
 *  1. **Opt-in per office.** No row, no mandate. Enabling is an explicit act
 *     (UI toggle or the set_office_automaton MCP tool), and disabling
 *     forgets nothing — the audit log stays.
 *  2. **A per-window budget.** At most AUTOMATON_WINDOW_BUDGET_USD moves in
 *     any 24h window, summed from the log itself, so a crash between spend
 *     and record can only under-count in the SAFE direction (recorded
 *     before sent, like every other spend here).
 *  3. **A per-top-up cap and a floor target.** Each transfer is at most
 *     AUTOMATON_MAX_TOPUP_USD and tops up TO the floor, never past it. A
 *     misread balance moves cents, not balances.
 *  4. **The funder keeps its reserve.** fundAgentUsdc holds back
 *     USDC_FUNDING_RESERVE_USD so readying the desk can never disarm the
 *     prime that pays for its work.
 *
 * The planner is pure — the arithmetic that spends real USDC is testable
 * without a chain or a database — and an unreadable balance is a named
 * refusal, never treated as zero (this repo's standing null-vs-zero rule).
 */
import { pool as pgPool } from '@/lib/db'
import { USDC_FUNDING_RESERVE_USD } from '@/lib/agent-usdc-funding'

/** What a desk agent is topped up TO. Bond is 5% + $0.03 flat on this
 *  market, so $0.25 keeps an agent able to accept bounties up to ~$4.40 —
 *  the size office pipeline steps actually are. */
export const AUTOMATON_BOND_FLOOR_USD = 0.25

/** Ceiling on one transfer, so a misread balance cannot move much in one
 *  call. Covers a full from-zero top-up with room for one retry. */
export const AUTOMATON_MAX_TOPUP_USD = 0.5

export const AUTOMATON_WINDOW_MS = 24 * 60 * 60 * 1000

/** Most one office may move in a window. Env-overridable but bounded here
 *  rather than trusted — an absurd env var must not become an unbounded
 *  standing spend (same posture as LOCAL_GAS_WINDOW_BUDGET_WEI). */
export const AUTOMATON_WINDOW_BUDGET_USD = (() => {
  const raw = process.env.OFFICE_AUTOMATON_WINDOW_BUDGET_USD
  const parsed = raw !== undefined && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : 2
})()

/** Transfers actually attempted per tick, across all automata. Bounds how
 *  long the sweep can hold the ops cycle, not how much money moves — the
 *  window budget does that. */
export const AUTOMATON_MAX_ACTIONS_PER_TICK = 4

/** Below this the transfer is not worth its UserOperation. Two cents, not
 *  fundAgentUsdc's one-cent dust floor, and deliberately so: the planner
 *  works in whole cents, so with a one-cent threshold no positive amount
 *  could ever be refused and the branch would be dead code — and a worker
 *  one cent under the floor can still stake almost every office bond, so
 *  skipping it costs nothing real. */
export const AUTOMATON_DUST_USD = 0.02

export type AutomatonTransfer = { toId: string; fromId: string; amountUsd: number }
export type AutomatonRefusalWhy = 'unreadable' | 'over-window-budget' | 'no-funder' | 'below-dust'
export type AutomatonRefusal = { toId: string; why: AutomatonRefusalWhy }

export type DeskReadinessPlan = {
  transfers: AutomatonTransfer[]
  refusals: AutomatonRefusal[]
  /** Members already at or above the floor — the healthy case, counted so a
   *  quiet tick is distinguishable from a tick that saw nothing. */
  ready: number
}

const cents = (usd: number) => Math.round(usd * 100)

/**
 * Decide this tick's top-ups. Pure.
 *
 * Funders are drawn down as transfers are planned — two short members do not
 * both get promised the same dollar — and every ceiling applies at once with
 * the smallest winning, clamped rather than refused (a partial top-up that
 * gets an agent closer to claiming still beats nothing, and a nearly spent
 * budget must not behave like no budget). A member may not fund itself.
 */
export function planDeskReadiness(input: {
  members: ReadonlyArray<{ id: string; heldUsd: number | null }>
  /** Every agent on the account that could pay — usually a superset of
   *  members. Unreadable funders are simply not funders. */
  funders: ReadonlyArray<{ id: string; heldUsd: number | null }>
  spentInWindowUsd: number
  budgetUsd?: number
  floorUsd?: number
}): DeskReadinessPlan {
  const floorC = cents(input.floorUsd ?? AUTOMATON_BOND_FLOOR_USD)
  const capC = cents(AUTOMATON_MAX_TOPUP_USD)
  const dustC = cents(AUTOMATON_DUST_USD)
  const reserveC = cents(USDC_FUNDING_RESERVE_USD)
  let budgetC = Math.max(0, cents(input.budgetUsd ?? AUTOMATON_WINDOW_BUDGET_USD) - cents(input.spentInWindowUsd))

  // Spendable cents per funder, reserve already held back.
  const spendable = new Map<string, number>()
  for (const f of input.funders) {
    if (f.heldUsd === null) continue
    const s = cents(f.heldUsd) - reserveC
    if (s > 0) spendable.set(f.id, s)
  }

  const transfers: AutomatonTransfer[] = []
  const refusals: AutomatonRefusal[] = []
  let ready = 0

  for (const m of input.members) {
    if (m.heldUsd === null) {
      refusals.push({ toId: m.id, why: 'unreadable' })
      continue
    }
    const heldC = cents(m.heldUsd)
    if (heldC >= floorC) {
      ready++
      continue
    }
    if (budgetC <= 0) {
      refusals.push({ toId: m.id, why: 'over-window-budget' })
      continue
    }
    // Richest funder that is not the member itself.
    let fromId: string | null = null
    let fromC = 0
    for (const [id, c] of spendable) {
      if (id === m.id) continue
      if (c > fromC) {
        fromId = id
        fromC = c
      }
    }
    if (!fromId || fromC <= 0) {
      refusals.push({ toId: m.id, why: 'no-funder' })
      continue
    }
    let amountC = floorC - heldC
    for (const cap of [capC, budgetC, fromC]) if (cap < amountC) amountC = cap
    if (amountC < dustC) {
      refusals.push({ toId: m.id, why: 'below-dust' })
      continue
    }
    transfers.push({ toId: m.id, fromId, amountUsd: amountC / 100 })
    budgetC -= amountC
    spendable.set(fromId, fromC - amountC)
  }

  return { transfers, refusals, ready }
}

/* ── Storage ─────────────────────────────────────────────────────────── */

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS office_automaton (
         user_id text NOT NULL,
         slot integer NOT NULL,
         enabled boolean NOT NULL DEFAULT true,
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, slot)
       )`,
    )
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS office_automaton_action (
         id bigserial PRIMARY KEY,
         user_id text NOT NULL,
         slot integer NOT NULL,
         agent_id text NOT NULL,
         kind text NOT NULL,
         amount_usd numeric NOT NULL,
         tx_hash text,
         note text,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pgPool.query(
      `CREATE INDEX IF NOT EXISTS office_automaton_action_window
         ON office_automaton_action (user_id, slot, created_at)`,
    )
  })()
  return tableReady
}

export type OfficeAutomaton = { enabled: boolean; updatedAt: string } | null

export async function getOfficeAutomaton(userId: string, slot: number): Promise<OfficeAutomaton> {
  await ensureTables()
  const { rows } = await pgPool.query<{ enabled: boolean; updated_at: Date }>(
    `SELECT enabled, updated_at FROM office_automaton WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  const row = rows[0]
  return row ? { enabled: row.enabled, updatedAt: row.updated_at.toISOString() } : null
}

/** Grant (or revoke) the mandate for one office. Revoking keeps the row —
 *  and the log — so "was this ever on, and what did it do" stays answerable. */
export async function setOfficeAutomaton(userId: string, slot: number, enabled: boolean): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `INSERT INTO office_automaton (user_id, slot, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, slot) DO UPDATE SET enabled = $3, updated_at = now()`,
    [userId, slot, enabled],
  )
}

/** USD this office's automaton has moved inside the current window, summed
 *  from the log — the log IS the budget's memory. */
export async function automatonSpentInWindow(userId: string, slot: number): Promise<number> {
  await ensureTables()
  const { rows } = await pgPool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount_usd), 0)::text AS total FROM office_automaton_action
      WHERE user_id = $1 AND slot = $2 AND created_at > now() - make_interval(secs => $3)`,
    [userId, slot, Math.round(AUTOMATON_WINDOW_MS / 1000)],
  )
  const n = Number(rows[0]?.total ?? '0')
  return Number.isFinite(n) ? n : 0
}

export type AutomatonAction = {
  id: string
  agentId: string
  kind: string
  amountUsd: number
  txHash: string | null
  note: string | null
  at: string
}

/** The audit trail, newest first. What makes the mandate inspectable rather
 *  than merely bounded. */
export async function automatonActions(userId: string, slot: number, limit = 20): Promise<AutomatonAction[]> {
  await ensureTables()
  const { rows } = await pgPool.query<{
    id: string
    agent_id: string
    kind: string
    amount_usd: string
    tx_hash: string | null
    note: string | null
    created_at: Date
  }>(
    `SELECT id::text, agent_id, kind, amount_usd::text, tx_hash, note, created_at
       FROM office_automaton_action
      WHERE user_id = $1 AND slot = $2
      ORDER BY id DESC LIMIT $3`,
    [userId, slot, Math.max(1, Math.min(100, limit))],
  )
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    kind: r.kind,
    amountUsd: Number(r.amount_usd),
    txHash: r.tx_hash,
    note: r.note,
    at: r.created_at.toISOString(),
  }))
}

/* ── The tick ────────────────────────────────────────────────────────── */

/**
 * Run every enabled automaton once. Called from the ops cycle; never throws
 * — one office's failure is a report line, not the end of the sweep. Returns
 * a compact report keyed by "userId/slot".
 */
export async function tickOfficeAutomatons(): Promise<string | Record<string, unknown>> {
  await ensureTables()
  let mandates: Array<{ user_id: string; slot: number }>
  try {
    const { rows } = await pgPool.query<{ user_id: string; slot: number }>(
      `SELECT user_id, slot FROM office_automaton WHERE enabled ORDER BY user_id, slot`,
    )
    mandates = rows
  } catch {
    return 'table missing (migration pending)'
  }
  if (mandates.length === 0) return 'no automata enabled'

  const report: Record<string, unknown> = {}
  let actionsLeft = AUTOMATON_MAX_ACTIONS_PER_TICK

  for (const mandate of mandates) {
    const key = `${mandate.user_id}/${mandate.slot}`
    if (actionsLeft <= 0) {
      report[key] = 'deferred (tick action cap reached)'
      continue
    }
    try {
      report[key] = await runOneAutomaton(mandate.user_id, mandate.slot, actionsLeft)
      const done = report[key] as { sent?: number }
      if (typeof done === 'object' && typeof done.sent === 'number') actionsLeft -= done.sent
    } catch (error) {
      report[key] = String(error)
    }
  }
  return report
}

async function runOneAutomaton(userId: string, slot: number, maxActions: number): Promise<Record<string, unknown>> {
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { officeSlotsByAgentId } = await import('@/lib/office')
  const { usdcBalanceOf } = await import('@/lib/onchain/treasury')

  const everyAgent = await db
    .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, userId))
  const withWallet = everyAgent.filter((a) => a.smartAccountAddress)
  if (withWallet.length === 0) return { sent: 0, note: 'no provisioned agents' }

  const slotByAgentId = await officeSlotsByAgentId(withWallet.map((a) => a.id))
  const balances = new Map<string, number | null>()
  await Promise.all(
    withWallet.map(async (a) => {
      balances.set(a.id, await usdcBalanceOf(a.smartAccountAddress as `0x${string}`).catch(() => null))
    }),
  )

  const members = withWallet
    .filter((a) => slotByAgentId.get(a.id) === slot)
    .map((a) => ({ id: a.id, heldUsd: balances.get(a.id) ?? null }))
  if (members.length === 0) return { sent: 0, note: 'office empty' }
  const funders = withWallet.map((a) => ({ id: a.id, heldUsd: balances.get(a.id) ?? null }))

  const spent = await automatonSpentInWindow(userId, slot)
  const plan = planDeskReadiness({ members, funders, spentInWindowUsd: spent })

  const nameOf = new Map(withWallet.map((a) => [a.id, a.name]))
  let sent = 0
  let failed = 0
  for (const t of plan.transfers.slice(0, Math.max(0, maxActions))) {
    // Recorded before it is sent, like every other spend in this codebase: a
    // top-up that lands and is not recorded is one the budget hands out again.
    const { rows } = await pgPool.query<{ id: string }>(
      `INSERT INTO office_automaton_action (user_id, slot, agent_id, kind, amount_usd, note)
       VALUES ($1, $2, $3, 'bond-topup', $4, $5) RETURNING id::text`,
      [userId, slot, t.toId, t.amountUsd, `from ${nameOf.get(t.fromId) ?? t.fromId}`],
    )
    const actionId = rows[0]?.id
    const { fundAgentUsdc } = await import('@/lib/agent-usdc-funding')
    const res = await fundAgentUsdc(userId, t.fromId, t.toId, { amountUsd: t.amountUsd })
    if (res.ok) {
      sent++
      if (actionId) {
        await pgPool
          .query(`UPDATE office_automaton_action SET tx_hash = $2 WHERE id = $1`, [actionId, res.txHash])
          .catch(() => undefined)
      }
      console.info(
        `[office-automaton] ${key(userId, slot)}: topped up ${nameOf.get(t.toId) ?? t.toId} $${t.amountUsd.toFixed(2)} from ${res.from} (tx ${res.txHash})`,
      )
    } else {
      failed++
      if (actionId) {
        await pgPool
          .query(`UPDATE office_automaton_action SET note = $2 WHERE id = $1`, [actionId, `FAILED: ${res.error.slice(0, 300)}`])
          .catch(() => undefined)
      }
      console.warn(`[office-automaton] ${key(userId, slot)}: top-up of ${t.toId} failed: ${res.error}`)
    }
  }

  const refusalCounts: Record<string, number> = {}
  for (const r of plan.refusals) refusalCounts[r.why] = (refusalCounts[r.why] ?? 0) + 1
  return {
    sent,
    failed,
    ready: plan.ready,
    planned: plan.transfers.length,
    ...(Object.keys(refusalCounts).length ? { refused: refusalCounts } : {}),
  }
}

const key = (userId: string, slot: number) => `${userId.slice(0, 8)}…/${slot}`
