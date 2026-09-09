import { describe, expect, it } from 'vitest'
import { commissionOutcome, integrationGradeUpdate, integrationOutcome } from '@/lib/delegation-outcome'

describe('integration grader outage', () => {
  it('leaves the check untouched, then accepts a later verified retry', () => {
    const check = { isIntegration: true }
    expect(() => Object.assign(check, integrationGradeUpdate({ passed: null, output: 'offline' }))).toThrow('Integration grader unavailable')
    expect(check).toEqual({ isIntegration: true })
    Object.assign(check, integrationGradeUpdate({ passed: true, output: 'all checks passed' }))
    expect(integrationOutcome(check)).toBe('passed')
  })
  it('preserves a real failed grade as failure', () => {
    expect(integrationOutcome(integrationGradeUpdate({ passed: false, output: 'assertion failed' }))).toBe('failed')
  })
})

describe('customer delivery status', () => {
  it('does not confuse terminal processing with complete delivery', () => {
    expect(commissionOutcome('completed', [{ output: 'research' }, { failed: true }])).toBe('failed')
    expect(commissionOutcome('completed', [{ output: 'research' }, { output: '   ' }])).toBe('failed')
    expect(commissionOutcome('completed', [])).toBe('failed')
    expect(commissionOutcome('completed', [{ output: 'research' }, { output: 'checked' }])).toBe('completed')
  })

  it('reports stopped delegations instead of polling them forever', () => {
    for (const state of ['failed', 'cancelled', 'expired']) {
      expect(commissionOutcome(state, [])).toBe('failed')
    }
    expect(commissionOutcome('posted', [{ failed: true }, {}])).toBe('running')
  })

  it('requires positive integration evidence, including for legacy rows', () => {
    for (const output of [undefined, 'Integration check could not run (grader unavailable): timeout']) {
      const check = { isIntegration: true, output }
      expect(integrationOutcome(check)).toBe('unverified')
      expect(commissionOutcome('completed', [{ output: 'code' }, check])).toBe('failed')
    }
    expect(commissionOutcome('completed', [{ output: 'code' }, { isIntegration: true, output: 'Integration tests PASSED.\n2 tests passed' }])).toBe('completed')
    expect(commissionOutcome('completed', [{ output: 'code' }, { isIntegration: true, failed: true, output: 'Integration tests PASSED.' }])).toBe('failed')
  })
})
