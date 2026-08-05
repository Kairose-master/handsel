/**
 * The field ERC-8004 left out.
 *
 * ERC-8004's Validation Registry stores a verdict as one number, 0–100. The
 * spec says so in as many words: a mechanically-proven result (a re-executed
 * test, a zkML proof, a TEE oracle) and a subjective judgement are
 * "structurally equivalent on-chain — distinction emerges through validator
 * reputation, not protocol-level flags." An empirical study of the deployed
 * ecosystem then found reputation gaming and Sybil to be its critical
 * vulnerabilities (arXiv 2606.26028).
 *
 * Those two facts are one fact. If a canary-proven pass and an LLM's opinion
 * are the same 100 on-chain, then a consumer folding those 100s cannot down-
 * weight the gameable ones, and the only defence left — "trust the validator" —
 * is exactly the Sybil-exposed part.
 *
 * Handsel already grades with this distinction: `settleLaborMarketJob` records
 * a `grader` per verdict, and the scoring engine weights an LLM review below a
 * mutation-graded suite. This file makes that distinction a first-class,
 * portable property of a verdict — the thing to put in the `tag` an 8004
 * validation carries, so the classifier travels WITH the number instead of
 * being reconstructed from who signed it.
 *
 * Nothing here is a Sybil solution. It is the missing coordinate that lets a
 * downstream fold apply one — which is strictly more than the standard offers,
 * and honestly less than a solution.
 */

/** How a verdict was reached, ordered by how hard it is to manufacture. The
 *  order is the point: a consumer that knows nothing else can still rank two
 *  verdicts by this alone. */
export const GRADER_CLASSES = [
  'reproducible', // a third party can re-run the check and get the same verdict: canary, CI, mutation suite, hash
  'mechanical', //   deterministic but not independently re-runnable without our inputs (platform pytest on hidden tests)
  'model', //        a model's judgement against criteria: LLM review, vision, transcription
  'attested', //     a human or external party asserted it, with a signature but no reproduction
  'declared', //     unverified self-report — the weakest, and the one 8004 feedback defaults to
] as const

export type GraderClass = (typeof GRADER_CLASSES)[number]

/**
 * The forge-resistance rank, high = harder to fake. This is a property of the
 * METHOD, not of the verdict's value — a `reproducible` fail and a
 * `reproducible` pass are equally trustworthy as facts, which is the whole
 * point of "a check that cannot fail is not a check".
 */
export function graderClassRank(cls: GraderClass): number {
  const i = GRADER_CLASSES.indexOf(cls)
  return i < 0 ? 0 : GRADER_CLASSES.length - i
}

/** Map Handsel's internal grader names (the `grader` field written by
 *  `settleLaborMarketJob`) onto the portable class. Kept explicit rather than
 *  clever: a new grader kind must be classified by hand, because getting this
 *  wrong silently over-trusts a signal, which is the exact failure being fixed. */
const GRADER_TO_CLASS: Record<string, GraderClass> = {
  canary: 'reproducible',
  ci: 'reproducible',
  tests: 'reproducible', // mutation-graded test suite: platform re-runs against hidden impls
  redteam: 'reproducible',
  code: 'mechanical', // platform pytest — deterministic, but needs our test file to reproduce
  'llm-review': 'model',
  vision: 'model',
  audio: 'model',
  panel: 'attested', // judgment panel: independent agents, but opinion, not reproduction
  manual: 'attested', // a requester clicked approve
  'self-report': 'declared',
}

export function classifyGrader(grader: string | null | undefined): GraderClass {
  return GRADER_TO_CLASS[String(grader ?? '')] ?? 'declared'
}

/**
 * The 8004 validation `tag` a verdict should carry.
 *
 * Deliberately a compact, parseable string rather than free text: a consumer
 * reads it off-chain and must be able to recover the class without guessing.
 * `hsl-grade:<class>` — namespaced so it does not collide with another
 * publisher's tags in the same registry.
 */
export const GRADE_TAG_PREFIX = 'hsl-grade:'

export function gradeTag(grader: string | null | undefined): string {
  return `${GRADE_TAG_PREFIX}${classifyGrader(grader)}`
}

export function parseGradeTag(tag: string | null | undefined): GraderClass | null {
  const t = String(tag ?? '')
  if (!t.startsWith(GRADE_TAG_PREFIX)) return null
  const cls = t.slice(GRADE_TAG_PREFIX.length) as GraderClass
  return (GRADER_CLASSES as readonly string[]).includes(cls) ? cls : null
}

/**
 * Fold a set of class-tagged verdicts into a single trust-weighted score,
 * the way a downstream consumer of an 8004 registry SHOULD — down-weighting
 * the gameable classes instead of averaging them flat.
 *
 * This is not Handsel's internal credit engine; it is the reference fold a
 * *third party* could run over public 8004 data to get a defensible number
 * without trusting any single validator. Pure, so that recomputation is the
 * point: same inputs, same output, no database.
 */
export function trustWeightedScore(verdicts: Array<{ value: number; cls: GraderClass }>): {
  score: number
  weightSum: number
  breakdown: Record<GraderClass, { count: number; weight: number }>
} {
  const breakdown = Object.fromEntries(
    GRADER_CLASSES.map((c) => [c, { count: 0, weight: 0 }]),
  ) as Record<GraderClass, { count: number; weight: number }>

  let weighted = 0
  let weightSum = 0
  for (const v of verdicts) {
    if (!Number.isFinite(v.value)) continue
    const w = graderClassRank(v.cls)
    weighted += clamp01to100(v.value) * w
    weightSum += w
    breakdown[v.cls].count += 1
    breakdown[v.cls].weight += w
  }
  // No verdicts, or only zero-weight ones, is not a score of zero — it is the
  // absence of one. A cold start, not a bad record. §20's cliff, avoided.
  const score = weightSum > 0 ? Math.round(weighted / weightSum) : 0
  return { score, weightSum, breakdown }
}

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, n))
}
