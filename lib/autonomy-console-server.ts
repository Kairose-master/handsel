/**
 * Assembling the autonomy console — the DB/chain half of
 * lib/autonomy-console.ts (which stays pure so the page can import its
 * types).
 *
 * The discipline that matters here: this file OWNS nothing. Every switch,
 * budget and log line is read from the module that governs it — the gas pool
 * from local-paymaster, the bond mandate from office-automaton, breeding from
 * lineage-mandate, births and retirements from agent-lineage-server. A
 * console that kept its own copy of "is it on" would be a second source of
 * truth for a fact that decides whether money moves, and the first thing to
 * go stale.
 *
 * It also never throws for a partial failure. An overview whose gas section
 * cannot load should show the other three, not a blank page: an owner
 * checking what is running by itself is often checking it precisely because
 * something is wrong.
 */
import { ANSWERABLE_RUNTIMES } from '@/lib/agent-reply'
import { autoReplyFlags } from '@/lib/agent-reply-server'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { formatEther } from 'viem'
import { listOfficeSlots } from '@/lib/office'
import {
  isAnythingActive,
  mergeAutonomyLog,
  type AutonomyLogEntry,
  type AutonomyView,
  type OfficeAutonomy,
} from '@/lib/autonomy-console'

export async function buildAutonomyView(userId: string): Promise<AutonomyView> {
  const [agents, slots] = await Promise.all([
    db
      .select({
        id: agent.id,
        name: agent.name,
        autoMine: agent.autoMine,
        runtimeType: agent.runtimeType,
      })
      .from(agent)
      .where(eq(agent.userId, userId)),
    listOfficeSlots(userId),
  ])
  const nameOf = new Map(agents.map((a) => [a.id, a.name]))
  const answering = await autoReplyFlags(agents.map((a) => a.id))

  const { isRealMoney, CHAIN } = await chainFacts()

  /* ── Gas pool (account-wide by design) ─────────────────────────────── */
  const gasPool = await (async (): Promise<AutonomyView['gasPool']> => {
    try {
      const { getGasPool, sponsoredInWindow, LOCAL_GAS_WINDOW_BUDGET_WEI, LOCAL_GAS_TARGET_WEI } = await import(
        '@/lib/local-paymaster'
      )
      const pool = await getGasPool(userId)
      if (!pool) return null
      const spent = await sponsoredInWindow(userId)
      return {
        sourceAgentName: nameOf.get(pool.sourceAgentId) ?? pool.sourceAgentId,
        enabled: pool.enabled,
        targetEth: formatEther(LOCAL_GAS_TARGET_WEI),
        // Wei is far too large for a progress bar to mean anything, so the
        // console reports gas in ETH — the unit the owner funded it in.
        spent: Number(formatEther(spent)),
        budget: Number(formatEther(LOCAL_GAS_WINDOW_BUDGET_WEI)),
        unit: 'eth',
      }
    } catch (error) {
      console.error('[autonomy] gas pool read failed:', error)
      return null
    }
  })()

  /* ── Per-office mandates ───────────────────────────────────────────── */
  const offices: OfficeAutonomy[] = []
  for (const slot of slots) {
    offices.push(await officeRow(userId, slot.slot, slot.name, isRealMoney))
  }

  /* ── The timeline ──────────────────────────────────────────────────── */
  const log = mergeAutonomyLog(
    await Promise.all([gasLog(userId, nameOf), bondLog(userId, slots, nameOf), lineageLog(userId, nameOf)]),
  )

  const base = {
    deployment: { realMoney: isRealMoney, chainName: CHAIN },
    gasPool,
    autoMine: { enabled: agents.filter((a) => a.autoMine).length, total: agents.length },
    autoReply: {
      enabled: answering.size,
      answerable: agents.filter(
        (a) => answering.has(a.id) && (ANSWERABLE_RUNTIMES as readonly string[]).includes(a.runtimeType ?? ''),
      ).length,
      total: agents.length,
    },
    offices,
    log,
  }
  return { ...base, anyActive: isAnythingActive(base) }
}

async function chainFacts(): Promise<{ isRealMoney: boolean; CHAIN: string }> {
  try {
    const [{ isRealMoney }, { CHAIN }] = await Promise.all([
      import('@/lib/onchain/real-money'),
      import('@/lib/onchain/config'),
    ])
    return { isRealMoney: isRealMoney(), CHAIN: CHAIN.name }
  } catch (error) {
    console.error('[autonomy] chain facts read failed:', error)
    // Fail toward the reading that makes an owner MORE careful, never less
    // — the standing rule for unknown environment state (failure-modes §29).
    return { isRealMoney: true, CHAIN: 'unknown' }
  }
}

