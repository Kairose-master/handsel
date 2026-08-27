import { describe, it, expect } from 'vitest'
import {
  FAMILIES,
  CODES,
  SEVERITIES,
  GENERIC_CODES,
  isGenericCode,
  validateCode,
  severityFor,
  maySettle,
  attributableToWorker,
  stateFor,
  TASK_OUTCOMES,
  type Diagnosis,
} from '@/lib/failure-codes'

describe('"it failed" and "it scored low" are different states', () => {
  // The rule the whole table exists for. When they collapse, a system fault
  // becomes the worker's penalty: the worker loses the bounty and takes the
  // credit hit for an outage.
  it('does not attribute an incomplete evaluation to the worker', () => {
    expect(attributableToWorker({ taskOutcome: 'UNKNOWN', execution: 'FAILURE' })).toBe(false)
    expect(attributableToWorker({ taskOutcome: 'FAIL', execution: 'FAILURE' })).toBe(false)
    expect(attributableToWorker({ taskOutcome: 'FAIL', execution: 'PARTIAL' })).toBe(false)
  })

  it('attributes only a completed evaluation that judged the work wanting', () => {
    expect(attributableToWorker({ taskOutcome: 'FAIL', execution: 'SUCCESS' })).toBe(true)
  })

  it('does not attribute a refused brief or work nobody could do', () => {
    // Recorded against different parties — a refused brief goes on record
    // against the requester, and work that cannot be done returns to market.
    for (const o of ['REFUSED_BRIEF', 'CANNOT_DO'] as const) {
      expect(attributableToWorker({ taskOutcome: o, execution: 'SUCCESS' }), o).toBe(false)
    }
  })

  it('keeps the two axes genuinely independent', () => {
    // Every combination is meaningful; neither axis is derivable from the other.
    expect(TASK_OUTCOMES).toContain('UNKNOWN')
    expect(attributableToWorker({ taskOutcome: 'PASS', execution: 'SUCCESS' })).toBe(false)
  })
})

describe('a code names a cause, or admits it cannot', () => {
  it('refuses the codes that name nothing', () => {
    // The .de DNSSEC lesson: the real cause was an invalid signature and the
    // resolver reported a generic "no reachable authority", which hid it.
    for (const g of GENERIC_CODES) {
      expect(isGenericCode(g), g).toBe(true)
      const v = validateCode(g)
      expect(v.ok, g).toBe(false)
      if (!v.ok) expect(v.why).toMatch(/names no cause/)
    }
  })

  it('refuses them case-insensitively and with whitespace', () => {
    expect(isGenericCode('  failed ')).toBe(true)
    expect(isGenericCode('Grading_Failed')).toBe(true)
  })

  it('accepts a well-formed family code', () => {
    expect(validateCode('DEP-001').ok).toBe(true)
    expect(validateCode('VER-003').ok).toBe(true)
  })

  it('refuses a family it does not know', () => {
    const v = validateCode('XYZ-001')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.why).toMatch(/not a known failure family/)
  })

  it('refuses a malformed code rather than guessing at it', () => {
    for (const bad of ['DEP1', 'dep-001', 'DEP-1', 'DEP-0001', '']) {
      expect(validateCode(bad).ok, bad).toBe(false)
    }
  })

  it('lets an undetermined cause stay undetermined', () => {
    // A wrong confident code is worse than an honest uncertain one.
    const d: Diagnosis = {
      primaryCode: 'DEP-001',
      causeStatus: 'UNCONFIRMED',
      suspectedCauses: ['DEP-005', 'TIM-001'],
      severity: 'S1',
      taskOutcome: 'UNKNOWN',
      execution: 'FAILURE',
    }
    expect(stateFor(d)).not.toBe('FINAL')
    expect(d.suspectedCauses).toHaveLength(2)
  })
})

describe('severity is contextual, and only ever rises', () => {
  it('uses the table value with no context', () => {
    expect(severityFor('TIM-002')).toBe('S1')
    expect(severityFor('AUTH-003')).toBe('S4')
  })

  it('escalates a timeout when the lost response may have moved money', () => {
    // The study's own example: a test that ran long is S1; a payment
    // transaction whose response was lost is a different fact about the world,
    // because whether money moved is now unknown.
    expect(severityFor('TIM-002', { fundsAtRisk: true })).toBe('S3')
  })

  it('escalates on personal data and on an adversary', () => {
    expect(severityFor('TIM-002', { personalData: true })).toBe('S4')
    expect(severityFor('DEP-001', { adversarial: true })).toBe('S4')
  })

  it('never lowers a severity', () => {
    // The table value is a floor. Anything that reduces it is an argument for
    // a person to make, not a default to apply.
    expect(severityFor('AUTH-003', { fundsAtRisk: true })).toBe('S4')
    expect(severityFor('SEC-001', {})).toBe('S4')
  })

  it('falls back to the family, not to a guess, for a code it does not carry', () => {
    // The table deliberately holds only labels read verbatim from the study;
    // an uncodified code in a known family is still usable.
    expect(severityFor('PRV-004')).toBe(FAMILIES.PRV.defaultSeverity)
    expect(severityFor('RAT-002')).toBe(FAMILIES.RAT.defaultSeverity)
  })
})

