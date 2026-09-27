/**
 * Anchored trust — PageRank over who actually paid whom.
 *
 * `scoring.ts` has local weights, and each one answers a local attack:
 * halving caps what one counterparty can hand out, pooling (see
 * `counterparty-graph.ts`) turns a star of N minted accomplices into one
 * partner. Both files name the attack neither can stop: a **ring**. Accomplices
 * that hire each other each gain distinct partners, each earn their own
 * halving bucket back, and the farm is linear in N again. No local weight can
 * see that, because from any single node's point of view a ring looks exactly
 * like a healthy neighbourhood. It needs a global property.
 *
 * This file is that property. It runs personalized PageRank over the settled
 * payment graph (an edge is a JOB_COMPLETED event: the requester paid the
 * worker), with the random walk's restart distribution concentrated on an
 * **anchor set** — accounts whose money is known not to be the attacker's
 * (the house faucet, the operator's own agents, and an explicit env list; see
 * `trust-rank-server.ts`). The same shape as X's user-cred PageRank, run on a
 * graph that is harder to fake than follows: every edge here cost a posted,
 * escrowed, fee-paying, graded job.
 *
 * ## Why it kills the ring
 *
 * PageRank CONSERVES mass. The only mass that enters the graph enters at the
 * anchors, and it moves only along payments. A ring whose members only ever
 * pay each other receives nothing from outside, so every member holds exactly
 * zero, however many members, however many trades, however much money cycles
 * inside. Minting nodes and edges creates no mass — that is the whole trick,
 * and it is a structural fact rather than a tuned threshold.
 *
 * ## What it does not stop, stated plainly
 *
 * - **Captured mass is amplified, boundedly.** An honest, anchored agent that
 *   hires a ring member hands the ring a slice of its own mass, and a ring can
 *   keep that slice cycling. Each step returns (1 − d) of it to the anchors,
 *   so a ring holds at most 1 / (1 − d) = 5× what it was paid in at the
 *   damping below. The attack cost becomes "get hired by someone the anchors
 *   trust", which is the thing reputation is meant to measure.
 * - **Honest strangers who have never touched the anchored part of the graph
 *   start at zero.** That is the known price of every anchored-trust system
 *   (EigenTrust, Advogato). It is why the score side applies this with a
 *   floor (`ANCHORED_TRUST_SCORE_FLOOR` in scoring.ts) and only lending, the
 *   place the platform can lose money, applies it without one. The on-ramp is
 *   deliberate: faucet jobs are reserved for new miners, so a new honest agent
 *   reaches the anchored graph by doing graded house work.
 *
 * Pure: no I/O. `trust-rank-server.ts` reads the edges and the anchors.
 */
import { EXPOSURE_REFERENCE_USD, REPUTATION_HALF_LIFE_DAYS, recencyWeight } from './scoring'

/** One settled payment: `payer` (the requester) paid `payee` (the worker). */
export type PaymentEdge = {
  payer: string
  payee: string
  /** The job's bounty. Null for rows written before the bounty was stamped;
   *  those count at the reference bounty rather than being dropped, because
   *  dropping them would silently erase trust the market really extended. */
  amountUsd: number | null
  at: Date
}

/**
 * Probability the walk follows a payment rather than restarting at an anchor.
 *
 * The trade-off is reach against Sybil amplification: a ring can hold at most
 * 1 / (1 − d) times the mass it was paid in. 0.8 bounds that at 5× and still
 * lets trust travel several hops from the house, which is as far as this
 * market's graph is deep today. X's user-cred uses the same restart
 * probability (0.2); it is a reasonable default, not a derived optimum.
 */
export const TRUST_DAMPING = 0.8

/** Power iteration stops at this L1 change, or at the iteration cap. At
 *  d = 0.8 the error shrinks by 0.8 per step, so 100 steps is ~1e-10. */
export const TRUST_TOLERANCE = 1e-10
export const TRUST_MAX_ITERATIONS = 100

/**
 * Where "full trust" starts, as a MASS-weighted quantile.
 *
 * A raw PageRank value means nothing on its own — it shrinks as the market
 * grows. It has to be read against a reference, and the reference must not be
 * something an attacker can move. A plain median over nodes is movable: mint a
 * thousand nodes, give each a crumb of captured mass, and the median falls to
 * the crumb, so every crumb reads as "normal". A mass-weighted quantile is not:
 * the reference is the rank at which the heaviest non-anchor nodes together
 * hold this share of all non-anchor mass, and a ring's total mass is bounded by
 * what it was paid in, however it is split. At 0.9, any node at or above the
 * rank that closes out the top 90% of the mass reads as fully trusted.
 */
export const TRUST_REFERENCE_QUANTILE = 0.9

export type TrustRank = {
  /** Stationary mass per node. Sums to 1 over every node the graph saw. */
  rank: Map<string, number>
  anchors: ReadonlySet<string>
  /** The rank that reads as trust 1.0. Null when no mass reached any
   *  non-anchor node — then the graph has nothing to say, which is not the
   *  same as saying everyone is untrusted. */
  reference: number | null
  iterations: number
}

