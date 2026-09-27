import { describe, expect, it } from 'vitest'
import {
  aggregateEdges,
  anchoredTrustRank,
  normalizedTrust,
  trustReference,
  TRUST_DAMPING,
  type PaymentEdge,
} from '@/lib/credit-engine/trust-rank'
import { envTrustAnchors, parseBounty, paymentEdgeQuery } from '@/lib/credit-engine/trust-rank-server'
import {
  ANCHORED_TRUST_LENDING_FLOOR,
  ANCHORED_TRUST_SCORE_FLOOR,
  anchoredTrustWeight,
  assessCredit,
  collateralizedCreditLimit,
  type AgentEventInput,
  type SettledTrade,
} from '@/lib/credit-engine/scoring'

const NOW = new Date('2026-09-01T00:00:00Z')
const pay = (payer: string, payee: string, amountUsd: number | null = 10, at: Date = NOW): PaymentEdge => ({
  payer,
  payee,
  amountUsd,
  at,
})

/** The house pays ten honest workers; two of them hire each other once. */
function honestMarket(): PaymentEdge[] {
  const edges: PaymentEdge[] = []
  for (let i = 0; i < 10; i++) edges.push(pay('house', `w${i}`))
  edges.push(pay('w0', 'w1'), pay('w1', 'w2'))
  return edges
}

/** N accomplices in a ring, each paying the next, many times over. */
function ring(n: number, prefix = 'r', rounds = 5): PaymentEdge[] {
  const edges: PaymentEdge[] = []
  for (let k = 0; k < rounds; k++) {
    for (let i = 0; i < n; i++) edges.push(pay(`${prefix}${i}`, `${prefix}${(i + 1) % n}`, 50))
  }
  return edges
}

const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe('anchoredTrustRank — where trust comes from', () => {
  it('has nothing to say without anchors (no uniform-restart free share)', () => {
    expect(anchoredTrustRank(honestMarket(), [], NOW)).toBeNull()
    expect(normalizedTrust(null, 'w0')).toBeNull()
  })

  it('conserves mass: the stationary distribution sums to 1', () => {
    const r = anchoredTrustRank([...honestMarket(), ...ring(20)], ['house'], NOW)!
    expect(sum(r.rank)).toBeCloseTo(1, 8)
  })

  it('reaches honest workers the house paid', () => {
    const r = anchoredTrustRank(honestMarket(), ['house'], NOW)!
    for (let i = 0; i < 10; i++) expect(normalizedTrust(r, `w${i}`)).toBeGreaterThan(0)
    expect(normalizedTrust(r, 'house')).toBe(1)
  })

  it('an agent the graph never saw reads 0 — it has settled nothing with anyone', () => {
    const r = anchoredTrustRank(honestMarket(), ['house'], NOW)!
    expect(normalizedTrust(r, 'stranger')).toBe(0)
  })
})

