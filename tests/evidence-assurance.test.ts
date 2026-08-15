import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GROUND_ASSURANCE,
  MIN_CLASS_FOR_MONEY,
  REMEDY_CEILING,
  capRemedy,
  classOfGround,
  classRank,
  compileClass,
  mayMoveMoney,
  movesMoney,
  remedyRank,
  type EvidenceAssurance,
  type IssuerRelationship,
} from '@/lib/evidence-assurance'

const v = (over: Partial<EvidenceAssurance> = {}): EvidenceAssurance => ({
  reproducibility: 0,
  independence: 0,
  tamperResistance: 0,
  coverage: 3,
  subjectControl: 0,
  ...over,
})

describe('compileClass', () => {
  it('an unsigned assertion nobody can check is E0', () => {
    expect(compileClass(v({ coverage: 0 }), 'INDEPENDENT')).toBe('E0')
  })

  it('a signed observation from an interested party is E1', () => {
    expect(compileClass(v({ tamperResistance: 2, independence: 0 }), 'COUNTERPARTY')).toBe('E1')
  })

  it('a machine-produced, checkable record is E2', () => {
    expect(compileClass(v({ reproducibility: 2, independence: 1, tamperResistance: 1 }), 'INDEPENDENT')).toBe('E2')
  })

  it('a disinterested, tamper-evident witness is E3', () => {
    expect(compileClass(v({ independence: 3, tamperResistance: 3 }), 'INDEPENDENT')).toBe('E3')
  })

  it('something a stranger can re-derive is E4', () => {
    expect(compileClass(v({ reproducibility: 3, independence: 2, tamperResistance: 3 }), 'INDEPENDENT')).toBe('E4')
  })

  /**
   * The inversion is the field most likely to be misread by a future editor,
   * so it gets its own test rather than being implied by another one.
   */
  it('subjectControl is inverted — the accused authoring the evidence weakens it', () => {
    const clean = compileClass(v({ independence: 3, tamperResistance: 3, subjectControl: 0 }), 'INDEPENDENT')
    const authored = compileClass(v({ independence: 3, tamperResistance: 3, subjectControl: 3 }), 'INDEPENDENT')
    expect(classRank(authored)).toBeLessThan(classRank(clean))
  })

  it('coverage 0 collapses everything to E1 — the observer could not see it', () => {
    // Perfect on every other axis, but the event fell outside the boundary the
    // observer declared. That is a claim about something it cannot have seen.
    const blind = compileClass(
      v({ reproducibility: 3, independence: 3, tamperResistance: 3, coverage: 0 }),
      'INDEPENDENT',
    )
    expect(blind).toBe('E1')
  })
})

describe('issuer relationship caps — and the rescue rule', () => {
  it('you cannot corroborate yourself', () => {
    const strong = v({ independence: 3, tamperResistance: 3 })
    expect(compileClass(strong, 'INDEPENDENT')).toBe('E3')
    expect(compileClass(strong, 'SELF')).toBe('E1')
    expect(compileClass(strong, 'COUNTERPARTY')).toBe('E1')
  })

  it('the platform is a market participant, so its own logs cap at E2', () => {
    const strong = v({ independence: 3, tamperResistance: 3 })
    expect(compileClass(strong, 'PLATFORM')).toBe('E2')
    expect(compileClass(strong, 'UNKNOWN')).toBe('E2')
  })

  it('reproducibility rescues a related-party issuer', () => {
    // The whole reason on-chain commitments are worth having: the reader does
    // not have to trust who handed them the claim.
    const recomputable = v({ reproducibility: 3, independence: 2, tamperResistance: 3 })
    expect(compileClass(recomputable, 'PLATFORM')).toBe('E4')
    expect(compileClass(recomputable, 'SELF')).toBe('E4')
  })

  it('a related party that is NOT reproducible stays capped however loudly it signs', () => {
    const signedButPrivate = v({ reproducibility: 1, independence: 3, tamperResistance: 3 })
    expect(compileClass(signedButPrivate, 'PLATFORM')).toBe('E2')
  })
})