/**
 * Aggregate raw payments into weighted edges: payer → payee → weight.
 *
 * Weight is the bounty, decayed on the same half-life reputation uses, so
 * trust extended two years ago fades like the reputation it backed. Self-loops
 * are dropped (paying yourself vouches for nothing), as are non-finite or
 * non-positive amounts.
 *
 * No per-pair halving here, and none needed: PageRank normalizes each payer's
 * outflow, so a payer pumping one edge only re-divides mass it already had.
 * Repetition cannot create trust in this model; only being paid by someone
 * who holds some can.
 */
export function aggregateEdges(edges: readonly PaymentEdge[], now: Date): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const e of edges) {
    if (!e.payer || !e.payee || e.payer === e.payee) continue
    const amount = e.amountUsd === null ? EXPOSURE_REFERENCE_USD : e.amountUsd
    if (!Number.isFinite(amount) || amount <= 0) continue
    const w = amount * recencyWeight(e.at, now, REPUTATION_HALF_LIFE_DAYS)
    if (!(w > 0)) continue
    let row = out.get(e.payer)
    if (!row) {
      row = new Map<string, number>()
      out.set(e.payer, row)
    }
    row.set(e.payee, (row.get(e.payee) ?? 0) + w)
  }
  return out
}

/**
 * Personalized PageRank with restart at `anchors`.
 *
 *   p ← (1 − d)·s + d·(Pᵀp + dangling·s)
 *
 * `s` is uniform over the anchors. A node that pays nobody (every pure worker)
 * is dangling; its mass restarts at the anchors rather than leaking uniformly,
 * which is what keeps the computation Sybil-resistant — uniform leakage would
 * hand every minted node a free share.
 *
 * Returns null when there are no anchors: without a restart set there is no
 * notion of where trust comes from, and plain PageRank's uniform restart is
 * exactly the free share this file exists to refuse.
 */
export function anchoredTrustRank(
  edges: readonly PaymentEdge[],
  anchorIds: Iterable<string>,
  now: Date = new Date(),
): TrustRank | null {
  const anchors = new Set([...anchorIds].filter(Boolean))
  if (anchors.size === 0) return null

  const graph = aggregateEdges(edges, now)
  const nodes = new Set<string>(anchors)
  for (const [payer, row] of graph) {
    nodes.add(payer)
    for (const payee of row.keys()) nodes.add(payee)
  }

  // Row-normalized transition weights, computed once.
  const outflow = new Map<string, [string, number][]>()
  for (const [payer, row] of graph) {
    let total = 0
    for (const w of row.values()) total += w
    outflow.set(
      payer,
      [...row].map(([payee, w]) => [payee, w / total]),
    )
  }

  const restart = 1 / anchors.size
  let p = new Map<string, number>()
  for (const v of nodes) p.set(v, anchors.has(v) ? restart : 0)

  let iterations = 0
  for (; iterations < TRUST_MAX_ITERATIONS; iterations++) {
    let dangling = 0
    for (const [v, mass] of p) if (!outflow.has(v)) dangling += mass

    const next = new Map<string, number>()
    for (const v of nodes) next.set(v, 0)
    for (const [payer, row] of outflow) {
      const mass = p.get(payer) ?? 0
      if (mass === 0) continue
      for (const [payee, share] of row) next.set(payee, next.get(payee)! + TRUST_DAMPING * mass * share)
    }
    const restartMass = (1 - TRUST_DAMPING) + TRUST_DAMPING * dangling
    for (const a of anchors) next.set(a, next.get(a)! + restartMass * restart)

    let delta = 0
    for (const v of nodes) delta += Math.abs(next.get(v)! - p.get(v)!)
    p = next
    if (delta < TRUST_TOLERANCE) {
      iterations++
      break
    }
  }

  return { rank: p, anchors, reference: trustReference(p, anchors), iterations }
}

/** The mass-weighted quantile described at TRUST_REFERENCE_QUANTILE. */
export function trustReference(rank: ReadonlyMap<string, number>, anchors: ReadonlySet<string>): number | null {
  const masses = [...rank]
    .filter(([id, m]) => !anchors.has(id) && m > 0)
    .map(([, m]) => m)
    .sort((a, b) => b - a)
  const total = masses.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return null
  let cumulative = 0
  for (const m of masses) {
    cumulative += m
    if (cumulative >= TRUST_REFERENCE_QUANTILE * total) return m
  }
  return masses[masses.length - 1]
}

/**
 * One agent's anchored trust in [0, 1], or null when the graph has nothing to
 * say (no anchors, or no mass left the anchors at all).
 *
 * Anchors read 1. A node the graph never saw reads 0 — it has settled no work
 * with anyone, which is a fact rather than a gap in the data.
 */
export function normalizedTrust(result: TrustRank | null, agentId: string): number | null {
  if (!result || result.reference === null) return null
  if (result.anchors.has(agentId)) return 1
  const mass = result.rank.get(agentId) ?? 0
  return Math.min(1, mass / result.reference)
}