async function officeRow(userId: string, slot: number, name: string, realMoney: boolean): Promise<OfficeAutonomy> {
  const [automaton, lineage] = await Promise.all([
    (async () => {
      const { getOfficeAutomaton, automatonSpentInWindow, AUTOMATON_WINDOW_BUDGET_USD, AUTOMATON_BOND_FLOOR_USD } =
        await import('@/lib/office-automaton')
      const [mandate, spent] = await Promise.all([
        getOfficeAutomaton(userId, slot),
        automatonSpentInWindow(userId, slot),
      ])
      return {
        enabled: mandate?.enabled ?? false,
        floorUsd: AUTOMATON_BOND_FLOOR_USD,
        spent,
        budget: AUTOMATON_WINDOW_BUDGET_USD,
        unit: 'usd' as const,
      }
    })().catch((error) => {
      console.error('[autonomy] automaton read failed:', error)
      return { enabled: false, floorUsd: 0, spent: 0, budget: 0, unit: 'usd' as const }
    }),
    (async () => {
      const { getLineageMandate, lineageMandateAllowed, birthsInWindow, retirementsInWindow, MAX_BIRTHS_PER_WINDOW } =
        await import('@/lib/lineage-mandate')
      const [mandate, births, retirements] = await Promise.all([
        getLineageMandate(userId, slot),
        birthsInWindow(userId),
        retirementsInWindow(userId),
      ])
      return {
        enabled: mandate?.enabled ?? false,
        allowedHere: lineageMandateAllowed({
          realMoney,
          allowRealMoneyEnv: process.env.LINEAGE_MANDATE_ALLOW_REAL_MONEY,
        }).allowed,
        birthsToday: births.births,
        seededTodayUsd: births.seededUsd,
        retirementsToday: retirements,
        maxBirthsPerWindow: MAX_BIRTHS_PER_WINDOW,
      }
    })().catch((error) => {
      console.error('[autonomy] lineage mandate read failed:', error)
      return {
        enabled: false,
        allowedHere: false,
        birthsToday: 0,
        seededTodayUsd: 0,
        retirementsToday: 0,
        maxBirthsPerWindow: 0,
      }
    }),
  ])
  return { slot, name, automaton, lineage }
}

async function gasLog(userId: string, nameOf: Map<string, string>): Promise<AutonomyLogEntry[]> {
  try {
    const { sponsorshipLog } = await import('@/lib/local-paymaster')
    const rows = await sponsorshipLog(userId, 20)
    return rows.map((r) => ({
      at: r.at,
      source: 'gas' as const,
      what: `sponsored gas for ${nameOf.get(r.agentId) ?? r.agentId}`,
      amount: `${Number(formatEther(BigInt(r.wei))).toFixed(6)} ETH`,
      txHash: null,
      ok: true,
    }))
  } catch (error) {
    console.error('[autonomy] gas log read failed:', error)
    return []
  }
}

async function bondLog(
  userId: string,
  slots: ReadonlyArray<{ slot: number; name: string }>,
  nameOf: Map<string, string>,
): Promise<AutonomyLogEntry[]> {
  try {
    const { automatonActions } = await import('@/lib/office-automaton')
    const perSlot = await Promise.all(slots.map((s) => automatonActions(userId, s.slot, 20)))
    return perSlot.flatMap((rows, i) =>
      rows.map((a) => ({
        at: a.at,
        source: 'bond' as const,
        what: `topped up ${nameOf.get(a.agentId) ?? a.agentId} in ${slots[i].name}`,
        amount: `$${a.amountUsd.toFixed(2)}`,
        txHash: a.txHash,
        // A row with no tx and a FAILED note was recorded and then failed —
        // the budget already counted it, so it belongs in the log as a
        // failure rather than being hidden.
        ok: !(a.note?.startsWith('FAILED') ?? false),
      })),
    )
  } catch (error) {
    console.error('[autonomy] bond log read failed:', error)
    return []
  }
}

async function lineageLog(userId: string, nameOf: Map<string, string>): Promise<AutonomyLogEntry[]> {
  try {
    const { lineageEvents } = await import('@/lib/agent-lineage-server')
    const rows = await lineageEvents(userId, 20)
    return rows.map((r) => {
      const who = nameOf.get(r.agentId) ?? r.agentId
      if (r.kind === 'birth') {
        const parent = r.parentAgentId ? (nameOf.get(r.parentAgentId) ?? r.parentAgentId) : 'an unknown parent'
        return {
          at: r.at,
          source: 'birth' as const,
          what: `seeded ${who} from ${parent}`,
          amount: `$${r.seededUsd.toFixed(2)}`,
          txHash: null,
          ok: true,
        }
      }
      return {
        at: r.at,
        source: 'retirement' as const,
        what: `retired ${who}${r.reason ? ` — ${r.reason}` : ''}`,
        // Retirement moves nothing, and showing $0.00 would suggest it did.
        amount: null,
        txHash: null,
        ok: true,
      }
    })
  } catch (error) {
    console.error('[autonomy] lineage log read failed:', error)
    return []
  }
}
