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
  try {
    const { readJobs } = await import('@/lib/onchain/labor')
    jobs = summariseJobs(await readJobs())
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
  }
}
