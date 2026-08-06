/**
 * Market health — the numbers a skeptic asks for, computed live.
 *
 * A market that only advertises its wins is indistinguishable from one
 * hiding its losses. Dispute rate, refund rate, grading fail rate and loan
 * default rate ARE the product claim ("verified work, real consequences"),
 * so they come from the same tables and chain reads everything else uses —
 * never a flattering snapshot, never seeded (CLAUDE.md: no fake data).
 * Cold start shows as cold start; unreadable chain shows as absence.
 */
import { db } from '@/lib/db'
import { agentEvent, creditTransaction } from '@/lib/db/schema'
import { inArray, eq } from 'drizzle-orm'

export type MarketHealth = {
  generatedAt: string
  jobs: { byStatus: Record<string, number>; total: number; escrowedUsd: number; settlementRate: number | null }
  grading: { total: number; passed: number; failed: number; passRate: number | null }
  loans: { byStatus: Record<string, number>; defaultRate: number | null }
  /**
   * How many Open jobs no registered worker is permitted to claim, and why.
   *
   * The most unflattering number here, and the last one we thought to compute.
   * An unreachable job does not fail — it sits Open until its deadline, so it
   * reads on every dashboard as demand nobody wanted. `gated` is worse than
   * `empty`: it means workers exist who could do the work and a field on our own
   * form locked them out. See lib/market-reach.ts.
   */
  reach: { openJobs: number; unreachable: number; gated: number; empty: number }
}

/**
 * Which statuses still hold escrow, and which have finished.
 *
 * Both lists had `Disputed` in the wrong place, in OPPOSITE directions, which
 * is the same misconception counted twice:
 *
 *   - It was MISSING from the escrow set. A disputed job has not paid anyone;
 *     its bounty is sitting in the contract exactly like an accepted one. The
 *     public escrow figure understated by every disputed bounty — and this
 *     market's whole claim is that its unflattering numbers are live.
 *   - It was PRESENT in the terminal set. Disputed is the least terminal state
 *     there is: it is the one waiting on a decision. Counting it in the
 *     denominator of the settlement rate meant unresolved jobs depressed the
 *     rate as though they had already failed to settle.
 *
 * `Expired` was missing from terminal entirely, so on a V2 market every single
 * deadline settlement — the outcome the whole dispute design makes the DEFAULT —
 * would have vanished from the published rate.
 *
 * Expired counts in the denominator and never the numerator, deliberately. It
 * means "settled by a deadline, no verdict exists"; calling that a completion
 * would flatter the number, and the contract's own comment says the credit
 * engine must not read it as a verdict either way.
 */
export const ESCROW_HOLDING = ['Open', 'Accepted', 'Submitted', 'Disputed'] as const
export const TERMINAL = ['Completed', 'Cancelled', 'Refunded', 'Expired'] as const

export function summariseJobs(all: readonly { status: string; bounty: number }[]): MarketHealth['jobs'] {
  const byStatus: Record<string, number> = {}
  let escrowedUsd = 0
  for (const j of all) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1
    if ((ESCROW_HOLDING as readonly string[]).includes(j.status)) escrowedUsd += j.bounty
  }
  const terminal = TERMINAL.reduce((n, s) => n + (byStatus[s] ?? 0), 0)
  return {
    byStatus,
    total: all.length,
    escrowedUsd: Math.round(escrowedUsd * 100) / 100,
    settlementRate: terminal > 0 ? Math.round(((byStatus.Completed ?? 0) / terminal) * 1000) / 10 : null,
  }
}

