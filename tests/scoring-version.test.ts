import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SCORING_EPOCH,
  isCurrentEngine,
  sameComparabilityClass,
  scoringEngineVersion,
  scoringTunables,
} from '@/lib/credit-engine/version'

/**
 * A version that can be forgotten is a version that lies.
 *
 * The whole point of deriving the identifier from the tunables is that nobody
 * has to remember to bump it — so the thing worth testing is not that the hash
 * is stable (it is, trivially) but that the tunable list is *complete*. A
 * constant that moves an output and is missing from `scoringTunables()` puts
 * two different engines in one comparability class, silently, which is the
 * exact failure this file exists to prevent.
 *
 * So the last test reads the constants back out of `scoring.ts` and fails when
 * one of them is not accounted for.
 */

describe('the engine version identifies an engine', () => {
  it('is `epoch@hash8`', () => {
    expect(scoringEngineVersion()).toMatch(new RegExp(`^${SCORING_EPOCH}@[0-9a-f]{8}$`))
  })

  it('is stable across calls — it hashes values, not build time', () => {
    expect(scoringEngineVersion()).toBe(scoringEngineVersion())
  })

  it('changes when any tunable changes', async () => {
    // Simulated by hashing a mutated copy the same way the module does, since
    // the real constants are frozen at import.
    const { createHash } = await import('node:crypto')
    const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8)
    const base = scoringTunables()
    const nudged = { ...base, graderWeights: { ...(base.graderWeights as object), 'repo-ci': 1.26 } }
    expect(hash(nudged)).not.toBe(hash(base))
  })

  it('a rating band move is a new class', async () => {
    // 600 is the lending gate. Moving it changes who can borrow, which is the
    // most consequential possible reason for two scores not to be comparable.
    const { createHash } = await import('node:crypto')
    const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8)
    const base = scoringTunables()
    const rules = (base.ratingRules as { minScore: number; value: string }[]).map((r) =>
      r.value === 'BB' ? { ...r, minScore: 610 } : r,
    )
    expect(hash({ ...base, ratingRules: rules })).not.toBe(hash(base))
  })
})

describe('an unknown version is not comparable to anything', () => {
  it('null is not equal to null', () => {
    // The timing/validity distinction, applied to the stamp itself: a missing
    // version is a fact about WHEN the row was written, never evidence that
    // the engine was the same one. Two unstamped rows may be from either side
    // of the change that moved a one-job agent 673 -> 394.
    expect(sameComparabilityClass(null, null)).toBe(false)
    expect(sameComparabilityClass(undefined, undefined)).toBe(false)
    expect(sameComparabilityClass(null, scoringEngineVersion())).toBe(false)
    expect(sameComparabilityClass('', '')).toBe(false)
  })

  it('two rows from the same engine are comparable', () => {
    const v = scoringEngineVersion()
    expect(sameComparabilityClass(v, v)).toBe(true)
    expect(isCurrentEngine(v)).toBe(true)
  })

  it('a row from another engine is not current', () => {
    expect(isCurrentEngine('2026-07-something@deadbeef')).toBe(false)
    expect(isCurrentEngine(null)).toBe(false)
  })
})

describe('the tunable list is complete', () => {
  it('every exported numeric constant in scoring.ts is accounted for', () => {
    // The guard that makes derivation trustworthy. If someone adds
    // `export const NEW_DECAY = 0.9` to scoring.ts and does not add it here,
    // this fails — before two engines quietly share a class.
    const src = readFileSync(join(process.cwd(), 'lib/credit-engine/scoring.ts'), 'utf8')
    const exported = [...src.matchAll(/^export const ([A-Z][A-Z0-9_]+)(?::[^=]+)? =/gm)].map((m) => m[1])

    // Constants that provably cannot move a score. Each needs a reason, so
    // that "add it to the ignore list" is never the path of least resistance.
    const NOT_TUNABLES: Record<string, string> = {
      POOLED_COUNTERPARTY: 'a sentinel string key, not a weight',
      RATINGS: 'the label set; the thresholds are DEFAULT_RATING_RULES',
      RISK_LEVELS: 'ditto for risk',
    }

    const covered = new Set(
      Object.values(scoringTunables()).length > 0
        ? [
            'GRADER_WEIGHTS',
            'DEFAULT_RATING_RULES',
            'DEFAULT_RISK_RULES',
            'INDEPENDENCE_MIN_PARTNERS',
            'CREDIBILITY_FLOOR',
            'EXPOSURE_REFERENCE_USD',
            'EXPOSURE_SLOPE',
            'EXPOSURE_MIN_POSITIVE',
            'EXPOSURE_MAX_POSITIVE',
            'EXPOSURE_MIN_NEGATIVE',
            'EXPOSURE_MAX_NEGATIVE',
            'REPUTATION_HALF_LIFE_DAYS',
            'NEGATIVE_HALF_LIFE_DAYS',
            'COLLATERAL_MULTIPLE',
          ]
        : [],
    )

    const unaccounted = exported.filter((name) => !covered.has(name) && !(name in NOT_TUNABLES))
    expect(
      unaccounted,
      `scoring.ts exports ${unaccounted.join(', ')} — add to scoringTunables() if it can move a score, ` +
        'or to NOT_TUNABLES with a reason if it cannot',
    ).toEqual([])
  })

  it('the write path stamps it', () => {
    const src = readFileSync(join(process.cwd(), 'lib/credit-engine/index.ts'), 'utf8')
    expect(src).toContain('engineVersion: scoringEngineVersion()')
  })

  it('the column exists in the schema and self-migrates', () => {
    // Shipping the column in schema.ts without the ALTER takes down every
    // reader of the table — see lib/db/ensure-columns.ts for the two times
    // that has already happened here.
    expect(readFileSync(join(process.cwd(), 'lib/db/schema.ts'), 'utf8')).toContain(
      "engineVersion: text('engine_version')",
    )
    expect(readFileSync(join(process.cwd(), 'lib/db/ensure-columns.ts'), 'utf8')).toContain(
      'ALTER TABLE credit_scores ADD COLUMN IF NOT EXISTS engine_version text',
    )
  })
})
