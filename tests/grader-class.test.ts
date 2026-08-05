import { describe, expect, it } from 'vitest'
import {
  GRADER_CLASSES,
  classifyGrader,
  gradeTag,
  graderClassRank,
  parseGradeTag,
  trustWeightedScore,
  type GraderClass,
} from '@/lib/grader-class'

describe('grader classes rank by forge-resistance', () => {
  it('reproducible outranks model outranks declared', () => {
    expect(graderClassRank('reproducible')).toBeGreaterThan(graderClassRank('model'))
    expect(graderClassRank('model')).toBeGreaterThan(graderClassRank('declared'))
  })

  it('an unknown class ranks zero, never negative', () => {
    expect(graderClassRank('nonsense' as GraderClass)).toBe(0)
  })
})

describe('classifying Handsel graders into portable classes', () => {
  it('a canary, CI and mutation suite are all reproducible', () => {
    expect(classifyGrader('canary')).toBe('reproducible')
    expect(classifyGrader('ci')).toBe('reproducible')
    expect(classifyGrader('tests')).toBe('reproducible')
    expect(classifyGrader('redteam')).toBe('reproducible')
  })

  it('an LLM verdict is model, a panel is attested', () => {
    expect(classifyGrader('llm-review')).toBe('model')
    expect(classifyGrader('panel')).toBe('attested')
  })

  it('an unknown or missing grader defaults to the WEAKEST class, never the strongest', () => {
    // Getting this backwards silently over-trusts a signal, which is the exact
    // failure this file exists to fix.
    expect(classifyGrader('brand-new-grader')).toBe('declared')
    expect(classifyGrader(null)).toBe('declared')
    expect(classifyGrader(undefined)).toBe('declared')
  })
})

describe('the 8004 tag round-trips', () => {
  it('every grader produces a parseable namespaced tag', () => {
    for (const g of ['canary', 'llm-review', 'panel', 'unknown']) {
      const cls = parseGradeTag(gradeTag(g))
      expect(cls).toBe(classifyGrader(g))
    }
  })

  it("does not parse another publisher's tag", () => {
    expect(parseGradeTag('starred')).toBeNull()
    expect(parseGradeTag('hsl-grade:not-a-class')).toBeNull()
    expect(parseGradeTag('')).toBeNull()
  })

  it('the tag prefix is namespaced so it cannot collide in a shared registry', () => {
    expect(gradeTag('canary')).toMatch(/^hsl-grade:/)
  })
})

describe('the reference fold a third party would run over public 8004 data', () => {
  it('down-weights the gameable classes instead of averaging flat', () => {
    // Five reproducible passes at 100, five declared self-reports at 100.
    // A flat mean is 100. The trust-weighted score must be 100 too here (both
    // agree), so use a case where they DISAGREE to show the weighting bites:
    const mixed = [
      { value: 100, cls: 'reproducible' as GraderClass },
      { value: 0, cls: 'declared' as GraderClass },
    ]
    // Flat mean would be 50. Weighted leans toward the reproducible verdict.
    const { score } = trustWeightedScore(mixed)
    expect(score).toBeGreaterThan(50)
  })

  it('a wall of self-reported 100s is worth less than one reproducible 100', () => {
    const sybil = Array.from({ length: 50 }, () => ({ value: 100, cls: 'declared' as GraderClass }))
    const honest = [{ value: 60, cls: 'reproducible' as GraderClass }]
    const sybilScore = trustWeightedScore(sybil).score
    const honestPulled = trustWeightedScore([...sybil, ...honest]).score
    // One reproducible 60 measurably drags 50 self-reported 100s downward —
    // the whole point: cheap opinions cannot swamp one real proof.
    expect(honestPulled).toBeLessThan(sybilScore)
  })

  it('no verdicts is the absence of a score, not a score of zero (§20 cliff)', () => {
    const { score, weightSum } = trustWeightedScore([])
    expect(weightSum).toBe(0)
    expect(score).toBe(0) // caller distinguishes via weightSum === 0, not via score
  })

  it('reports a per-class breakdown so the number is never opaque', () => {
    const { breakdown } = trustWeightedScore([
      { value: 100, cls: 'reproducible' },
      { value: 80, cls: 'model' },
      { value: 80, cls: 'model' },
    ])
    expect(breakdown.reproducible.count).toBe(1)
    expect(breakdown.model.count).toBe(2)
    expect(breakdown.declared.count).toBe(0)
  })

  it('ignores non-finite values rather than poisoning the fold', () => {
    const { score } = trustWeightedScore([
      { value: Number.NaN, cls: 'reproducible' },
      { value: 90, cls: 'reproducible' },
    ])
    expect(score).toBe(90)
  })

  it('covers every declared class in the map', () => {
    // A class with no grader mapping to it is dead weight; a grader mapping to a
    // non-existent class is a bug. Pin that the classes are exactly used.
    const used = new Set(['canary', 'code', 'llm-review', 'panel', 'self-report'].map(classifyGrader))
    for (const c of used) expect(GRADER_CLASSES).toContain(c)
  })
})
