import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  compileEnterprise,
  deriveRisk,
  dissolve,
  MIN_CLASS_FOR_CHARGING_COLLATERAL,
  relatedParties,
  settle,
  type EnterpriseGraph,
  type EnterpriseNode,
} from '../lib/enterprise-graph'

/**
 * The BLCU Monster Energy graph, with the numbers from the intent that
 * motivated this module: wholesale $0.92/unit, restock $3/visit, machine fee
 * 6%, and ~$0.63 of gross margin per unit at $1.55 retail.
 */
function blcu(opts: {
  evidenceClass?: EnterpriseGraph['evidenceClass']
  bondCents?: number
  withheldCents?: number
  financier?: string | null
  units?: number
} = {}): EnterpriseGraph {
  const units = opts.units ?? 100
  const financier = opts.financier === undefined ? 'D' : opts.financier
  const nodes: EnterpriseNode[] = [
    {
      kind: 'OperatingRight',
      id: 'op',
      party: 'B',
      discretion: ['selection', 'pricing', 'reorder-threshold'],
      bondCents: opts.bondCents ?? 0,
      withheldEarningsCents: opts.withheldCents ?? 0,
    },
    { kind: 'InventorySupply', id: 'inv', party: 'C', unitCostCents: 92, units },
    { kind: 'ServiceJob', id: 'restock', party: 'E', feeCents: 300, owedOnPerformance: true },
    { kind: 'CapacityJob', id: 'slot7', party: 'A', feeBps: 600, fixedFeeCents: 0 },
  ]
  if (financier) {
    nodes.push({
      kind: 'CapitalCommitment',
      id: 'cap',
      party: financier,
      principalCents: 92 * units,
      returnBps: 500,
      fundsNodeIds: ['inv'],
    })
  }
  return { id: 'g1', status: 'draft', nodes, evidenceClass: opts.evidenceClass ?? 'E3' }
}

describe('deriveRisk', () => {
  it('does not double-count goods the financier already paid for', () => {
    // $92 of inventory funded by a $92 advance is $92 at risk, not $184.
    const risk = deriveRisk(blcu({ units: 100 }))
    // advance 9200 + return 460 + labour 300; the funded inventory is not re-added
    expect(risk.worstCaseExposureCents).toBe(9200 + 460 + 300)
  })

  it('charges unfunded goods to the graph', () => {
    const risk = deriveRisk(blcu({ financier: null }))
    expect(risk.worstCaseExposureCents).toBe(9200 + 300)
  })

  it('excludes the bond from the ceiling below the collateral-charging class', () => {
    const weak = deriveRisk(blcu({ evidenceClass: 'E2', bondCents: 8000, withheldCents: 1500 }))
    expect(weak.collateralChargeable).toBe(false)
    expect(weak.enforceableCeilingCents).toBe(1500)

    const strong = deriveRisk(blcu({ evidenceClass: 'E3', bondCents: 8000, withheldCents: 1500 }))
    expect(strong.collateralChargeable).toBe(true)
    expect(strong.enforceableCeilingCents).toBe(9500)
  })
})

