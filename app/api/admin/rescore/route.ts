/**
 * Operator action: recompute every agent's credit score from its event history.
 *
 * **A change to the scoring engine does not change any score.** Recalculation
 * is event-driven — `lib/callback/settle.ts`, `lib/loan-sweep.ts`,
 * `lib/stale-claim.ts` and friends call `recalculateCredit` when something
 * happens to an agent — and no sweep in `lib/ops-cycle.ts` walks the whole
 * table. So an agent that is not currently working keeps whatever number the
 * previous formula produced, indefinitely, and that stored number is what the
 * leaderboard, the agent profile, `/world` and the guest page all read.
 *
 * That gap is the whole reason this route exists. `NO_EVIDENCE_FACTOR` (see
 * failure-modes §20) shipped a curve where one job no longer buys a $5,250
 * credit line — but until every agent is recomputed, the site keeps *showing*
 * the old scores, which is the same defect one layer over: a page asserting
 * something the system would no longer say. Worse for the lending path, where
 * `DEFAULT_TERMS.maxAgeSec` treats a 30-day-old score as fresh, so a stale
 * inflated score stays spendable for a month.
 *
 * Dry by default. `?apply=true` is the only thing that writes. The dry run is
 * not a summary — it computes each agent's real new score with
 * `persist: false` and reports the delta, so the operator sees the actual
 * damage before doing it. Deliberately: this is the one operation in the
 * codebase that changes every public number on the site at once.
 */
import { requireOperator } from '@/lib/admin-route'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { recalculateCredit } from '@/lib/credit-engine'
import { mapLimit } from '@/lib/concurrency'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Serial on apply, and modest on dry. `recalculateCredit` reads an agent's
 *  whole event history and, on the apply path, sends an on-chain registry
 *  write per agent with a wallet — those compete for one nonce and one gas
 *  allowance, exactly like the settlement drain (failure-modes §19). */
const DRY_CONCURRENCY = 4

async function run(request: Request) {
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response

  const apply = new URL(request.url).searchParams.get('apply') === 'true'

  const agents = await db
    .select({ id: agent.id, name: agent.name, stored: agent.creditScore, rating: agent.creditRating })
    .from(agent)

  type Row = {
    agentId: string
    name: string
    stored: number
    next: number | null
    delta: number | null
    rating: string | null
    error?: string
  }

  const storedOf = (v: string | null) => Math.round(parseFloat(v ?? '0'))

  const assess = async (a: (typeof agents)[number]): Promise<Row> => {
    const stored = storedOf(a.stored)
    try {
      const next = await recalculateCredit(a.id, { persist: !apply ? false : undefined })
      return {
        agentId: a.id,
        name: a.name,
        stored,
        next: next.score,
        delta: next.score - stored,
        rating: next.rating,
      }
    } catch (err) {
      // Report, never throw: one agent with unreadable history must not stop
      // the other ninety-nine from being corrected.
      return {
        agentId: a.id,
        name: a.name,
        stored,
        next: null,
        delta: null,
        rating: a.rating,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Apply runs sequentially — each agent may trigger a registry write.
  const rows: Row[] = apply
    ? await (async () => {
        const out: Row[] = []
        for (const a of agents) out.push(await assess(a))
        return out
      })()
    : await mapLimit(agents, DRY_CONCURRENCY, assess)

  const changed = rows.filter((r) => r.delta !== null && r.delta !== 0)
  const failures = rows.filter((r) => r.error)
  const deltas = changed.map((r) => r.delta as number)

  return Response.json({
    applied: apply,
    agents: rows.length,
    changed: changed.length,
    unchanged: rows.length - changed.length - failures.length,
    failed: failures.length,
    biggestDrop: deltas.length > 0 ? Math.min(...deltas) : 0,
    biggestRise: deltas.length > 0 ? Math.max(...deltas) : 0,
    // Sorted by how far the score moved, largest movement first — the rows an
    // operator actually needs to look at before deciding to apply.
    rows: [...rows].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)),
    note: apply
      ? 'Scores rewritten and mirrored on-chain where a registry is configured. Safe to re-run: a second pass reports every delta as 0.'
      : 'Dry run — nothing was written and no transaction was sent. These are the real new scores. Re-run with ?apply=true to store them.',
  })
}

export const POST = run
export const GET = run // answers 405 with the curl to run — see lib/admin-route.ts