describe('the ring — the attack the local weights cannot see', () => {
  it('a ring disconnected from the anchors holds exactly zero, at any size', () => {
    for (const n of [3, 10, 1000]) {
      const r = anchoredTrustRank([...honestMarket(), ...ring(n)], ['house'], NOW)!
      for (let i = 0; i < n; i++) expect(r.rank.get(`r${i}`)).toBe(0)
      expect(normalizedTrust(r, 'r0')).toBe(0)
    }
  })

  it('more money cycling inside the ring buys nothing', () => {
    const small = anchoredTrustRank([...honestMarket(), ...ring(10, 'r', 1)], ['house'], NOW)!
    const huge = anchoredTrustRank([...honestMarket(), ...ring(10, 'r', 200)], ['house'], NOW)!
    expect(normalizedTrust(small, 'r3')).toBe(0)
    expect(normalizedTrust(huge, 'r3')).toBe(0)
  })

  it('captured mass is amplified at most 1 / (1 − d) — the documented bound', () => {
    // One honest worker hires one ring member once. Everything the ring holds
    // came through that edge, and it cannot keep more than inflow / (1 − d).
    const edges = [...honestMarket(), pay('w5', 'r0'), pay('w5', 'w6'), ...ring(50)]
    const r = anchoredTrustRank(edges, ['house'], NOW)!
    const ringMass = [...r.rank].filter(([id]) => id.startsWith('r')).reduce((a, [, m]) => a + m, 0)
    const w5 = r.rank.get('w5')!
    const inflowPerStep = TRUST_DAMPING * w5 * 0.5 // w5 splits its outflow evenly between r0 and w6
    expect(ringMass).toBeGreaterThan(0)
    expect(ringMass).toBeLessThanOrEqual(inflowPerStep / (1 - TRUST_DAMPING) + 1e-9)
  })

  it('a captured payment buys a handful of trusted ring nodes, not N of them', () => {
    // Worst case for this defence: an honest worker sends ALL of its outflow
    // into the ring. The ring members next to the entry point really were
    // paid by someone the anchors trust, and read like it. But mass falls by
    // d at every hop, so the number of ring members that read as trusted is
    // set by the damping, not by how many members were minted: a ring of a
    // thousand buys the same few as a ring of a hundred. (Not twenty: a short
    // ring wraps, and mass coming back round tips one more member over.)
    const trustedMembers = (n: number) => {
      const r = anchoredTrustRank([...honestMarket(), pay('w9', 'r0', 1), ...ring(n)], ['house'], NOW)!
      let count = 0
      for (let i = 0; i < n; i++) if ((normalizedTrust(r, `r${i}`) ?? 0) >= 0.5) count++
      return count
    }
    const few = trustedMembers(100)
    expect(few).toBeGreaterThan(0)
    expect(few).toBeLessThan(10)
    expect(trustedMembers(1000)).toBe(few)
  })

  it('a ring holding a small share of the mass does not move the reference at all', () => {
    // The ordinary case: a captured payment is one of several a worker makes.
    const base = anchoredTrustRank(honestMarket(), ['house'], NOW)!
    const edges = [...honestMarket(), pay('w9', 'r0', 1)]
    for (let i = 0; i < 8; i++) edges.push(pay('w9', `w${i}`, 10))
    const attacked = anchoredTrustRank([...edges, ...ring(1000)], ['house'], NOW)!
    expect(attacked.reference!).toBeGreaterThan(base.reference! * 0.8)
    expect(normalizedTrust(attacked, 'r500')).toBeLessThan(0.001)
  })
})

describe('aggregateEdges', () => {
  it('drops self-payment — paying yourself vouches for nothing', () => {
    expect(aggregateEdges([pay('a', 'a')], NOW).size).toBe(0)
  })

  it('counts an unstamped bounty at the reference rather than dropping it', () => {
    const w = aggregateEdges([pay('a', 'b', null)], NOW).get('a')!.get('b')!
    expect(w).toBeGreaterThan(0)
  })

  it('drops non-positive and non-finite amounts', () => {
    expect(aggregateEdges([pay('a', 'b', 0), pay('a', 'c', -5), pay('a', 'd', Number.NaN)], NOW).size).toBe(0)
  })

  it('decays old payments on the reputation half-life', () => {
    const old = new Date(NOW.getTime() - 180 * 24 * 60 * 60 * 1000)
    const fresh = aggregateEdges([pay('a', 'b', 10, NOW)], NOW).get('a')!.get('b')!
    const aged = aggregateEdges([pay('a', 'b', 10, old)], NOW).get('a')!.get('b')!
    expect(aged / fresh).toBeCloseTo(0.5, 6)
  })

  it('pumping one edge re-divides the payer’s mass, never creates it', () => {
    const once = anchoredTrustRank([pay('house', 'a'), pay('a', 'b')], ['house'], NOW)!
    const pumped = anchoredTrustRank([pay('house', 'a'), ...Array.from({ length: 50 }, () => pay('a', 'b'))], ['house'], NOW)!
    expect(pumped.rank.get('b')!).toBeCloseTo(once.rank.get('b')!, 10)
  })
})

describe('trustReference', () => {
  it('is null when no mass left the anchors — silence, not a verdict of zero', () => {
    const r = anchoredTrustRank([], ['house'], NOW)!
    expect(r.reference).toBeNull()
    expect(normalizedTrust(r, 'anyone')).toBeNull()
  })

  it('an even market reads everyone at full trust', () => {
    const rank = new Map([
      ['house', 0.5],
      ['a', 0.25],
      ['b', 0.25],
    ])
    const ref = trustReference(rank, new Set(['house']))
    expect(ref).toBe(0.25)
  })
})