describe('compileEnterprise refuses rather than prices', () => {
  it('denies when nobody holds the residual', () => {
    const g = blcu()
    g.nodes = g.nodes.filter((n) => n.kind !== 'OperatingRight')
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denials.map((d) => d.code)).toContain('NO_OPERATOR')
  })

  it('denies two residual holders', () => {
    const g = blcu()
    g.nodes.push({ ...(g.nodes[0] as EnterpriseNode & { kind: 'OperatingRight' }), id: 'op2', party: 'B2' })
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denials.map((d) => d.code)).toContain('MULTIPLE_OPERATORS')
  })

  it('calls a holder who decides nothing what they are', () => {
    const g = blcu({ bondCents: 100_000, evidenceClass: 'E3' })
    ;(g.nodes[0] as { discretion: string[] }).discretion = []
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.denials.map((d) => d.code)).toContain('NO_DISCRETION')
      expect(r.denials.find((d) => d.code === 'NO_DISCRETION')!.reason).toMatch(/not operatorship/)
    }
  })

  it("refuses someone else's capital when the evidence cannot support charging collateral", () => {
    const r = compileEnterprise(blcu({ evidenceClass: 'E2', bondCents: 1_000_000, withheldCents: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.denials.map((d) => d.code)).toContain('THIRD_PARTY_CAPITAL_UNSECURED')
      expect(r.denials.find((d) => d.code === 'THIRD_PARTY_CAPITAL_UNSECURED')!.reason).toContain('E2')
    }
  })

  it('allows the operator to finance their own inventory at any class', () => {
    // B lending to B is not a lender whose loss needs proving.
    const r = compileEnterprise(
      blcu({ evidenceClass: 'E0', financier: 'B', withheldCents: 9200 + 460 + 300 }),
    )
    expect(r.ok).toBe(true)
  })

  it('denies exposure above the enforceable ceiling, and says a bigger bond would not help', () => {
    const r = compileEnterprise(blcu({ evidenceClass: 'E3', withheldCents: 100 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const d = r.denials.find((x) => x.code === 'EXPOSURE_EXCEEDS_CEILING')!
      expect(d.reason).toMatch(/bounds nothing/)
    }
  })

  it('denies revenue-proportional claims that consume the whole sale', () => {
    const g = blcu({ evidenceClass: 'E3', bondCents: 100_000 })
    g.nodes.push({ kind: 'RecipeLicense', id: 'ip', party: 'X', royaltyBps: 9_500 })
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denials.map((d) => d.code)).toContain('ROYALTY_OVERSUBSCRIBED')
  })

  it('denies an advance that claims to have paid more than it advances', () => {
    const g = blcu({ evidenceClass: 'E3', bondCents: 100_000 })
    const cap = g.nodes.find((n) => n.kind === 'CapitalCommitment') as { principalCents: number }
    cap.principalCents = 5000 // funds $92 of goods with $50
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denials.map((d) => d.code)).toContain('ADVANCE_DOES_NOT_COVER_WHAT_IT_FUNDS')
  })

  it('denies funding a node that is not in the graph', () => {
    const g = blcu({ evidenceClass: 'E3', bondCents: 100_000 })
    const cap = g.nodes.find((n) => n.kind === 'CapitalCommitment') as { fundsNodeIds: string[] }
    cap.fundsNodeIds = ['ghost']
    const r = compileEnterprise(g)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.denials.map((d) => d.code)).toContain('FUNDS_UNKNOWN_NODE')
  })
})

describe('related parties are disclosed, not refused', () => {
  it('compiles a graph where one wallet holds three roles, and says so', () => {
    const g = blcu({ evidenceClass: 'E3', financier: 'B', withheldCents: 20_000 })
    // B is operator and financier; make B the restocker too.
    ;(g.nodes.find((n) => n.id === 'restock') as { party: string }).party = 'B'
    const r = compileEnterprise(g)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiled.fullyIndependent).toBe(false)
      const b = r.compiled.relatedParties.find((p) => p.party === 'B')!
      expect(b.roles.sort()).toEqual(['CapitalCommitment', 'OperatingRight', 'ServiceJob'])
    }
  })

  it('reports fully independent only when no party holds two roles', () => {
    const r = compileEnterprise(blcu({ evidenceClass: 'E3', bondCents: 10_000, withheldCents: 200 }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiled.fullyIndependent).toBe(true)
      expect(r.compiled.relatedParties).toEqual([])
    }
  })

  it('relatedParties ignores a party appearing twice in the same role', () => {
    expect(
      relatedParties([
        { kind: 'InventorySupply', id: 'a', party: 'C', unitCostCents: 1, units: 1 },
        { kind: 'InventorySupply', id: 'b', party: 'C', unitCostCents: 1, units: 1 },
      ]),
    ).toEqual([])
  })
})

