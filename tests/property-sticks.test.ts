import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyMerger,
  checkAnticommons,
  distribute,
  distributeLossProceeds,
  isPreferential,
  PERFECTION_RANK,
  rankClaims,
  subrogatedClaims,
  type Stick,
} from '../lib/property-sticks'

const stick = (p: Partial<Stick> & Pick<Stick, 'id' | 'party'>): Stick => ({
  incidents: ['capital'],
  perfection: 'contractual',
  sequence: 0,
  owedCents: 0,
  ...p,
})

describe('priority comes from publicity, not from the order I wrote', () => {
  it('ranks 물권-like sticks above 채권-like ones', () => {
    expect(PERFECTION_RANK.onchain).toBeLessThan(PERFECTION_RANK.contractual)
    expect(PERFECTION_RANK['retained-title']).toBeLessThan(PERFECTION_RANK.contractual)
    expect(PERFECTION_RANK.escrowed).toBeLessThan(PERFECTION_RANK.contractual)
    expect(PERFECTION_RANK.contractual).toBeLessThan(PERFECTION_RANK.none)
  })

  it('treats only the perfected ranks as preferential', () => {
    expect(isPreferential('onchain')).toBe(true)
    expect(isPreferential('retained-title')).toBe(true)
    expect(isPreferential('escrowed')).toBe(true)
    expect(isPreferential('contractual')).toBe(false)
    expect(isPreferential('none')).toBe(false)
  })

  it('orders within a rank by 성립 순위, with a deterministic tiebreak', () => {
    const ranked = rankClaims([
      stick({ id: 'later', party: 'X', perfection: 'onchain', sequence: 9, owedCents: 100 }),
      stick({ id: 'b-same', party: 'Y', perfection: 'onchain', sequence: 1, owedCents: 100 }),
      stick({ id: 'a-same', party: 'Z', perfection: 'onchain', sequence: 1, owedCents: 100 }),
    ])
    expect(ranked.map((r) => r.stick.id)).toEqual(['a-same', 'b-same', 'later'])
  })

  it('drops claims owed nothing rather than emitting zero-value rows', () => {
    expect(rankClaims([stick({ id: 'z', party: 'X', owedCents: 0 })])).toEqual([])
  })
})

describe('distribute', () => {
  it('pays perfected ranks in full, in order, before anyone junior', () => {
    const d = distribute(
      [
        stick({ id: 'senior', party: 'A', perfection: 'onchain', sequence: 1, owedCents: 600 }),
        stick({ id: 'junior', party: 'B', perfection: 'onchain', sequence: 2, owedCents: 600 }),
        stick({ id: 'unsecured', party: 'C', owedCents: 600 }),
      ],
      1_000,
    )
    const by = (id: string) => d.payments.find((p) => p.stickId === id)!
    expect(by('senior').paidCents).toBe(600)
    expect(by('junior').paidCents).toBe(400)
    expect(by('unsecured').paidCents).toBe(0)
    expect(d.remainingCents).toBe(0)
  })

  it('shares a shortfall pro rata within a pari passu rank', () => {
    const d = distribute(
      [
        stick({ id: 'big', party: 'A', owedCents: 900 }),
        stick({ id: 'small', party: 'B', owedCents: 100 }),
      ],
      500,
    )
    const by = (id: string) => d.payments.find((p) => p.stickId === id)!
    expect(by('big').paidCents).toBe(450)
    expect(by('small').paidCents).toBe(50)
    expect(by('big').basis).toBe('pro-rata')
  })

  it('loses no cent to rounding, and gives the dust to the largest claim', () => {
    const d = distribute(
      [
        stick({ id: 'a', party: 'A', owedCents: 333 }),
        stick({ id: 'b', party: 'B', owedCents: 333 }),
        stick({ id: 'c', party: 'C', owedCents: 1_000 }),
      ],
      1_000,
    )
    expect(d.payments.reduce((s, p) => s + p.paidCents, 0)).toBe(1_000)
    const c = d.payments.find((p) => p.stickId === 'c')!
    const a = d.payments.find((p) => p.stickId === 'a')!
    expect(c.paidCents).toBeGreaterThan(a.paidCents)
  })

  it('returns the surplus rather than inventing a claimant for it', () => {
    const d = distribute([stick({ id: 'a', party: 'A', owedCents: 100 })], 400)
    expect(d.remainingCents).toBe(300)
    expect(d.shortfallCents).toBe(0)
  })

  it('pays nobody out of nothing, and reports the whole amount short', () => {
    const d = distribute([stick({ id: 'a', party: 'A', owedCents: 100 })], 0)
    expect(d.payments[0]!.paidCents).toBe(0)
    expect(d.shortfallCents).toBe(100)
  })
})

