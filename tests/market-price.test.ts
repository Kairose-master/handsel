/**
 * Price discovery. The raise arithmetic decides how much escrow moves, so it
 * is pinned hard — especially the ceiling, which is the requester's real
 * reservation price and the only thing standing between "the price rises
 * until someone takes it" and "the price rises".
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEP_MINUTES,
  JOB_CLASSES,
  MAX_RAISES,
  MIN_TRADES_FOR_SIGNAL,
  jobClassOf,
  median,
  nextPriceRaise,
  priceHint,
  summarizePrices,
  validatePricingPlan,
} from '@/lib/market-price'
import { TESTS_JOB_TITLE_PREFIX } from '@/lib/test-suite-jobs'
import { REPO_JOB_TITLE_PREFIX } from '@/lib/repo-jobs'

describe('jobClassOf', () => {
  it('recognises every standardized job class by its real prefix', () => {
    // The prefixes are duplicated as literals inside market-price so that
    // module stays dependency-free; importing the real constants here is what
    // makes the duplication safe.
    expect(jobClassOf(`${TESTS_JOB_TITLE_PREFIX}slugify`)).toBe('tests')
    expect(jobClassOf(`${REPO_JOB_TITLE_PREFIX}acme/widget: fix pagination`)).toBe('repo')
  })

  it('no longer knows about translation, because nothing posts it', () => {
    // i18n and docs were house-posted translation work. They now fall through
    // to the deliverable kind like any other job, which is correct: a price
    // class nothing can produce collects one data point and then never another,
    // so "comparable to its class" would be comparing a job to itself.
    expect(jobClassOf('i18n → ko (12 keys)')).toBe('text')
    expect(jobClassOf('docs → Korean: translate docs/mcp-connector.md')).toBe('text')
  })

  it('falls back to the deliverable kind, which is the next-best comparability proxy', () => {
    expect(jobClassOf('Draw a mascot', 'image')).toBe('image')
    expect(jobClassOf('Narrate this', 'audio')).toBe('audio')
    expect(jobClassOf('Write a summary')).toBe('text')
    expect(jobClassOf(null, null)).toBe('text')
    expect(jobClassOf('x', 'something-unknown')).toBe('text')
  })

  it('every class it can return is a declared class', () => {
    for (const title of ['tests → c', 'repo → d', 'i18n → a', 'docs → b', 'plain']) {
      expect(JOB_CLASSES).toContain(jobClassOf(title))
    }
  })
})

describe('summarizePrices', () => {
  const t = (jobClass: any, bountyUsd: number) => ({ jobClass, bountyUsd })

  it('refuses to quote a rate from too few trades', () => {
    const [stat] = summarizePrices([t('i18n', 5), t('i18n', 7)])
    expect(stat.trades).toBe(2)
    expect(stat.medianUsd).toBeNull()
    expect(priceHint(stat)).toMatch(/not enough/)
  })

  it('quotes median and range once there are enough', () => {
    const [stat] = summarizePrices([t('i18n', 3), t('i18n', 5), t('i18n', 10)])
    expect(stat.trades).toBe(3)
    expect(stat.medianUsd).toBe(5)
    expect(stat.lowUsd).toBe(3)
    expect(stat.highUsd).toBe(10)
    expect(priceHint(stat)).toContain('$5.00')
  })

  it('separates classes and ranks by how much evidence each has', () => {
    const stats = summarizePrices([t('i18n', 5), t('repo', 20), t('i18n', 5), t('i18n', 5)])
    expect(stats[0].jobClass).toBe('i18n')
    expect(stats[0].trades).toBe(3)
    expect(stats[1].jobClass).toBe('repo')
    expect(stats[1].medianUsd).toBeNull()
  })

  it('ignores nonsense bounties instead of letting them move the median', () => {
    const [stat] = summarizePrices([t('i18n', 5), t('i18n', 0), t('i18n', -3), t('i18n', NaN), t('i18n', 5), t('i18n', 5)])
    expect(stat.trades).toBe(3)
    expect(stat.medianUsd).toBe(5)
  })

  it('says so plainly when a class has never traded', () => {
    expect(summarizePrices([])).toEqual([])
    expect(priceHint(undefined)).toMatch(/first price/)
  })

  it('MIN_TRADES_FOR_SIGNAL is the documented threshold', () => {
    expect(MIN_TRADES_FOR_SIGNAL).toBe(3)
  })
})

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([5])).toBe(5)
    expect(median([])).toBeNull()
  })
})

describe('nextPriceRaise — the ceiling is the promise', () => {
  const plan = { ceilingUsd: 20, stepUsd: 5, stepMinutes: 60 }

  it('raises by one step once the job has sat long enough', () => {
    const d = nextPriceRaise({ currentUsd: 10, ageMinutes: 60, plan })
    expect(d).toMatchObject({ shouldRaise: true, nextUsd: 15 })
  })

  it('NEVER exceeds the ceiling — it clamps to it', () => {
    const d = nextPriceRaise({ currentUsd: 18, ageMinutes: 999, plan })
    expect(d).toMatchObject({ shouldRaise: true, nextUsd: 20 })
  })

  it('stops at the ceiling instead of raising forever', () => {
    expect(nextPriceRaise({ currentUsd: 20, ageMinutes: 999, plan })).toMatchObject({ shouldRaise: false })
    expect(nextPriceRaise({ currentUsd: 25, ageMinutes: 999, plan }).shouldRaise).toBe(false)
  })

  it('waits out the interval', () => {
    const d = nextPriceRaise({ currentUsd: 10, ageMinutes: 59, plan })
    expect(d.shouldRaise).toBe(false)
    expect(d.reason).toContain('next raise at 60m')
  })

  it('leaves fixed-price jobs alone', () => {
    expect(nextPriceRaise({ currentUsd: 10, ageMinutes: 999, plan: null }).shouldRaise).toBe(false)
    expect(nextPriceRaise({ currentUsd: 10, ageMinutes: 999, plan: undefined }).shouldRaise).toBe(false)
  })

  it('caps the number of raises so a mispriced job cannot churn forever', () => {
    const d = nextPriceRaise({ currentUsd: 10, ageMinutes: 999, plan: { ...plan, raises: MAX_RAISES } })
    expect(d.shouldRaise).toBe(false)
    expect(d.reason).toContain('cap')
  })

  it('rejects a malformed plan rather than computing a price from NaN', () => {
    expect(nextPriceRaise({ currentUsd: 10, ageMinutes: 999, plan: { ceilingUsd: NaN, stepUsd: 5, stepMinutes: 60 } }).shouldRaise).toBe(false)
    expect(nextPriceRaise({ currentUsd: 10, ageMinutes: 999, plan: { ceilingUsd: 20, stepUsd: 0, stepMinutes: 60 } }).shouldRaise).toBe(false)
  })

  it('keeps prices at whole cents across repeated raises', () => {
    let current = 0.1
    for (let i = 0; i < 5; i++) {
      const d = nextPriceRaise({ currentUsd: current, ageMinutes: 60, plan: { ceilingUsd: 99, stepUsd: 0.2, stepMinutes: 60 } })
      if (!d.shouldRaise) break
      current = d.nextUsd
      expect(Math.round(current * 100)).toBeCloseTo(current * 100, 9)
    }
    expect(current).toBeCloseTo(1.1, 10)
  })
})

describe('validatePricingPlan', () => {
  it('treats no plan as an ordinary fixed-price job', () => {
    expect(validatePricingPlan(10, null)).toEqual({ ok: true, plan: null })
    expect(validatePricingPlan(10, {})).toEqual({ ok: true, plan: null })
  })

  it('refuses a ceiling at or below the starting price — that is not an auction', () => {
    expect(validatePricingPlan(10, { ceilingUsd: 10 })).toMatchObject({ ok: false })
    expect(validatePricingPlan(10, { ceilingUsd: 5 })).toMatchObject({ ok: false })
  })

  it('defaults the step and interval to something sane', () => {
    const res = validatePricingPlan(20, { ceilingUsd: 50 })
    expect(res).toMatchObject({ ok: true })
    if (res.ok && res.plan) {
      expect(res.plan.stepUsd).toBe(5) // 25% of the start
      expect(res.plan.stepMinutes).toBe(DEFAULT_STEP_MINUTES)
      expect(res.plan.raises).toBe(0)
    }
  })

  it('rejects a raise interval short enough to churn the chain', () => {
    expect(validatePricingPlan(10, { ceilingUsd: 20, stepMinutes: 1 })).toMatchObject({ ok: false })
  })
})