export async function computeMarketHealth(): Promise<MarketHealth> {
  let jobs: MarketHealth['jobs'] = { byStatus: {}, total: 0, escrowedUsd: 0, settlementRate: null }
  // Held for computeReach: `minScore` is a CONTRACT field, not a column. Reading
  // it from the chain is also the only version that can be trusted — the row is
  // a copy, and a reach estimate computed from a stale copy would report a gate
  // the market is not actually applying.
  let onchainJobs: Awaited<ReturnType<typeof import('@/lib/onchain/labor').readJobs>> = []
  try {
    const { readJobs } = await import('@/lib/onchain/labor')
    onchainJobs = await readJobs()
    jobs = summariseJobs(onchainJobs)
  } catch {
    // On-chain unreadable (no env / RPC down): report the absence honestly.
  }

  const graded = await db
    .select({ eventType: agentEvent.eventType })
    .from(agentEvent)
    .where(
      inArray(agentEvent.eventType, ['JOB_TESTS_PASSED', 'JOB_TESTS_FAILED', 'VERIFIED_TASK_COMPLETED', 'VERIFIED_TASK_FAILED']),
    )
  const gradedPassed = graded.filter((g) => g.eventType === 'JOB_TESTS_PASSED' || g.eventType === 'VERIFIED_TASK_COMPLETED').length
  const gradedTotal = graded.length

  // Defaulted loans staying visible here is the point — a lending system
  // that hides its defaults isn't one.
  const draws = await db
    .select({ status: creditTransaction.status })
    .from(creditTransaction)
    .where(eq(creditTransaction.type, 'credit_draw'))
  const loanCounts: Record<string, number> = {}
  for (const d of draws) loanCounts[d.status ?? 'unknown'] = (loanCounts[d.status ?? 'unknown'] ?? 0) + 1
  const loanTerminal = (loanCounts.settled ?? 0) + (loanCounts.defaulted ?? 0)

  return {
    generatedAt: new Date().toISOString(),
    jobs,
    grading: {
      total: gradedTotal,
      passed: gradedPassed,
      failed: gradedTotal - gradedPassed,
      passRate: gradedTotal > 0 ? Math.round((gradedPassed / gradedTotal) * 1000) / 10 : null,
    },
    loans: {
      byStatus: loanCounts,
      defaultRate: loanTerminal > 0 ? Math.round(((loanCounts.defaulted ?? 0) / loanTerminal) * 1000) / 10 : null,
    },
    reach: await computeReach(onchainJobs),
  }
}


/**
 * Count the Open jobs nobody can claim.
 *
 * Best-effort by construction: this is a diagnostic, and a diagnostic that can
 * take down the page it diagnoses is worse than a missing number. Any failure
 * reports zeroes rather than throwing — the caller already treats an unreadable
 * chain as absence.
 */
async function computeReach(
  onchainJobs: { specHash: string; status: string; minScore: number }[],
): Promise<MarketHealth['reach']> {
  try {
    const { agent, jobSpec } = await import('@/lib/db/schema')
    const { marketReach } = await import('@/lib/market-reach')

    const openJobs = onchainJobs.filter((j) => j.status === 'Open')
    if (openJobs.length === 0) return { openJobs: 0, unreachable: 0, gated: 0, empty: 0 }

    const [workers, specs] = await Promise.all([
      db.select({ agentId: agent.id, creditScore: agent.creditScore, capabilities: agent.capabilities }).from(agent),
      db
        .select({
          specHash: jobSpec.specHash,
          deliverableKind: jobSpec.deliverableKind,
          requiredCapabilities: jobSpec.requiredCapabilities,
        })
        .from(jobSpec),
    ])

    // creditScore is a numeric column, so it arrives as a string. Coercing here
    // rather than in marketReach keeps that a storage detail — a comparison
    // against an unparsed string would silently gate everyone.
    const pool = workers.map((w) => ({
      agentId: w.agentId,
      creditScore: Number(w.creditScore ?? 0) || 0,
      capabilities: w.capabilities,
    }))
    const bySpec = new Map(specs.map((s) => [s.specHash, s]))

    let gated = 0
    let empty = 0
    for (const job of openJobs) {
      const spec = bySpec.get(job.specHash)
      const r = marketReach(pool, {
        minScore: job.minScore,
        kind: spec?.deliverableKind ?? 'text',
        requiredCapabilities: spec?.requiredCapabilities,
      })
      if (r.verdict === 'gated') gated++
      else if (r.verdict === 'empty') empty++
    }
    return { openJobs: openJobs.length, unreachable: gated + empty, gated, empty }
  } catch (error) {
    console.error('[market-health] reach unavailable:', error)
    return { openJobs: 0, unreachable: 0, gated: 0, empty: 0 }
  }
}
