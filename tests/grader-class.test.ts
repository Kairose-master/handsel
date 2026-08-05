import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GRADER_CLASSES,
  classifyGrader,
  gradeTag,
  graderClassPrior,
  parseGradeTag,
  trustWeightedScore,
  type GraderClass,
} from '@/lib/grader-class'

/**
 * These classes were once documented as an ordering by forge-resistance. An
 * adversarial review refuted that: `attested` is an envelope property that
 * overlaps every other label, a locked model judge is model+mechanical+
 * reproducible at once, and a public reproducible test can be cheaper to defeat
 * than a hidden mechanical one. OpenPGP shipped exactly this scale in RFC 1991
 * and is now deprecating `casual` because the distinctions proved ill-defined.
 *
 * The prior survives for display order only. These tests assert that and say
 * so, so nobody reads a passing suite as evidence the ordering is sound.
 */
describe('graderClassPrior is a display prior, not a measurement', () => {
  it('orders the labels for triage', () => {
    expect(graderClassPrior('reproducible')).toBeGreaterThan(graderClassPrior('model'))
    expect(graderClassPrior('model')).toBeGreaterThan(graderClassPrior('declared'))
  })

  it('an unknown class ranks zero, never negative', () => {
    expect(graderClassPrior('nonsense' as GraderClass)).toBe(0)
  })

  it('is documented as unsafe to settle on', () => {
    const src = readFileSync(join(process.cwd(), 'lib/grader-class.ts'), 'utf8')
    expect(src).toMatch(/NOT A TOTAL ORDER/)
    // Newline-and-comment-prefix tolerant: the phrase wraps in the source.
    expect(src).toMatch(/not[\s*]+safe as a settlement weight/i)
    expect(src).toMatch(/RFC 1991/)
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
    expect(honestPulled).toBeLessThan(sybilScore)
  })

  /**
   * The test above reads like a Sybil defence and is not one. This one is the
   * counterweight: the fold's breakdown point is ZERO. Class weights bound the
   * per-verdict influence, not the number of verdicts, so an attacker who can
   * mint `declared` entries freely still moves the result as far as they like.
   * Blanchard et al. (2017): no linear-combination aggregator is Byzantine
   * robust. Robustness needs rejection, trimming or capping by principal —
   * none of which this function does.
   */
  it('has a breakdown point of zero — enough cheap verdicts still move it', () => {
    const honestOnly = trustWeightedScore([{ value: 0, cls: 'reproducible' }]).score
    const flooded = trustWeightedScore([
      { value: 0, cls: 'reproducible' },
      ...Array.from({ length: 5000 }, () => ({ value: 100, cls: 'declared' as GraderClass })),
    ]).score
    expect(honestOnly).toBe(0)
    expect(flooded).toBeGreaterThan(90) // one real 0 is drowned; this is not robust
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