describe('혼동 — merger (민법 191조)', () => {
  const security = (party: string, id = 'sec') =>
    stick({ id, party, incidents: ['security'], owedCents: 500, secures: ['goods'] })

  it('extinguishes security the residual holder holds against themselves', () => {
    const r = applyMerger([security('B'), stick({ id: 'other', party: 'C', owedCents: 100 })], 'B')
    expect(r.sticks.map((s) => s.id)).toEqual(['other'])
    expect(r.merged[0]!.reason).toMatch(/against themselves/)
  })

  it('keeps it when a third party has a right in that very stick', () => {
    // 제3자의 권리의 목적이 된 경우 소멸하지 않는다: extinguishing B's stick
    // would quietly destroy D's collateral.
    const r = applyMerger(
      [
        security('B'),
        stick({ id: 'onlend', party: 'D', incidents: ['security'], owedCents: 200, secures: ['sec'] }),
      ],
      'B',
    )
    expect(r.sticks.map((s) => s.id).sort()).toEqual(['onlend', 'sec'])
    expect(r.merged).toEqual([])
  })

  it("leaves a third party's security alone", () => {
    const r = applyMerger([security('D')], 'B')
    expect(r.sticks).toHaveLength(1)
    expect(r.merged).toEqual([])
  })

  it('does not touch non-security sticks held by the residual holder', () => {
    const r = applyMerger([stick({ id: 'labour', party: 'B', incidents: ['use'], owedCents: 300 })], 'B')
    expect(r.sticks).toHaveLength(1)
  })
})

describe('anticommons', () => {
  const manager = (party: string, id = 'op') =>
    stick({ id, party, incidents: ['management', 'income'], owedCents: 0 })

  it('accepts exactly one management stick', () => {
    expect(checkAnticommons([manager('B'), stick({ id: 'c', party: 'C' })])).toEqual([])
  })

  it('rejects a graph where nobody decides', () => {
    const f = checkAnticommons([stick({ id: 'c', party: 'C' })])
    expect(f.map((x) => x.code)).toEqual(['NO_MANAGEMENT'])
    expect(f[0]!.reason).toMatch(/no loss has an owner/)
  })

  it('rejects two managers, because each can countermand the other', () => {
    const f = checkAnticommons([manager('B'), manager('B2', 'op2')])
    expect(f.map((x) => x.code)).toEqual(['MULTIPLE_MANAGEMENT'])
  })

  it('rejects a veto held without the residual — a free option to block', () => {
    const f = checkAnticommons([manager('B'), stick({ id: 'c', party: 'C', veto: true })])
    expect(f.map((x) => x.code)).toEqual(['VETO_WITHOUT_MANAGEMENT'])
  })
})

describe('물상대위 — subrogation to the proceeds', () => {
  const sticks = [
    stick({ id: 'goods', party: 'C', owedCents: 9_200 }),
    stick({
      id: 'cap',
      party: 'D',
      incidents: ['security'],
      perfection: 'onchain',
      owedCents: 9_660,
      secures: ['goods'],
    }),
    stick({ id: 'restock', party: 'E', incidents: ['use'], owedCents: 300 }),
  ]

  it('selects only the security whose collateral was destroyed', () => {
    expect(subrogatedClaims(sticks, ['goods']).map((s) => s.id)).toEqual(['cap'])
    expect(subrogatedClaims(sticks, ['something-else'])).toEqual([])
  })

  it('lets the financier reach an insurance payout the destroyed goods produced', () => {
    const d = distributeLossProceeds(sticks, ['goods'], 5_000)
    expect(d.payments).toHaveLength(1)
    expect(d.payments[0]!.party).toBe('D')
    expect(d.payments[0]!.paidCents).toBe(5_000)
    expect(d.payments[0]!.shortfallCents).toBe(4_660)
  })

  it('does not let unsecured claimants at the loss proceeds', () => {
    const d = distributeLossProceeds(sticks, ['goods'], 100_000)
    expect(d.payments.map((p) => p.party)).toEqual(['D'])
    // Surplus falls to the residual holder like any other, not to the queue.
    expect(d.remainingCents).toBe(100_000 - 9_660)
  })
})

describe('the module carries its own strongest objection', () => {
  const src = readFileSync(new URL('../lib/property-sticks.ts', import.meta.url), 'utf8')

  it('names numerus clausus and why publicity is the answer to it', () => {
    expect(src).toMatch(/numerus clausus/)
    expect(src).toMatch(/물권법정주의/)
    expect(src).toMatch(/information cost/)
  })

  it('never defaults an unstated perfection to a preferential rank', () => {
    // Priority nobody published is priority nobody can check, so the default
    // has to be the weak one wherever a node omits it.
    const eg = readFileSync(new URL('../lib/enterprise-graph.ts', import.meta.url), 'utf8')
    const defaults = [...eg.matchAll(/perfection:\s*n\.perfection\s*\?\?\s*'([a-z-]+)'/g)].map(
      (m) => m[1]!,
    )
    expect(defaults.length).toBeGreaterThan(0)
    for (const d of defaults) expect(isPreferential(d as never)).toBe(false)
  })
})
