/**
 * Counterparty graph — who else does my counterparty actually work with?
 *
 * `scoring.ts` caps what is extractable from one counterparty. This file
 * supplies the fact that decides whether two counterparties are really two:
 * for each agent that hired me, how many DISTINCT other agents it has also
 * settled work with. Below INDEPENDENCE_MIN_PARTNERS they collapse into a
 * single halving bucket, which is what turns "mint N accomplices" from a
 * linear farm into a convergent one.
 *
 * The aggregation is pure and unit-tested; only `otherPartnersByCounterparty`
 * touches the database. Edges live on the WORKER's event row
 * (`agent_events.detail->>'requesterAgentId'`), so "who else did R hire" is a
 * scan keyed on that JSON field rather than a lookup on R's own rows.
 *
 * Deliberately computed live rather than stamped at settlement time. The other
 * counterparty facts are stamped so a later score change cannot rewrite
 * history — but independence only ever grows, and an accomplice that later
 * becomes a real market participant SHOULD stop being pooled. Stamping would
 * also have made the fix apply to new events only, leaving every existing farm
 * un-priced.
 */
import { db } from '@/lib/db'
import { agentEvent } from '@/lib/db/schema'
import { REQUESTER_JSON_PATH } from '@/lib/db/event-index'
import { and, eq, inArray, sql } from 'drizzle-orm'

/** One settled hire: `requester` paid `worker`. */
export type TradeEdge = { requester: string; worker: string }

/**
 * For each requester in `edges`, how many distinct workers OTHER than `me` it
 * has settled with. Requesters that only ever hired me land at 0 — the star
 * topology, counted.
 */
export function otherPartnerCounts(edges: readonly TradeEdge[], me: string): Map<string, number> {
  const partners = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!e.requester || !e.worker) continue
    let set = partners.get(e.requester)
    if (!set) {
      set = new Set<string>()
      partners.set(e.requester, set)
    }
    if (e.worker !== me) set.add(e.worker)
  }
  return new Map([...partners].map(([requester, set]) => [requester, set.size]))
}

/**
 * The edge query, separated so it can be compiled and asserted without a
 * database. `otherPartnersByCounterparty` swallows errors by design, which
 * would turn a malformed statement into a silent no-op — the feature would
 * look shipped and do nothing. A test compiles this to SQL instead.
 */
export function counterpartyEdgeQuery(ids: readonly string[]) {
  // REQUESTER_JSON_PATH, not a literal: the partial expression index in
  // lib/db/event-index.ts is built from the same constant, and an expression
  // index only helps when the expression matches character for character. A
  // key renamed here alone would leave the index in place, unused, and the
  // query back to a sequential scan on every settlement with no error anywhere.
  const requester = sql.raw(REQUESTER_JSON_PATH)
  return db
    .select({
      requester: sql<string>`${requester}`,
      worker: agentEvent.agentId,
    })
    .from(agentEvent)
    .where(
      and(
        eq(agentEvent.eventType, 'JOB_COMPLETED'),
        // Parameterised, not interpolated: these ids come from a JSON field
        // and must never reach the statement as text. Only the COLUMN
        // EXPRESSION is raw, and it is a constant in this repo, never input.
        inArray(sql<string>`${requester}`, [...ids]),
      ),
    )
}

/**
 * Live lookup for one agent's counterparties. Returns 0 for a counterparty
 * with no other partners, and omits ids the query never saw — callers should
 * treat a miss as 0 rather than as "unknown", because a requester with no
 * JOB_COMPLETED rows at all has demonstrably not settled with anyone else.
 *
 * Fails soft: on any query error every counterparty is reported independent,
 * so a database hiccup cannot silently deflate honest agents' scores. That is
 * the safe direction here — this weight only ever removes reputation. It is
 * also the direction an attacker prefers, so the failure is LOUD: swallowing
 * it quietly would leave the Sybil discount switched off with no symptom
 * anywhere, which is the shape of half the entries in docs/failure-modes.md.
 */
export async function otherPartnersByCounterparty(
  agentId: string,
  counterpartyIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(counterpartyIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  try {
    const rows = await counterpartyEdgeQuery(ids)
    return otherPartnerCounts(
      rows.map((r) => ({ requester: r.requester, worker: r.worker })),
      agentId,
    )
  } catch (err) {
    console.warn(
      `[credit] counterparty-graph lookup failed for agent ${agentId} over ${ids.length} counterparties — ` +
        `the Sybil pooling discount is OFF for this recalculation: ${err instanceof Error ? err.message : String(err)}`,
    )
    return new Map(ids.map((id) => [id, Number.POSITIVE_INFINITY]))
  }
}
