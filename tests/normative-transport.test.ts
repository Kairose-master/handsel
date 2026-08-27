import { describe, it, expect } from 'vitest'
import {
  transportFor,
  planTransport,
  conservationBreaches,
  escapesByRestructuring,
  type Incident,
  type TransportFacts,
} from '@/lib/normative-transport'

const FISSION: TransportFacts = {
  topology: 'fission',
  successorCount: 2,
  inContemplation: false,
  sameController: true,
  relianceWaived: false,
}

function incident(over: Partial<Incident> & Pick<Incident, 'id' | 'kind'>): Incident {
  return {
    holder: 'A',
    content: '',
    groundingEvent: 'e',
    counterparty: null,
    rival: false,
    indexical: false,
    uniqueByReliance: false,
    ...over,
  }
}

/**
 * §10.1's worked case, verbatim: an agent duplicated during migration, five
 * incidents, four operations, three justificatory grounds — under ONE
 * transformation with ONE set of identity facts. This is the Proposition in
 * its practical form, so it is the fixture the implementation is held to.
 */
describe('the paper’s worked case (§10.1)', () => {
  const incidents: Incident[] = [
    incident({ id: 'comp', kind: 'claim', content: 'Unpaid compensation, 100', rival: true, amount: 100 }),
    incident({ id: 'conf', kind: 'duty', content: 'Confidentiality re q', rival: false }),
    incident({ id: 'sign', kind: 'power', content: 'API signing authority', uniqueByReliance: true }),
    incident({ id: 'tort', kind: 'liability', content: 'Tort liability from e' }),
    incident({ id: 'audit', kind: 'immunity', content: 'Immunity from audit until d', rival: false }),
  ]

  const verdicts = planTransport(incidents, FISSION)
  const by = Object.fromEntries(verdicts.map((v) => [v.incidentId, v]))

  it('divides the rival claim, on structural grounds', () => {
    expect(by.comp).toMatchObject({ op: 'divide', status: 'Required', ground: 'structural' })
  })

  it('replicates the non-rival duty, on structural grounds', () => {
    expect(by.conf).toMatchObject({ op: 'replicate', ground: 'structural' })
  })

  it('preserves the signing power uniquely, on reliance grounds', () => {
    expect(by.sign).toMatchObject({ op: 'preserve', status: 'Required', ground: 'reliance' })
  })

  it('treats the tort liability conditionally, on anti-avoidance grounds', () => {
    expect(by.tort).toMatchObject({ op: 'divide', ground: 'anti-avoidance' })
  })

  it('replicates the immunity, on structural grounds', () => {
    expect(by.audit).toMatchObject({ op: 'replicate', ground: 'structural' })
  })

  it('yields distinct operations and three grounds from one transformation', () => {
    // The Proposition (§8): identity facts do not determine the normative
    // outcome, because the rules differ by kind. The paper counts "four
    // operations" by treating the liability's CONDITIONAL as its own entry;
    // under any single fact vector three concrete ops appear, and the fourth
    // is the fact that one of them moves while the others do not — asserted
    // in the next test rather than by miscounting this one.
    expect(new Set(verdicts.map((v) => v.op)).size).toBe(3)
    expect(new Set(verdicts.map((v) => v.ground)).size).toBe(3)
  })

  it('moves only the liability when the provenance finding changes', () => {
    // That is what "conditional" means in the table, and it is the whole
    // reason the liability row is different from the other four.
    const contemplated = planTransport(incidents, { ...FISSION, inContemplation: true })
    const changed = contemplated.filter((v, i) => v.op !== verdicts[i].op).map((v) => v.incidentId)
    expect(changed).toEqual(['tort'])
  })
})

describe('rivalry decides divisibility (Principle 3)', () => {
  it('never lets a rival claim multiply', () => {
    // Not a policy preference: a claim of 100 becoming two claims of 100
    // increases a counterparty's exposure by an event it was not party to.
    const v = transportFor(incident({ id: 'x', kind: 'claim', rival: true, amount: 100 }), FISSION)
    expect(v.op).toBe('divide')
    expect(v.status).toBe('Required')
  })

  it('replicates a non-rival duty rather than splitting it', () => {
    // Dividing a confidentiality duty defeats it.
    expect(transportFor(incident({ id: 'x', kind: 'duty', rival: false }), FISSION).op).toBe('replicate')
  })
})

describe('reliance constrains multiplication (Principle 4)', () => {
  it('keeps a uniquely-relied-on power in one holder', () => {
    const v = transportFor(incident({ id: 'k', kind: 'power', uniqueByReliance: true }), FISSION)
    expect(v).toMatchObject({ op: 'preserve', status: 'Required', ground: 'reliance' })
  })

  it('lets the relying parties waive it', () => {
    // Defeasible, unlike a structural ground: the constraint tracks an
    // identifiable interest and dissolves when that interest consents.
    const v = transportFor(incident({ id: 'k', kind: 'power', uniqueByReliance: true }), {
      ...FISSION,
      relianceWaived: true,
    })
    expect(v.op).not.toBe('preserve')
  })

  it('outranks rivalry, because the constraint comes from outside the incident', () => {
    const v = transportFor(
      incident({ id: 'k', kind: 'power', uniqueByReliance: true, rival: true, amount: 1 }),
      FISSION,
    )
    expect(v.ground).toBe('reliance')
  })
})

