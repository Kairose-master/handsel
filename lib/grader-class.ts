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
 * So: record HOW a verdict was reached alongside the number, in the `tag` the
 * registry already carries, rather than making a consumer reconstruct it from
 * who signed.
 *
 * **What this file is not.** An adversarial literature review refuted the two
 * claims the first version made, and both refutations are load-bearing enough
 * to sit at the top rather than in a footnote:
 *
 *  1. **This is not novel.** Typed evidence strength is old. RFC 1422 (1993)
 *     published certificate policy; RFC 1991 (1996) encoded a certification
 *     class byte on every PGP signature; FIRE (2004) typed reputation by
 *     source; W3C VC 2.0 carries `evidence`, and its Confidence Method draft
 *     adds `confidenceMethod` and `assuranceLevel`. The narrow thing that may
 *     still be open is an ERC-8004-specific profile whose claims are machine
 *     verifiable — not the idea of typing a verdict.
 *  2. **The classes are not a total order**, and treating them as one is a
 *     known failure mode rather than a design choice — see `GRADER_CLASSES`.
 *
 * Nothing here is a Sybil solution, and after the review it is also not a
 * ranking. It is a recorded, portable feature of a verdict — useful to a
 * verifier policy, and not a substitute for one.
 */

/**
 * How a verdict was reached.
 *
 * **These are FEATURES, NOT A TOTAL ORDER.** The first version of this file
 * claimed they were "ordered by how hard it is to manufacture" and that a
 * consumer could rank two verdicts by this alone. An adversarial review
 * refuted that, and the counterexamples are decisive:
 *
 *  - `attested` is a property of the ENVELOPE, not of the method. A signed
 *    self-report is `declared` and `attested` at once; so is a signed test run.
 *  - A locked model judge — fixed weights, prompt, seed, inputs — is `model`,
 *    `mechanical` and `reproducible` simultaneously. Replayability of an
 *    inference does not imply robustness of the judgement.
 *  - A PUBLIC reproducible test can be cheaper to defeat than a HIDDEN
 *    mechanical one, because it can be overfitted. Reproducibility buys
 *    consistency, not construct validity or coverage.
 *  - A licensed expert or a hardware-attested execution can cost more to forge
 *    than a weak public check.
 *
 * There is also a direct historical precedent for this failing. OpenPGP
 * encoded exactly this kind of scale — RFC 1991's signature classification byte
 * (generic / persona / casual / positive, 1996) — and a current IETF draft
 * deprecates `casual` because the semantic distinctions proved ill-defined and
 * issuer-relative. RFC 2440 had already warned that one issuer's "casual" may
 * be more rigorous than another's "positive".
 *
 * So the ordinal below is kept only as a **coarse prior for display and
 * triage**, never as a weight a settlement decision rests on. The defensible
 * shape is a multi-dimensional assurance profile (see `AssuranceProfile`).
 *
 * Prior art, because this idea is not new and claiming it would be false:
 * RFC 1422 (1993, certificate policy), RFC 1991 (1996, certification class),
 * FIRE (Huynh/Jennings/Shadbolt 2004, typed reputation sources), W3C VC 2.0
 * `evidence` + the Confidence Method draft (`confidenceMethod`,
 * `assuranceLevel`), NIST SP 800-63A evidence grading, SLSA build levels.
 */
export const GRADER_CLASSES = [
  'reproducible', // a third party can re-run the check and get the same verdict: canary, CI, mutation suite, hash
  'mechanical', //   deterministic but not independently re-runnable without our inputs (platform pytest on hidden tests)
  'model', //        a model's judgement against criteria: LLM review, vision, transcription
  'attested', //     a human or external party asserted it, with a signature but no reproduction
  'declared', //     unverified self-report — the weakest, and the one 8004 feedback defaults to
] as const

export type GraderClass = (typeof GRADER_CLASSES)[number]

/**
 * A coarse display/triage prior. **Not a forge-resistance measurement, and not
 * safe as a settlement weight** — see the counterexamples above.
 *
 * It survives because sorting a list for a human is a weaker claim than
 * deciding money, and for that purpose "declared last" is still better than
 * alphabetical. Anything that spends on the strength of this number is wrong.
 */
export function graderClassPrior(cls: GraderClass): number {
  const i = GRADER_CLASSES.indexOf(cls)
  return i < 0 ? 0 : GRADER_CLASSES.length - i
}

/**
 * The shape that IS defensible: assurance as several independent axes, with a
 * verifier policy deciding eligibility per claim and threat model, rather than
 * one scalar pretending to summarise them.
 *
 * Nothing computes this yet. It is here as the named replacement for the
 * refuted ordinal so the next implementation has a target that is not the
 * mistake — and it deliberately separates the axes the five labels conflated.
 */
export type AssuranceProfile = {
  /** How the verdict was decided — the label above, as a feature. */
  method: GraderClass
  /** Can an independent party re-run it? `public` / `authorized` / `none`. */
  replayability: 'public' | 'authorized' | 'none'
  /** Are inputs, runner and output cryptographically bound? */
  evidenceBound: boolean
  /** Measured error/coverage for this method on this task class, if known.
   *  `null` means unmeasured — which is NOT the same as good. */
  measuredErrorRate: number | null
  /** What it costs to stand up a principal that can issue this verdict.
   *  The Sybil axis, absent from the five labels entirely. */
  principalCost: 'none' | 'stake' | 'licensed' | 'hardware'
  /** Correlation cluster: verdicts sharing an id must not be counted as
   *  independent observations. */
  independenceGroup: string | null
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
 * A linear, class-weighted fold. **Read the limits before using it.**
 *
 * An earlier version of this comment claimed a flat average "inherits its
 * weakest input" and that this fold fixes it. Both halves were wrong:
 *
 *  - An aggregator does not inherit its weakest observation. It inherits its
 *    **threat model and breakdown point** — it may reject, cap, cluster, trim,
 *    or zero an input. Median and trimmed-mean estimators have provable rates
 *    under an explicit bound on the adversarial fraction (Yin et al. 2018);
 *    Huber (1964) is the origin of the contamination framing.
 *  - Re-weighting a linear combination is **not** a Byzantine defence.
 *    Blanchard et al. (2017) show no linear-combination aggregator tolerates
 *    even a single Byzantine contributor in the high-dimensional setting. That
 *    result is about gradients rather than scalar ratings, but it disposes of
 *    "pick better weights" as a general answer. Adaptive attacks have since
 *    broken coordinate-wise median and Krum too (Xie et al. 2019).
 *  - Fixed class weights are the weak version of learned source reliability.
 *    Dawid–Skene (1979) estimates each observer's confusion matrix jointly with
 *    the latent truth; GLAD (Whitehill et al. 2009) adds item difficulty. Both
 *    need task overlap or gold anchors, which a permissionless feed may lack —
 *    without them, reliability and truth are jointly unidentifiable.
 *  - None of it survives Sybil majority. Douceur (2002): without a trusted
 *    identity authority or a resource assumption, an adversary can mint the
 *    identities. `independenceGroup` above is where that would be handled, and
 *    this function does not handle it.
 *
 * So this is a **transparent, recomputable baseline** — same inputs, same
 * output, no database — and explicitly not a robust estimator. Its breakdown
 * point is zero: one attacker who can mint `declared` verdicts freely moves it.
 * Use it to show a number's derivation, not to decide a payout.
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
    const w = graderClassPrior(v.cls)
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