describe('anchoredTrustWeight', () => {
  it('null is weight 1 — no retroactive penalty when the graph is silent', () => {
    expect(anchoredTrustWeight(null, ANCHORED_TRUST_SCORE_FLOOR)).toBe(1)
    expect(anchoredTrustWeight(undefined, ANCHORED_TRUST_LENDING_FLOOR)).toBe(1)
  })

  it('scales from the floor at 0 to 1 at full trust, clamped', () => {
    expect(anchoredTrustWeight(0, ANCHORED_TRUST_SCORE_FLOOR)).toBe(ANCHORED_TRUST_SCORE_FLOOR)
    expect(anchoredTrustWeight(1, ANCHORED_TRUST_SCORE_FLOOR)).toBe(1)
    expect(anchoredTrustWeight(7, ANCHORED_TRUST_SCORE_FLOOR)).toBe(1)
    expect(anchoredTrustWeight(0, ANCHORED_TRUST_LENDING_FLOOR)).toBe(0)
  })
})

describe('wired into the score and the lending cap', () => {
  const events: AgentEventInput[] = Array.from({ length: 8 }, (_, i) => [
    {
      eventType: 'TASK_COMPLETED',
      success: true,
      executionTime: 10,
      tokenCost: 0,
      qualityScore: 0.9,
      createdAt: new Date(NOW.getTime() + i * 1000),
    },
    {
      eventType: 'JOB_COMPLETED',
      success: true,
      executionTime: 10,
      tokenCost: 0,
      qualityScore: 0.9,
      createdAt: new Date(NOW.getTime() + i * 1000),
      counterparty: `req${i}`,
      counterpartyOtherPartners: 5, // locally, a perfectly healthy neighbourhood
      counterpartyScore: 700,
      grader: 'tests',
      exposureUsd: 10,
    },
  ]).flat()

  it('zero anchored trust lowers the reputation factor; full trust equals no lookup', () => {
    const silent = assessCredit(events, undefined, NOW)
    const full = assessCredit(events, undefined, NOW, { anchoredTrust: 1 })
    const ringed = assessCredit(events, undefined, NOW, { anchoredTrust: 0 })
    expect(full.score).toBe(silent.score)
    expect(ringed.breakdown.reputation).toBeLessThan(silent.breakdown.reputation)
    expect(ringed.score).toBeLessThan(silent.score)
    // Conduct factors are about the agent, not about who paid it.
    expect(ringed.breakdown.performance).toBe(silent.breakdown.performance)
    expect(ringed.breakdown.reliability).toBe(silent.breakdown.reliability)
    expect(ringed.breakdown.anchoredTrust).toBe(0)
    expect(silent.breakdown.anchoredTrust).toBeNull()
  })

  it('a ring collateralizes nothing; a silent graph leaves the cap as it was', () => {
    const trades: SettledTrade[] = Array.from({ length: 8 }, (_, i) => ({
      amountUsd: 50,
      counterparty: `req${i}`,
      counterpartyScore: 700,
      counterpartyOtherPartners: 5,
      createdAt: new Date(NOW.getTime() + i * 1000),
    }))
    const silent = collateralizedCreditLimit(10_000, trades)
    expect(silent).toBeGreaterThan(0)
    expect(collateralizedCreditLimit(10_000, trades, null)).toBe(silent)
    expect(collateralizedCreditLimit(10_000, trades, 1)).toBe(silent)
    expect(collateralizedCreditLimit(10_000, trades, 0)).toBe(0)
  })
})

describe('the server reads', () => {
  it('parses CREDIT_TRUST_ANCHORS', () => {
    expect(envTrustAnchors(undefined)).toEqual([])
    expect(envTrustAnchors(' a, ,b ,')).toEqual(['a', 'b'])
  })

  it('parses a stamped bounty and treats garbage as unstamped', () => {
    expect(parseBounty('12.5')).toBe(12.5)
    expect(parseBounty(null)).toBeNull()
    expect(parseBounty('')).toBeNull()
    expect(parseBounty('abc')).toBeNull()
  })

  it('scans settled work only, keyed on the indexed requester expression', () => {
    const { sql, params } = paymentEdgeQuery().toSQL()
    expect(sql).toContain(`detail->>'requesterAgentId' is not null`)
    expect(params).toContain('JOB_COMPLETED')
  })
})