describe('indexical incidents do not replicate (Principle 5)', () => {
  it('extinguishes rather than passing on a disqualification', () => {
    // "Representation of a history is not participation in it." A successor
    // holding the record of an event did not take part in it.
    const v = transportFor(incident({ id: 'd', kind: 'liability', indexical: true }), {
      ...FISSION,
      inContemplation: false,
    })
    expect(v).toMatchObject({ op: 'extinguish', status: 'Required', ground: 'structural' })
  })

  it('is reached before rivalry, since a successor cannot satisfy the spec either way', () => {
    const v = transportFor(incident({ id: 'd', kind: 'duty', indexical: true, rival: true, amount: 5 }), FISSION)
    expect(v.op).toBe('extinguish')
  })
})

describe('transformation may not improve a normative position (Principle 6)', () => {
  it('replicates a liability when the fission was in contemplation of it', () => {
    const v = transportFor(incident({ id: 't', kind: 'liability' }), { ...FISSION, inContemplation: true })
    expect(v).toMatchObject({ op: 'replicate', status: 'Required', ground: 'anti-avoidance' })
  })

  it('does not read an unresolved motive as an absent one', () => {
    // Dividing on an unresolved provenance question is exactly the incentive
    // the penalty default exists to remove.
    const v = transportFor(incident({ id: 't', kind: 'liability' }), { ...FISSION, inContemplation: 'unknown' })
    expect(v.op).toBe('replicate')
    expect(v.status).toBe('Permitted')
  })

  it('divides only on a positive finding that the fission was innocent', () => {
    expect(transportFor(incident({ id: 't', kind: 'liability' }), { ...FISSION, inContemplation: false }).op).toBe('divide')
  })
})

describe('escapesByRestructuring — Principle 6 without a mental-state inquiry', () => {
  const liability = { kind: 'liability' as const, indexical: false }

  it('catches the same controller shedding a burden by minting a successor', () => {
    // The case Handsel actually has: failedWorkerIds holds agent ids, a new
    // agent gets a new id, and both belong to one account.
    expect(
      escapesByRestructuring({ predecessorController: 'u1', successorController: 'u1', incident: liability }),
    ).toBe(true)
  })

  it('does not fire across genuinely different controllers', () => {
    // A different owner taking the reposted work is the market functioning,
    // not avoidance.
    expect(
      escapesByRestructuring({ predecessorController: 'u1', successorController: 'u2', incident: liability }),
    ).toBe(false)
  })

  it('covers indexical incidents of any kind, not only liabilities', () => {
    expect(
      escapesByRestructuring({
        predecessorController: 'u1',
        successorController: 'u1',
        incident: { kind: 'duty', indexical: true },
      }),
    ).toBe(true)
  })

  it('cannot establish an escape from unknown controllers', () => {
    // And a caller must not read false here as "cleared" — it is "cannot
    // tell", which is why the rule is stated as an escape detector rather
    // than a clearance.
    expect(
      escapesByRestructuring({ predecessorController: null, successorController: 'u1', incident: liability }),
    ).toBe(false)
  })
})

describe('merger composes rather than aggregates (Principle 7)', () => {
  const MERGER: TransportFacts = { ...FISSION, topology: 'merger', successorCount: 1 }

  it('lets non-rival duties compose, each borne in full', () => {
    const v = transportFor(incident({ id: 'c', kind: 'duty', rival: false }), MERGER)
    expect(v).toMatchObject({ op: 'merge', ground: 'structural' })
  })

  it('refuses to rank colliding obligations instead of guessing', () => {
    // The framework provides no meta-rule for ranking, and inventing one here
    // would be precision without justification.
    const v = transportFor(incident({ id: 'x', kind: 'duty', rival: true, amount: 1 }), MERGER)
    expect(v.ground).toBe('default')
    expect(v.because).toMatch(/priority|compensatory/i)
  })
})

describe('persistence decides nothing', () => {
  it('preserves everything under 1→1', () => {
    const v = transportFor(incident({ id: 'x', kind: 'claim', rival: true, amount: 9 }), {
      ...FISSION,
      topology: 'persistence',
      successorCount: 1,
    })
    expect(v).toMatchObject({ op: 'preserve', status: 'Required' })
  })
})

describe('conservation is checked, not trusted', () => {
  const claim = incident({ id: 'comp', kind: 'claim', rival: true, amount: 100 })
  const verdicts = planTransport([claim], FISSION)

  it('reports a rival claim whose aggregate grew across the successors', () => {
    // A verdict of `divide` is a promise about totals, and nothing enforces
    // it unless someone adds the successors up.
    const breaches = conservationBreaches(verdicts, [claim], new Map([['comp', 200]]))
    expect(breaches).toEqual([{ incidentId: 'comp', before: 100, after: 200 }])
  })

  it('accepts a split that conserves', () => {
    expect(conservationBreaches(verdicts, [claim], new Map([['comp', 100]]))).toEqual([])
  })

  it('does not report float drift as expropriation', () => {
    const cents = incident({ id: 'c', kind: 'claim', rival: true, amount: 0.1 + 0.2 })
    const vs = planTransport([cents], FISSION)
    expect(conservationBreaches(vs, [cents], new Map([['c', 0.3]]))).toEqual([])
  })

  it('ignores incidents that were not divided', () => {
    const dutyI = incident({ id: 'd', kind: 'duty', rival: false, amount: 1 })
    const vs = planTransport([dutyI], FISSION)
    expect(conservationBreaches(vs, [dutyI], new Map([['d', 99]]))).toEqual([])
  })
})
