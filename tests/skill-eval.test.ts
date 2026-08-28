import { describe, it, expect } from 'vitest'
import {
  evaluateSkillWindows,
  gradedOutcomeFromEvent,
  MIN_GRADED_PER_WINDOW,
  type GradedOutcome,
} from '@/lib/skill-eval'

const T0 = new Date('2026-08-01T00:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000)

function outcomes(spec: Array<[dayOffset: number, passed: boolean]>): GradedOutcome[] {
  return spec.map(([n, passed]) => ({ at: day(n), passed }))
}

describe('evaluateSkillWindows', () => {
  it('splits at the install time; an outcome AT the instant counts as after', () => {
    const r = evaluateSkillWindows(day(0), outcomes([[-1, true], [0, false], [1, true]]), { minPerWindow: 1 })
    expect(r.before).toMatchObject({ passed: 1, total: 1 })
    expect(r.after).toMatchObject({ passed: 1, total: 2 })
  })

  it('an empty window has a null rate, never 0% — no outcomes is not failure', () => {
    const r = evaluateSkillWindows(day(0), outcomes([[1, true]]), { minPerWindow: 1 })
    expect(r.before.rate).toBeNull()
    expect(r.after.rate).toBe(1)
  })

  it('withholds the delta until BOTH windows reach the minimum, naming which side is short', () => {
    const enough = Array.from({ length: MIN_GRADED_PER_WINDOW }, (_, i) => [-(i + 1), true] as [number, boolean])
    const few: Array<[number, boolean]> = [[1, true]]

    const shortAfter = evaluateSkillWindows(day(0), outcomes([...enough, ...few]))
    expect(shortAfter.verdict).toBe('insufficient-after')
    expect(shortAfter.deltaPoints).toBeNull()

    const shortBefore = evaluateSkillWindows(
      day(0),
      outcomes([[-1, true], ...enough.map(([n, p]) => [-n, p] as [number, boolean])]),
    )
    expect(shortBefore.verdict).toBe('insufficient-before')
    expect(shortBefore.deltaPoints).toBeNull()

    expect(evaluateSkillWindows(day(0), []).verdict).toBe('insufficient-both')
  })

  it('states the delta in percentage points once both windows qualify', () => {
    // before: 2/5 pass (40%), after: 4/5 pass (80%) → +40.0 points
    const r = evaluateSkillWindows(
      day(0),
      outcomes([
        [-5, true], [-4, true], [-3, false], [-2, false], [-1, false],
        [1, true], [2, true], [3, true], [4, true], [5, false],
      ]),
    )
    expect(r.verdict).toBe('measured')
    expect(r.before.rate).toBeCloseTo(0.4)
    expect(r.after.rate).toBeCloseTo(0.8)
    expect(r.deltaPoints).toBe(40)
  })

  it('the delta can be negative — the measure reports, it does not cheerlead', () => {
    const r = evaluateSkillWindows(
      day(0),
      outcomes([
        [-5, true], [-4, true], [-3, true], [-2, true], [-1, true],
        [1, false], [2, false], [3, false], [4, false], [5, true],
      ]),
    )
    expect(r.deltaPoints).toBe(-80)
  })

  it('is order-independent and does not mutate its input', () => {
    const list = outcomes([[2, true], [-3, false], [1, false], [-1, true]])
    const snapshot = JSON.stringify(list)
    const a = evaluateSkillWindows(day(0), list, { minPerWindow: 1 })
    const b = evaluateSkillWindows(day(0), [...list].reverse(), { minPerWindow: 1 })
    expect(a).toEqual(b)
    expect(JSON.stringify(list)).toBe(snapshot)
  })

  it('no verdict string ever claims causation', () => {
    const r = evaluateSkillWindows(day(0), [])
    for (const banned of ['improve', 'worse', 'better', 'caused']) {
      expect(r.verdict).not.toContain(banned)
    }
  })
})

describe('gradedOutcomeFromEvent', () => {
  it('classifies exactly the established graded set and nothing else', () => {
    const at = day(0)
    expect(gradedOutcomeFromEvent('JOB_TESTS_PASSED', at)).toEqual({ at, passed: true })
    expect(gradedOutcomeFromEvent('VERIFIED_TASK_COMPLETED', at)).toEqual({ at, passed: true })
    expect(gradedOutcomeFromEvent('JOB_TESTS_FAILED', at)).toEqual({ at, passed: false })
    expect(gradedOutcomeFromEvent('VERIFIED_TASK_FAILED', at)).toEqual({ at, passed: false })
    // Payment is not a graded verdict — JOB_COMPLETED must not sneak into
    // the denominator (it has no symmetric failure event).
    expect(gradedOutcomeFromEvent('JOB_COMPLETED', at)).toBeNull()
    expect(gradedOutcomeFromEvent('TASK_STARTED', at)).toBeNull()
  })
})