describe('the settlement waterfall', () => {
  const compiled = (() => {
    const r = compileEnterprise(blcu({ evidenceClass: 'E3', bondCents: 10_000, withheldCents: 200 }))
    if (!r.ok) throw new Error(r.denials.map((d) => d.reason).join('; '))
    return r.compiled
  })()

  it('pays six typed claims out of one sale and loses no cent', () => {
    const revenue = 155 * 100 // 100 units at $1.55
    const s = settle(compiled, revenue)
    const paid = s.allocations.reduce((sum, a) => sum + a.cents, 0)
    expect(paid).toBe(revenue)
  })

  it('pays the financier instead of the supplier it already paid', () => {
    const s = settle(compiled, 15_500)
    const inv = s.allocations.find((a) => a.nodeId === 'inv')
    expect(inv).toBeUndefined()
    const cap = s.allocations.find((a) => a.nodeId === 'cap')!
    expect(cap.cents).toBe(9200 + 460)
  })

  it('gives the operator the residual, last', () => {
    const s = settle(compiled, 15_500)
    // 15500 − cap 9660 − restock 300 − slot fee 6% of 15500 (930) = 4610
    expect(s.residualCents).toBe(15_500 - 9_660 - 300 - 930)
    expect(s.allocations.at(-1)!.kind).toBe('Residual')
    expect(s.allocations.at(-1)!.party).toBe('B')
  })

  it('makes the residual negative when the sale did not cover the senior claims', () => {
    const s = settle(compiled, 5_000)
    expect(s.residualCents).toBeLessThan(0)
    // Everything above the residual is paid in priority order until it runs out.
    expect(s.allocations.reduce((sum, a) => sum + a.cents, 0)).toBe(5_000 + s.residualCents)
  })

  it('reports nothing unrecovered while the loss fits inside the holdings', () => {
    const s = settle(compiled, 9_500)
    expect(s.residualCents).toBeLessThan(0)
    expect(-s.residualCents).toBeLessThanOrEqual(compiled.risk.enforceableCeilingCents)
    expect(s.unrecoveredCents).toBe(0)
  })

  it('shares a shortfall pro rata among claimants of equal rank, not by list position', () => {
    // 채권자평등의 원칙. cap ($96.60), restock ($3.00) and the slot fee are all
    // merely contractual here, so none outranks the others and each takes the
    // same proportional haircut. The old hand-written order paid whichever I
    // filtered first in full and left an equal claimant with nothing.
    const s = settle(compiled, 5_000)
    const owed = { cap: 9_660, restock: 300, slot7: 300 }
    const total = owed.cap + owed.restock + owed.slot7
    for (const [id, o] of Object.entries(owed)) {
      const a = s.allocations.find((x) => x.nodeId === id)!
      expect(a.cents).toBeGreaterThan(0)
      // Within a cent of its proportional share (the dust goes to the largest).
      expect(Math.abs(a.cents - (5_000 * o) / total)).toBeLessThanOrEqual(1)
    }
  })

  it('pays a perfected financier in full ahead of everyone — which is what perfection IS', () => {
    // The same graph, with the advance recorded on-chain (assignPayee) instead
    // of promised. This is the difference between 물권 and 채권, and it is the
    // protocol's actual offer to a lender.
    const g = blcu({ evidenceClass: 'E3', bondCents: 10_000, withheldCents: 200 })
    ;(g.nodes.find((n) => n.id === 'cap') as { perfection?: string }).perfection = 'onchain'
    const r = compileEnterprise(g)
    if (!r.ok) throw new Error('should compile')
    const s = settle(r.compiled, 5_000)

    const cap = s.allocations.find((a) => a.nodeId === 'cap')!
    expect(cap.cents).toBe(5_000) // takes the whole sale before anyone else
    expect(cap.shortfallCents).toBe(9_660 - 5_000)
    for (const id of ['restock', 'slot7']) {
      expect(s.allocations.find((a) => a.nodeId === id)!.cents).toBe(0)
    }
  })

  it('pays zero to everyone on a zero-revenue graph without going negative anywhere', () => {
    const s = settle(compiled, 0)
    for (const a of s.allocations.filter((x) => x.kind !== 'Residual')) expect(a.cents).toBe(0)
    expect(s.residualCents).toBeLessThan(0)
  })
})

describe('dissolve', () => {
  it('revokes the graph but keeps the record contextual credit is computed from', () => {
    const r = compileEnterprise(blcu({ evidenceClass: 'E3', bondCents: 10_000, withheldCents: 200 }))
    if (!r.ok) throw new Error('should compile')
    const s = settle(r.compiled, 15_500)
    const { graph, record } = dissolve(r.compiled, s)
    expect(graph.status).toBe('dissolved')
    expect(record.graphId).toBe('g1')
    expect(record.residualCents).toBe(s.residualCents)
    expect(record.allocations).toHaveLength(s.allocations.length)
    expect(record.fullyIndependent).toBe(true)
  })
})

describe('the module does not smuggle invented numbers back in', () => {
  const src = readFileSync(new URL('../lib/enterprise-graph.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export type Cents'))

  it('declares no exposure tier or risk-limit constant', () => {
    expect(body).not.toMatch(/(MAX|CAP|LIMIT|TIER)_[A-Z_]*(EXPOSURE|USD|CENTS)\s*=/)
    expect(body).not.toMatch(/maxInventoryExposure/)
  })

  it('declares no similarity or transfer coefficient', () => {
    expect(body).not.toMatch(/transferRate|similarityTransfer|TRANSFER_[A-Z_]*=/)
  })

  it('keeps the collateral-charging floor at E3', () => {
    expect(MIN_CLASS_FOR_CHARGING_COLLATERAL).toBe('E3')
  })

  it('derives the risk number instead of accepting it', () => {
    // A compiler that takes worstCaseExposure as an argument is a calculator:
    // the party who benefits from a small number would be supplying it.
    expect(body).not.toMatch(/worstCaseExposure\w*\s*:\s*(number|Cents)\s*[,;}]/)
  })
})