describe('the remedy ceiling', () => {
  it('is monotonic — stronger evidence never permits less', () => {
    let prev = -1
    for (const c of ['E0', 'E1', 'E2', 'E3', 'E4'] as const) {
      const r = remedyRank(REMEDY_CEILING[c])
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })

  it('nothing below E3 may move money — the invariant this file exists for', () => {
    for (const c of ['E0', 'E1', 'E2'] as const) {
      expect(mayMoveMoney(c)).toBe(false)
      expect(movesMoney(REMEDY_CEILING[c])).toBe(false)
    }
    for (const c of ['E3', 'E4'] as const) {
      expect(mayMoveMoney(c)).toBe(true)
      expect(movesMoney(REMEDY_CEILING[c])).toBe(true)
    }
    expect(MIN_CLASS_FOR_MONEY).toBe('E3')
  })

  it('semantic judgment cannot reach a monetary remedy by construction', () => {
    // An LLM saying "A appears to have obstructed B": nothing to recompute, no
    // disinterested witness, no tamper evidence. It must not be able to pay out
    // no matter how confident it sounds.
    const llm = compileClass(v({ reproducibility: 0, independence: 1, tamperResistance: 0, coverage: 2 }), 'PLATFORM')
    expect(mayMoveMoney(llm)).toBe(false)
    expect(capRemedy('DETERMINISTIC_SETTLEMENT', llm).remedy).not.toBe('DETERMINISTIC_SETTLEMENT')
  })

  it('capping explains itself, naming both the class and what was asked', () => {
    const out = capRemedy('BOUNDED_RESTITUTION', 'E1')
    expect(out.capped).toBe(true)
    expect(out.remedy).toBe('REPUTATION_NOTE')
    expect(out.reason).toContain('E1')
    expect(out.reason).toContain('BOUNDED_RESTITUTION')
  })

  it('a remedy within the ceiling passes through untouched', () => {
    const out = capRemedy('CAPABILITY_RESTRICTION', 'E3')
    expect(out.capped).toBe(false)
    expect(out.remedy).toBe('CAPABILITY_RESTRICTION')
  })
})

describe('the live refund grounds, scored', () => {
  it('SUBSTITUTED is E4 — an on-chain hash comparison anyone can rerun', () => {
    expect(classOfGround('SUBSTITUTED')).toBe('E4')
    expect(mayMoveMoney(classOfGround('SUBSTITUTED'))).toBe(true)
  })

  it('PLATFORM_TESTS_FAIL may move money — deterministic and re-runnable', () => {
    expect(mayMoveMoney(classOfGround('PLATFORM_TESTS_FAIL'))).toBe(true)
  })

  /**
   * The finding this increment exists to encode. It is a real change to a live
   * money path, in the direction the dispute gate already defaults to.
   */
  it('NO_DELIVERABLE may NOT move money on its own', () => {
    const cls = classOfGround('NO_DELIVERABLE')
    expect(mayMoveMoney(cls)).toBe(false)
    // Not because it is false — because the only party who can see it is a
    // participant in the market it would be paying.
    expect(GROUND_ASSURANCE.NO_DELIVERABLE!.note).toContain('no external witness')
  })

  it('WRONG_KIND sits below the money line too — the MIME is ours, not the chain’s', () => {
    expect(mayMoveMoney(classOfGround('WRONG_KIND'))).toBe(false)
  })

  it('an unmodelled ground inherits nobody’s strength', () => {
    expect(classOfGround('SOME_FUTURE_GROUND')).toBe('E0')
    expect(mayMoveMoney(classOfGround('SOME_FUTURE_GROUND'))).toBe(false)
  })

  it('every ground the decision table can emit has a profile', () => {
    // A ground with no profile scores E0 and can never refund, which is safe
    // but silent. Adding a refund ground should be a deliberate act that
    // includes saying how well it can be known.
    for (const ground of ['NO_DELIVERABLE', 'SUBSTITUTED', 'WRONG_KIND', 'PLATFORM_TESTS_FAIL', 'NONE']) {
      expect(GROUND_ASSURANCE[ground], `${ground} has no assurance profile`).toBeTruthy()
    }
  })

  it('every profile explains itself in prose as well as numbers', () => {
    for (const [ground, p] of Object.entries(GROUND_ASSURANCE)) {
      if (ground === 'NONE') continue
      expect(p.note.length, `${ground} has no note`).toBeGreaterThan(20)
    }
  })
})

/**
 * The wiring guard. `ruleOn` reads the database, so its logic is not unit
 * testable here — but the property that matters is structural: the one path
 * that can move escrow on a V2 market must consult the ceiling. A model with
 * no caller is a document with syntax highlighting.
 */
describe('the live dispute gate consults the ceiling', () => {
  const src = readFileSync(join(process.cwd(), 'lib/dispute-gate.ts'), 'utf8')

  it('imports the ceiling and asks the money question', () => {
    expect(src).toMatch(/from '@\/lib\/evidence-assurance'/)
    expect(src).toMatch(/mayMoveMoney\s*\(/)
    expect(src).toMatch(/classOfGround\s*\(/)
  })

  it('a refund below the money line is downgraded, never executed', () => {
    // The shape that must survive refactoring: when the evidence cannot carry
    // money, the decision becomes no_refund rather than the refund proceeding
    // with a note attached.
    expect(src).toMatch(/!mayMoveMoney\([\s\S]{0,40}\)\s*\)\s*\{[\s\S]{0,400}decision:\s*'no_refund'/)
  })

  it('every ruling records its evidence class, not only the capped ones', () => {
    // A ceiling that leaves a trace only when it bites cannot be audited for
    // whether it ever bit.
    expect(src).toMatch(/evidenceClass,?\s*$/m)
    expect(src).toMatch(/evidenceClass: EvidenceClass/)
  })
})

describe('issuer relationships are exhaustive', () => {
  it('every relationship compiles to something', () => {
    const all: IssuerRelationship[] = ['INDEPENDENT', 'PLATFORM', 'COUNTERPARTY', 'SELF', 'UNKNOWN']
    for (const rel of all) {
      expect(['E0', 'E1', 'E2', 'E3', 'E4']).toContain(compileClass(v({ tamperResistance: 2 }), rel))
    }
  })
})
