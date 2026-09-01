'use server'

/**
 * The advance desk, as the dashboard reaches it.
 *
 * Every figure on the page is read at request time: the collateral from the
 * market contract, the record from the credit ledger. Nothing is cached and
 * nothing is estimated — a quote is a statement about a job whose deadline is
 * moving, and a stale one is the specific way this feature would lie.
 */
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { advancesFor, offerFor, openAdvance, orchestrationRecordFor } from '@/lib/advance-server'
import { readCollateral } from '@/lib/onchain/advance-chain'
import { readJobsOrUnknown } from '@/lib/onchain/labor-read'
import { REFUSAL_TEXT, quoteAdvance, type AdvanceQuote, type AdvanceRefusal } from '@/lib/advance'
import { orchestrationLtv } from '@/lib/orchestration-risk'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export type CollateralCandidate = {
  jobId: number
  bountyUsd: number
  deliveryDeadlineMs: number
  /** A quote, or the reason there isn't one — never a silent omission. A job
   *  missing from this list with no explanation is indistinguishable from a
   *  bug, and the borrower is the one who cannot tell. */
  quote: AdvanceQuote | null
  refusal: AdvanceRefusal | null
  refusalText: string | null
}

export type AdvanceDesk = {
  /** Null when the market has no on-chain configuration at all. */
  chainAvailable: boolean
  agents: { id: string; name: string; smartAccountAddress: string | null; usdcNote: string | null }[]
  borrowerAgentId: string | null
  ltv: number | null
  record: { attempts: number; completed: number; failed: number; completionRate: number | null; largestCompletedUsd: number | null } | null
  candidates: CollateralCandidate[]
  history: Awaited<ReturnType<typeof advancesFor>>
}

/**
 * What one agent could borrow, and against which of its accepted jobs.
 *
 * The candidate list is the agent's own accepted jobs read off chain, not a
 * mirror of `job_specs` — a jobId in the database that the contract has since
 * moved past is exactly the row that would produce a quote the chain refuses.
 */
export async function getAdvanceDesk(borrowerAgentId?: string): Promise<AdvanceDesk> {
  const userId = await requireUser()
  const mine = await db.select().from(agent).where(eq(agent.userId, userId))
  const agents = mine.map((a) => ({
    id: a.id,
    name: a.name,
    smartAccountAddress: a.smartAccountAddress,
    usdcNote: null as string | null,
  }))

  const borrower = borrowerAgentId ? mine.find((a) => a.id === borrowerAgentId) : mine[0]
  if (!borrower) {
    return { chainAvailable: true, agents, borrowerAgentId: null, ltv: null, record: null, candidates: [], history: [] }
  }

  const jobs = await readJobsOrUnknown()
  if (jobs === null) {
    // The market could not be read. Saying so beats an empty list, which reads
    // as "you have no collateral" — the opposite of the truth.
    return { chainAvailable: false, agents, borrowerAgentId: borrower.id, ltv: null, record: null, candidates: [], history: [] }
  }

  const record = await orchestrationRecordFor(borrower.id)
  const wallet = borrower.smartAccountAddress?.toLowerCase() ?? null
  const now = Date.now()

  const candidates: CollateralCandidate[] = []
  for (const job of jobs) {
    if (!wallet || String(job.worker ?? '').toLowerCase() !== wallet) continue
    if (job.status !== 'Accepted') continue
    const collateral = await readCollateral(job.id)
    if (!collateral) continue
    const q = quoteAdvance({ collateral, record, now })
    candidates.push({
      jobId: job.id,
      bountyUsd: collateral.bountyUsd,
      deliveryDeadlineMs: collateral.deliveryDeadlineMs,
      quote: q.ok ? q : null,
      refusal: q.ok ? null : q.reason,
      refusalText: q.ok ? null : REFUSAL_TEXT[q.reason],
    })
  }
  candidates.sort((a, b) => (b.quote?.advanceUsd ?? -1) - (a.quote?.advanceUsd ?? -1))

  return {
    chainAvailable: true,
    agents,
    borrowerAgentId: borrower.id,
    ltv: orchestrationLtv(record),
    record,
    candidates,
    history: await advancesFor(borrower.id),
  }
}

/** Re-quote one job at the moment of asking. */
export async function quoteOne(borrowerAgentId: string, jobId: number, requestedUsd?: number) {
  const userId = await requireUser()
  const [a] = await db.select().from(agent).where(eq(agent.id, borrowerAgentId))
  if (!a || a.userId !== userId) throw new Error('Agent not found')
  return offerFor({ borrowerAgentId, jobId, requestedUsd })
}

/**
 * Open the advance.
 *
 * Both agents are checked against the signed-in user. Cross-account lending is
 * the eventual shape of this market, and it needs a lender that consented to
 * the specific loan — which is a different feature, not a looser check here.
 */
export async function openAdvanceAction(input: {
  borrowerAgentId: string
  lenderAgentId: string
  jobId: number
  requestedUsd?: number
}) {
  const userId = await requireUser()
  const rows = await db.select().from(agent).where(eq(agent.userId, userId))
  const owned = new Set(rows.map((r) => r.id))
  if (!owned.has(input.borrowerAgentId) || !owned.has(input.lenderAgentId)) {
    return { ok: false as const, message: 'Both agents must belong to you.' }
  }
  try {
    return await openAdvance(input)
  } catch (error) {
    // Thrown server-action errors are masked in production ("The specific
    // message is omitted..."), which is what the first live user of the
    // delegation flow hit. Returned, the real reason survives.
    console.error('[openAdvanceAction]', error)
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}
