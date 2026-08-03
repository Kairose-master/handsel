/**
 * The comparability class of a stored score.
 *
 * Two scores are comparable only if the same inputs would have produced the
 * same number. Change a weight, a decay, a dampening anchor, and yesterday's
 * 673 and today's 394 are not a decline — they are answers to different
 * questions, printed in the same column.
 *
 * This is not hypothetical. `docs/failure-modes.md` §20 records the week the
 * engine gained a zero anchor and started counting deliveries instead of
 * attempts, which moved a one-job agent from **673 to 394**. §20's fix was a
 * backfill endpoint, and a backfill is necessary and not sufficient: it makes
 * old rows current, and in doing so it destroys the record of what was
 * believed at decision time. A loan priced at 673 was priced at 673. Rewriting
 * that row to 394 does not correct history, it deletes it.
 *
 * The general rule is not ours — it came out of the ERC-8183 thread
 * (`docs/competitive-landscape.md`), and it is sharper than the version we had:
 *
 * > Any aggregate that can be consumed by a higher-order fold must itself
 * > remain a first-class, class-carrying, independently recomputable object.
 * > Entries decided under different pinned policy versions belong to different
 * > comparability classes and must not be folded into one score silently.
 *
 * A credit score is a fold. It carried no class until this file.
 *
 * **Derived, not declared.** The obvious implementation is a hand-maintained
 * `const VERSION = 3`, and the obvious failure is someone tuning a weight and
 * not bumping it — a version that can be forgotten is a version that lies, and
 * this repo has a name for that shape (`a check that cannot fail is not a
 * check`). So the identifier is a hash of the tunables themselves: change any
 * number that moves an output and the class changes, whether or not anyone
 * remembered to.
 *
 * It errs toward *false* class changes — reordering a table or renaming a
 * grader produces a new version without changing any score. That direction is
 * deliberate. A spurious new class costs a comparison you could have made; a
 * missed one silently compares two different engines, which is the failure
 * being defended against.
 */
import { createHash } from 'node:crypto'
import {
  COLLATERAL_MULTIPLE,
  CREDIBILITY_FLOOR,
  DEFAULT_RATING_RULES,
  DEFAULT_RISK_RULES,
  EXPOSURE_MAX_NEGATIVE,
  EXPOSURE_MAX_POSITIVE,
  EXPOSURE_MIN_NEGATIVE,
  EXPOSURE_MIN_POSITIVE,
  EXPOSURE_REFERENCE_USD,
  EXPOSURE_SLOPE,
  GRADER_WEIGHTS,
  INDEPENDENCE_MIN_PARTNERS,
  NEGATIVE_HALF_LIFE_DAYS,
  REPUTATION_HALF_LIFE_DAYS,
} from './scoring'

/**
 * A human label for the era, carried alongside the hash.
 *
 * The hash answers *"is this the same engine?"*. It cannot answer *"which
 * engine was that?"* in a way anyone can read six months later, and a
 * changelog nobody can join to a row is not a changelog. Bump this when the
 * change is worth a name; the hash moves on its own regardless.
 */
export const SCORING_EPOCH = '2026-08-dampen-anchored'

/**
 * Every tunable that can move an output. Values only — this is hashed, not
 * displayed, so the shape matters and the key names are documentation.
 *
 * Adding a tunable here that does NOT affect output is harmless. Leaving one
 * out that does is the bug this file exists to prevent, and it is the reason
 * `tests/scoring-version.test.ts` reads the constants back out of
 * `scoring.ts` and fails when one is missing.
 */
export function scoringTunables(): Record<string, unknown> {
  return {
    epoch: SCORING_EPOCH,
    graderWeights: GRADER_WEIGHTS,
    ratingRules: DEFAULT_RATING_RULES,
    riskRules: DEFAULT_RISK_RULES,
    independenceMinPartners: INDEPENDENCE_MIN_PARTNERS,
    credibilityFloor: CREDIBILITY_FLOOR,
    exposureReferenceUsd: EXPOSURE_REFERENCE_USD,
    exposureSlope: EXPOSURE_SLOPE,
    exposureMinPositive: EXPOSURE_MIN_POSITIVE,
    exposureMaxPositive: EXPOSURE_MAX_POSITIVE,
    exposureMinNegative: EXPOSURE_MIN_NEGATIVE,
    exposureMaxNegative: EXPOSURE_MAX_NEGATIVE,
    reputationHalfLifeDays: REPUTATION_HALF_LIFE_DAYS,
    negativeHalfLifeDays: NEGATIVE_HALF_LIFE_DAYS,
    collateralMultiple: COLLATERAL_MULTIPLE,
  }
}

/**
 * `epoch@hash8` — e.g. `2026-08-dampen-anchored@1f3a9c02`.
 *
 * Short enough for a column and a UI badge, long enough that two engines
 * colliding is not a thing that happens. Stable across processes: it is a hash
 * of values, not of source text or build time.
 */
export function scoringEngineVersion(): string {
  const canonical = JSON.stringify(scoringTunables())
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `${SCORING_EPOCH}@${hash}`
}

/**
 * Whether two stored scores may be compared, ranked, averaged or shown as a
 * trend.
 *
 * An **unknown** version — a row written before this file existed — is not
 * comparable to anything, including another unknown. That is the timing/validity
 * distinction the same thread named: a missing version is a fact about when the
 * row was written, never evidence that the engine was the same one. Reading it
 * as "probably fine" is exactly the collapse.
 */
export function sameComparabilityClass(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a === b
}

/** Rows this engine wrote. Anything else needs a rescore before it can be
 *  ranked against them — `POST /api/admin/rescore`. */
export function isCurrentEngine(version: string | null | undefined): boolean {
  return sameComparabilityClass(version, scoringEngineVersion())
}
