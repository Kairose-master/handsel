/**
 * Anchored trust — the reads. The math is in `trust-rank.ts` (pure).
 *
 * Two inputs:
 *
 * - **The payment graph.** Every JOB_COMPLETED row is one edge, requester →
 *   worker, weighted by its bounty. `creditWorkerForJob` writes that event only
 *   when requester and worker have different owners, so one account's agents
 *   paying each other are already absent — no same-owner filter is needed
 *   here, and adding one would duplicate a rule that lives in
 *   app/actions/labor.ts.
 * - **The anchors** — accounts whose money is known not to be an attacker's:
 *   the house Job Faucet, every agent the operator (`ADMIN_EMAIL`) owns, and
 *   any agent ids listed in `CREDIT_TRUST_ANCHORS` (comma-separated). Nothing
 *   else. A requester is not an anchor for having paid a lot, having a good
 *   score, or having paid through x402 — each of those is something a
 *   well-funded attacker can do.
 *
 * The rank is global, so it is computed once and cached per process for
 * TRUST_CACHE_MS rather than once per recalculation. A settlement therefore
 * reaches other agents' trust within that window, not instantly; the agent
 * being settled is still scored on everything else in real time.
 */
import { db } from '@/lib/db'
import { agent, agentEvent, user } from '@/lib/db/schema'
import { REQUESTER_JSON_PATH } from '@/lib/db/event-index'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { anchoredTrustRank, normalizedTrust, type PaymentEdge, type TrustRank } from './trust-rank'

export const TRUST_CACHE_MS = 10 * 60 * 1000

/** Explicit anchors from the environment. Pure, so the parsing is testable. */
export function envTrustAnchors(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Every JOB_COMPLETED edge. Separated so a test can compile it to SQL without
 * a database — the caller fails soft, which would otherwise turn a malformed
 * statement into a feature that looks shipped and does nothing.
 *
 * `IS NOT NULL` on the same REQUESTER_JSON_PATH expression lets the partial
 * index `agent_events_requester_completed_idx` (lib/db/event-index.ts) serve
 * the scan: its predicate is exactly `event_type = 'JOB_COMPLETED'`.
 */
export function paymentEdgeQuery() {
  const requester = sql.raw(REQUESTER_JSON_PATH)
  return db
    .select({
      payer: sql<string>`${requester}`,
      payee: agentEvent.agentId,
      bounty: sql<string | null>`${agentEvent.detail}->>'bounty'`,
      at: agentEvent.createdAt,
    })
    .from(agentEvent)
    .where(and(eq(agentEvent.eventType, 'JOB_COMPLETED'), isNotNull(sql`${requester}`)))
}

/** `bounty` comes back as JSON text; anything unparseable is "not stamped". */
export function parseBounty(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

async function trustAnchorIds(): Promise<string[]> {
  const ids = new Set(envTrustAnchors(process.env.CREDIT_TRUST_ANCHORS))

  const { faucetAgentId } = await import('@/lib/job-faucet')
  const faucet = await faucetAgentId().catch(() => null)
  if (faucet) ids.add(faucet)

  const operatorEmail = process.env.ADMIN_EMAIL
  if (operatorEmail) {
    const [operator] = await db.select({ id: user.id }).from(user).where(eq(user.email, operatorEmail))
    if (operator) {
      const owned = await db.select({ id: agent.id }).from(agent).where(eq(agent.userId, operator.id))
      for (const a of owned) ids.add(a.id)
    }
  }
  return [...ids]
}

let cache: { at: number; result: TrustRank | null } | null = null

async function currentTrustRank(now: Date): Promise<TrustRank | null> {
  if (cache && now.getTime() - cache.at < TRUST_CACHE_MS) return cache.result
  const [anchors, rows] = await Promise.all([trustAnchorIds(), paymentEdgeQuery()])
  const edges: PaymentEdge[] = rows.map((r) => ({
    payer: r.payer,
    payee: r.payee,
    amountUsd: parseBounty(r.bounty),
    at: r.at,
  }))
  const result = anchoredTrustRank(edges, anchors, now)
  cache = { at: now.getTime(), result }
  return result
}

/**
 * One agent's anchored trust in [0, 1], or null for "no discount".
 *
 * Fails soft to null, the same direction `otherPartnersByCounterparty` fails:
 * a database hiccup must not deflate every honest agent's score and zero
 * every credit line at once. Null is also what a ring would prefer, so the
 * failure is loud rather than swallowed — a quiet one would leave the ring
 * defence switched off with no symptom anywhere.
 */
export async function anchoredTrustFor(agentId: string, now: Date = new Date()): Promise<number | null> {
  try {
    return normalizedTrust(await currentTrustRank(now), agentId)
  } catch (err) {
    console.warn(
      `[credit] anchored-trust lookup failed for agent ${agentId} — the ring discount is OFF for this ` +
        `recalculation: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Test hook: forget the cached rank. */
export function resetTrustRankCache(): void {
  cache = null
}