describe('what may settle', () => {
  it('refuses to settle anything S2 or worse', () => {
    // Uncertain is not a verdict to pay on.
    for (const s of ['S2', 'S3', 'S4'] as const) {
      expect(maySettle({ severity: s, execution: 'SUCCESS', taskOutcome: 'PASS' }), s).toBe(false)
    }
  })

  it('refuses to settle on an evaluation that did not complete', () => {
    expect(maySettle({ severity: 'S0', execution: 'FAILURE', taskOutcome: 'FAIL' })).toBe(false)
    expect(maySettle({ severity: 'S0', execution: 'PARTIAL', taskOutcome: 'PASS' })).toBe(false)
  })

  it('refuses to settle on an outcome that judged nothing', () => {
    expect(maySettle({ severity: 'S0', execution: 'SUCCESS', taskOutcome: 'UNKNOWN' })).toBe(false)
  })

  it('settles a completed pass or fail at low severity', () => {
    expect(maySettle({ severity: 'S0', execution: 'SUCCESS', taskOutcome: 'PASS' })).toBe(true)
    expect(maySettle({ severity: 'S1', execution: 'SUCCESS', taskOutcome: 'FAIL' })).toBe(true)
  })
})

describe('where a diagnosis leaves the judgment', () => {
  const base = { causeStatus: 'CONFIRMED' as const, taskOutcome: 'FAIL' as const, execution: 'SUCCESS' as const }

  it('escalates a security-class incident rather than holding it', () => {
    expect(stateFor({ ...base, severity: 'S4' })).toBe('ESCALATED')
  })

  it('holds anything that materially threatens the judgment', () => {
    expect(stateFor({ ...base, severity: 'S3' })).toBe('HELD')
    expect(stateFor({ ...base, severity: 'S0', execution: 'FAILURE' })).toBe('HELD')
  })

  it('marks uncertainty provisional rather than final', () => {
    expect(stateFor({ ...base, severity: 'S2' })).toBe('PROVISIONAL')
    expect(stateFor({ ...base, severity: 'S0', execution: 'PARTIAL' })).toBe('PROVISIONAL')
    expect(stateFor({ ...base, severity: 'S0', causeStatus: 'UNCONFIRMED' })).toBe('PROVISIONAL')
  })

  it('reaches FINAL only on a clean, confirmed, completed judgment', () => {
    expect(stateFor({ ...base, severity: 'S0' })).toBe('FINAL')
  })
})

describe('the table itself', () => {
  it('gives every family a default severity that exists', () => {
    for (const [f, v] of Object.entries(FAMILIES)) {
      expect(SEVERITIES, `${f} severity`).toContain(v.defaultSeverity)
      expect(v.of.length, `${f} needs a definition`).toBeGreaterThan(10)
    }
  })

  it('puts every carried code in a declared family', () => {
    for (const [code, v] of Object.entries(CODES)) {
      expect(FAMILIES, code).toHaveProperty(v.family)
      expect(code.startsWith(v.family), `${code} does not match family ${v.family}`).toBe(true)
      expect(validateCode(code).ok, code).toBe(true)
    }
  })

  it('gives every carried code a disposition, not just a severity', () => {
    // A severity says how bad; a disposition says what to do. A table with
    // only the first is a taxonomy, not a codex.
    for (const [code, v] of Object.entries(CODES)) {
      expect(v.disposition.length, `${code} needs a disposition`).toBeGreaterThan(5)
    }
  })

  it('treats the attack, privacy and authorisation families as the severe ones', () => {
    expect(FAMILIES.SEC.defaultSeverity).toBe('S4')
    expect(FAMILIES.PRV.defaultSeverity).toBe('S4')
    expect(SEVERITIES.indexOf(FAMILIES.AUTH.defaultSeverity)).toBeGreaterThanOrEqual(SEVERITIES.indexOf('S3'))
  })
})
