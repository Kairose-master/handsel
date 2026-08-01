/**
 * Credit Scoring Engine — pure calculation layer.
 *
 * Converts an agent's behavioral event history into economic trust.
 * No I/O happens here; persistence lives in lib/credit-engine/index.ts
 * and API routes only orchestrate. This module is the single source of
 * truth for the financial logic.
 *
 * Formula (weights fixed by product spec):
 *   Performance  40%  — task success rate, output quality, completed volume
 *   Reliability  30%  — quality consistency, recent failure frequency, SLA compliance
 *   Reputation   20%  — verified achievements, accumulated successful interactions
 *   Risk         10%  — failures, abnormal behavior, small-sample uncertainty
 *
 * Each factor is scored 0–100, dampened toward NO_EVIDENCE_FACTOR (0) while
 * the sample is small, then combined into a composite that maps onto a
 * 300–990 credit score. Two properties that anchor is load-bearing for, both
 * documented at the constant: an agent the engine knows nothing about scores
 * at the floor rather than at a passing grade, and the sample size that buys
 * certainty counts DELIVERIES, not attempts — see `evidence` in assessCredit.
 */

export type AgentEventInput = {
  eventType: string
  success: boolean
  executionTime: number // seconds
  tokenCost: number
  qualityScore: number | null // 0–1
  createdAt: Date
  /** Who was on the other side of this graded fact (requester agent id).
   *  Null for legacy events and non-market events. Drives the collusion
   *  discount: repeat counterparties earn diminishing reputation. */
  counterparty?: string | null
  /** Which grader produced this verdict ('repo-ci' | 'code' | 'tests' |
   *  'vision' | 'audio' | 'llm-review'). Null = legacy/unknown. Drives the
   *  grader-strength weight: verdicts a colluding pair can author their own
   *  criteria for count less than verdicts they cannot reach. */
  grader?: string | null
  /** The counterparty's own credit score AT THE TIME of the event (stamped
   *  by the writer, so history can't be rewritten by later score changes).
   *  Null = legacy/unknown. Drives credibility weighting: reputation earned
   *  from an established counterparty counts more than reputation earned
   *  from a freshly minted score-300 account. */
  counterpartyScore?: number | null
  /** Capital at stake on this graded fact, in USD — the job's bounty. Null
   *  for events that never carried one (legacy rows, grading verdicts written
   *  on the callback path where the bounty isn't in scope). Null keeps FULL
   *  weight, the same no-retroactive-penalty convention the fields above use.
   *  Drives the exposure weight: delivering a $200 contract and fixing a $1
   *  typo are not the same evidence about an agent. */
  exposureUsd?: number | null
  /** How many DISTINCT agents other than me this counterparty has also
   *  settled work with. The graph property the score-based credibility
   *  weight cannot see: an accomplice minted to hire me and nobody else has
   *  0 here no matter what its score says. Null = not computed (legacy call
   *  sites, tests); null keeps full weight, same convention as above. */
  counterpartyOtherPartners?: number | null
}

export type CreditAssessment = {
  score: number // 300–990
  rating: Rating
  creditLimit: number // USD
  riskLevel: RiskLevel
  breakdown: {
    performance: number
    reliability: number
    reputation: number
    risk: number
    composite: number
    completedTasks: number
    failedTasks: number
    successRate: number // 0–1
    avgQuality: number // 0–1
  }
}

export type Rating = 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'C' | 'D'
export type RiskLevel = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH'

/** Tasks slower than this breach the SLA used for reliability scoring. */
const SLA_SECONDS = 120
/** Recent window (task count) used for failure-frequency scoring. */
const RECENT_WINDOW = 20
/** Sample size at which factor scores carry ~2/3 of their raw weight. */
const CONFIDENCE_K = 5

/**
 * What a factor is worth when nothing is known about it.
 *
 * **This used to be 50, and 50 was a passing grade.** `dampen` shrinks each
 * factor toward this value while the sample is small, so it is the score the
 * engine assigns to pure ignorance — and a composite of 50 maps to
 * `300 + 50 × 6.9 = 645`, which is BB, above the 600 lending gate in
 * `lib/reputation-lending.ts`, and worth a five-figure `creditLimitForScore`.
 * Measured on the shipped defaults before this changed: **one completed job
 * scored 673 with a $5,250 limit**, ten jobs was AA, fifty was AAA.
 *
 * That is not a small-sample artifact, it is the prior being wrong. "I have no
 * evidence about this agent" and "this agent is average" are different claims,
 * and only the second one is worth lending against. The whole product claim is
 * a score *earned from real behaviour*; a number that starts most of the way up
 * and is nudged by evidence is not that.
 *
 * Zero is not merely stricter, it is the value that makes the curve
 * **continuous**. `assessCredit` already hard-returns 300 for an agent with no
 * terminal tasks; with a neutral anchor that branch was a cliff bolted onto a
 * function that would otherwise have said 645. Anchored at zero, the branch is
 * the limit of the formula rather than an exception to it: no evidence → every
 * factor → 0 → composite 0 → score 300, which is the documented floor.
 *
 * Note this dampens the *factors*, not the raw signals. Genuinely neutral
 * inputs stay neutral where that is the honest reading — `paymentHistory` is
 * still 50 for an agent that has never borrowed, because "never borrowed" is
 * not "defaulted".
 */
const NO_EVIDENCE_FACTOR = 0

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))

/** Shrink a raw 0–100 factor toward NO_EVIDENCE_FACTOR while the sample is
 *  small. An agent must EARN certainty, and until it has, the engine says so
 *  in the direction that costs the lender nothing. */
function dampen(raw: number, sampleSize: number): number {
  const confidence = sampleSize / (sampleSize + CONFIDENCE_K)
  return NO_EVIDENCE_FACTOR + (raw - NO_EVIDENCE_FACTOR) * confidence
}

export function assessCredit(
  events: AgentEventInput[],
  rules?: { rating?: ScoreRule<Rating>[]; risk?: ScoreRule<RiskLevel>[] },
  now: Date = new Date(),
): CreditAssessment {
  // Terminal task events are the unit of behavioral history. Two grades of
  // signal: self-evaluated (TASK_*, the runtime grading its own output) and
  // ground-truth verified (VERIFIED_TASK_*, graded server-side against a
  // hidden answer and settled by escrow). Verified events are facts; the
  // self-evaluated ones are opinions and carry less reputational weight.
  const TERMINAL_SUCCESS = new Set(['TASK_COMPLETED', 'VERIFIED_TASK_COMPLETED'])
  const TERMINAL = new Set([...TERMINAL_SUCCESS, 'TASK_FAILED', 'VERIFIED_TASK_FAILED'])
  const isSuccess = (t: AgentEventInput) => TERMINAL_SUCCESS.has(t.eventType) && t.success

  const tasks = events
    .filter((e) => TERMINAL.has(e.eventType))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const completed = tasks.filter(isSuccess)
  const failed = tasks.filter((t) => !isSuccess(t))
  const n = tasks.length

  /**
   * Sample size for `dampen` — **deliveries, not attempts.**
   *
   * This was `n` (every terminal task, success or failure) and that is a
   * perverse incentive under any anchor below the midpoint. Dampening trades
   * certainty for sample size, so counting failures lets an agent BUY
   * confidence with them: measured on this file's own test fixture, five
   * successes plus five failures scored 649 while the same five successes
   * alone scored 640. Padding a record with cheap failures raised the score.
   *
   * The effect existed before `NO_EVIDENCE_FACTOR` — with a neutral anchor it
   * appeared whenever the raw factor sat above 50 — and anchoring at zero made
   * it systematic, because every factor is then approached from below and any
   * extra evidence pushes it up unless raw falls far enough to compensate.
   *
   * Failures still count, in the place they belong: they drag `successRate`,
   * `failureFrequency` and `risk` DOWN through the raw inputs. What they must
   * not do is also certify that we know the agent well. Certainty is bought
   * with delivery — the thing that is expensive to fake — and failing is free.
   *
   * Note the direction of the residual error: an agent with many failures and
   * few successes now keeps LOW confidence, so its factors stay near zero and
   * it scores near the floor. When this is wrong it is wrong conservatively.
   */
  const evidence = completed.length

  // Cold start: no behavioral history means no credit. Dampening pulls
  // factors toward neutral, but an agent with zero recorded tasks must
  // start at the floor and earn its way up.
  if (n === 0) {
    return {
      score: 300,
      rating: 'D',
      creditLimit: 0,
      riskLevel: 'HIGH',
      breakdown: {
        performance: 0,
        reliability: 0,
        reputation: 0,
        risk: 0,
        composite: 0,
        completedTasks: 0,
        failedTasks: 0,
        successRate: 0,
        avgQuality: 0,
      },
    }
  }

  const successRate = n > 0 ? completed.length / n : 0
  const qualities = completed
    .map((t) => t.qualityScore)
    .filter((q): q is number => q !== null)
  const avgQuality = qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0

  // ── Performance (40%) ────────────────────────────────────────────
  // Volume is log-scaled: the 10th task proves more than the 1000th.
  const volumeScore = clamp(Math.log10(completed.length + 1) * 50)
  const performance = dampen(
    clamp(0.5 * successRate * 100 + 0.35 * avgQuality * 100 + 0.15 * volumeScore),
    evidence,
  )

  // ── Reliability (30%) ────────────────────────────────────────────
  // Consistency: low variance in output quality signals a stable agent.
  const meanQ = avgQuality
  const variance =
    qualities.length > 1
      ? qualities.reduce((a, q) => a + (q - meanQ) ** 2, 0) / qualities.length
      : 0
  const consistency = clamp(100 - Math.sqrt(variance) * 250)

  // Failure frequency over the recent window (recency matters for trust).
  const recent = tasks.slice(-RECENT_WINDOW)
  const recentFailures = recent.filter((t) => !isSuccess(t)).length
  const failureFrequency = recent.length > 0 ? clamp(100 * (1 - recentFailures / recent.length)) : 0

  // SLA compliance: share of tasks finishing within the SLA budget.
  const slaCompliance =
    n > 0 ? clamp((tasks.filter((t) => t.executionTime <= SLA_SECONDS).length / n) * 100) : 0

  // Payment history: on-time repayments vs defaults. Neutral (50) until
  // the agent has actually borrowed and repaid at least once.
  const repaymentEvents = events.filter(
    (e) => e.eventType === 'REPAYMENT_COMPLETED' || e.eventType === 'REPAYMENT_DEFAULTED',
  ).length
  const repaymentsCount = events.filter((e) => e.eventType === 'REPAYMENT_COMPLETED').length
  const paymentHistory =
    repaymentEvents > 0 ? clamp((repaymentsCount / repaymentEvents) * 100) : 50

  // Repayments COMPLETED, not repayment events: a default is negative
  // evidence and must not certify that we know the borrower well.
  const reliability = dampen(
    clamp(0.3 * consistency + 0.3 * failureFrequency + 0.2 * slaCompliance + 0.2 * paymentHistory),
    evidence + repaymentsCount,
  )

  // Credit-repayment behavior — the other half of "scale": an agent that
  // draws credit and repays on time proves creditworthiness directly.
  const repayments = events.filter((e) => e.eventType === 'REPAYMENT_COMPLETED').length

  // Completed paid jobs on the labor market — real economic activity, the
  // strongest reputation signal an agent can accumulate. Weighted, not
  // counted: see collusionWeight/graderWeight below.
  const jobsCompleted = weightedMarketSignal(events, 'JOB_COMPLETED', now)

  // ── Reputation (20%) ─────────────────────────────────────────────
  // Verified achievements are explicit third-party attestations; the rest
  // accrues from the volume of successful interactions — repaid credit and,
  // most of all, delivered paid work.
  const achievements = events.filter((e) => e.eventType === 'ACHIEVEMENT_VERIFIED').length
  const verifiedCompleted = events.filter((e) => e.eventType === 'VERIFIED_TASK_COMPLETED').length
  // Acceptance tests on code jobs, run by the platform runtime (grader ≠
  // solver) — a fact, same trust class as VERIFIED_TASK_*. Supplementary to
  // the run's own terminal event, so they don't join TERMINAL above.
  const testsPassed = weightedMarketSignal(events, 'JOB_TESTS_PASSED', now)
  // Negative facts decay too — on the slower half-life. A failed grading
  // from two years ago should not weigh like yesterday's, but it should
  // outlast the equivalent success.
  const testsFailed = events
    .filter((e) => e.eventType === 'JOB_TESTS_FAILED')
    .reduce((sum, e) => sum + recencyWeight(e.createdAt, now, NEGATIVE_HALF_LIFE_DAYS), 0)
  const reputation = dampen(
    clamp(
      Math.log10(completed.length + 1) * 35 +
        achievements * 10 +
        repayments * 8 +
        jobsCompleted * 12 +
        verifiedCompleted * 10 + // ground-truth-verified capability
        testsPassed * 10, // independently test-verified deliverables
    ),
    evidence + achievements + repayments + Math.round(jobsCompleted) + Math.round(testsPassed),
  )

  // ── Risk (10%) — higher is safer ─────────────────────────────────
  // Defaults are the strongest negative credit signal, weighted above task
  // failures. A deliverable that failed the requester's acceptance tests is
  // a confident-but-wrong fact — riskier than an honest task failure.
  const anomalies = events.filter((e) => e.eventType.includes('ANOMALY')).length
  const decayedDefaults = events
    .filter((e) => e.eventType === 'REPAYMENT_DEFAULTED')
    .reduce((sum, e) => sum + recencyWeight(e.createdAt, now, NEGATIVE_HALF_LIFE_DAYS), 0)
  // Failures, defaults and failed gradings drive the raw value down; they do
  // not also buy the confidence that would scale it back up.
  const risk = dampen(
    clamp(100 - failed.length * 8 - anomalies * 15 - decayedDefaults * 25 - testsFailed * 10),
    evidence,
  )

  // ── Composite → score ────────────────────────────────────────────
  const composite = 0.4 * performance + 0.3 * reliability + 0.2 * reputation + 0.1 * risk
  const score = Math.round(300 + composite * 6.9) // 300 (floor) – 990 (ceiling)

  return {
    score,
    rating: ratingForScore(score, rules?.rating),
    creditLimit: creditLimitForScore(score),
    riskLevel: riskLevelForScore(score, rules?.risk),
    breakdown: {
      performance: Math.round(performance * 10) / 10,
      reliability: Math.round(reliability * 10) / 10,
      reputation: Math.round(reputation * 10) / 10,
      risk: Math.round(risk * 10) / 10,
      composite: Math.round(composite * 10) / 10,
      completedTasks: completed.length,
      failedTasks: failed.length,
      successRate: Math.round(successRate * 1000) / 1000,
      avgQuality: Math.round(avgQuality * 1000) / 1000,
    },
  }
}

// ── Collusion resistance ──────────────────────────────────────────────
//
// Three multiplicative weights, each answering one attack from the market-
// design literature (Agent Bazaar arXiv:2605.17698, Diagon arXiv:2604.06688)
// plus the wash-trading attack neither paper tested:
//
//   diversity × credibility × grader × exposure × recency
//
// The design borrows Bitcoin's halving insight twice over: make the emission
// schedule a CONVERGENT series, and total extractable value is capped by
// construction rather than by vigilance.

/** k-th graded fact with the SAME counterparty is worth 1/2^k — a geometric
 *  series, so the TOTAL reputation extractable from any single counterparty
 *  converges to two full-weight trades' worth, forever. The earlier 1/√k
 *  discount only slowed a patient ring down (Σ1/√k diverges); halving caps
 *  it. Legitimate repeat business loses some signal by design: in a world
 *  where identities are free, "50 trades with one partner" is
 *  indistinguishable from self-dealing — the repeat client still pays in
 *  MONEY; reputation is reserved for breadth, which generalizes to
 *  strangers. Null counterparty (legacy events) keeps full weight. */
export function collusionWeight(priorWithSameCounterparty: number): number {
  return Math.pow(0.5, priorWithSameCounterparty)
}

/**
 * Counterparty independence — the halving, applied one level up.
 *
 * `collusionWeight` caps what is extractable from ONE counterparty at ~2
 * full-weight trades. It says nothing about the NUMBER of counterparties, and
 * accounts are free, so the documented residual attack was: mint N accomplices,
 * farm each to its cap, collect 0.5 × N. A convergent series per partner, still
 * LINEAR in partners. No multiplicative weight can fix that — halving a linear
 * function leaves it linear. The only thing that breaks linearity is refusing
 * to give a fresh counterparty its own bucket.
 *
 * So: an independent counterparty keeps its own halving bucket; every
 * non-independent one SHARES a single pooled bucket. N accomplices that trade
 * only with me are now one counterparty as far as reputation is concerned, and
 * the whole farm converges to ~2 full-weight trades no matter how large N gets.
 *
 * Independence is defined structurally, not by score: settled work with at
 * least INDEPENDENCE_MIN_PARTNERS distinct agents other than me. A bought aged
 * account with a good score but a star topology fails this; the credibility
 * weight would have waved it through.
 *
 * **What this does not stop, stated plainly.** A RING defeats it — accomplices
 * that trade with each other rather than only with the centre each acquire
 * distinct partners and earn their own buckets again. The star becomes
 * convergent; the ring stays linear. What the ring now costs is real: every
 * edge is a posted job paying the 2% fee, so N accomplices need ~2N funded
 * bounties instead of N. Pricing is not prevention, and the honest next step
 * is anchored trust propagation over the whole trade graph, not another local
 * weight. `docs/self-sybil-attack.md` carries this limitation.
 */
export const INDEPENDENCE_MIN_PARTNERS = 2

/** Every counterparty that fails the independence test shares this bucket.
 *  Deliberately distinct from the legacy null-counterparty pool: pooling those
 *  together would silently re-weight history predating counterparty stamping. */
export const POOLED_COUNTERPARTY = '__unaffiliated__'

export function isIndependentCounterparty(otherPartners: number | null | undefined): boolean {
  if (otherPartners === null || otherPartners === undefined) return true // not computed → no retroactive penalty
  return otherPartners >= INDEPENDENCE_MIN_PARTNERS
}

/** The halving key. Null counterparty keeps its historical behaviour (the
 *  caller decides what null means); a non-independent counterparty is pooled. */
export function counterpartyBucket(
  counterparty: string | null | undefined,
  otherPartners: number | null | undefined,
): string | null {
  if (!counterparty) return null
  return isIndependentCounterparty(otherPartners) ? counterparty : POOLED_COUNTERPARTY
}

/** Reputation earned FROM a nobody is worth little: a ring that mints fresh
 *  requester accounts to fake diversity earns the floor, because each new
 *  accomplice starts at score 300 with no history of its own. Scales
 *  linearly from the floor at score<=300 to full weight at score>=700.
 *  Null (legacy events, pre-stamping) keeps full weight — no retroactive
 *  penalty. */
export const CREDIBILITY_FLOOR = 0.25
export function credibilityWeight(counterpartyScore: number | null | undefined): number {
  if (counterpartyScore === null || counterpartyScore === undefined) return 1
  const t = (counterpartyScore - 300) / 400 // 300 → 0, 700+ → 1
  return CREDIBILITY_FLOOR + (1 - CREDIBILITY_FLOOR) * Math.min(1, Math.max(0, t))
}

/** Verdicts differ in how hard they are for a colluding requester+worker
 *  pair to manufacture. A repo job's CI belongs to a real repository and
 *  runs on GitHub's infrastructure; a mutation-graded test suite must kill
 *  hidden mutants; an LLM review grades against criteria the requester
 *  AUTHORED — a colluding requester writes trivially-passable criteria.
 *  Unknown graders get the middle weight rather than the top one. */
export const GRADER_WEIGHTS: Record<string, number> = {
  'repo-ci': 1.25,
  tests: 1.0,
  code: 1.0,
  vision: 0.8,
  audio: 0.8,
  'llm-review': 0.6,
  text: 0.6,
}

export function graderWeight(grader: string | null | undefined): number {
  if (!grader) return 0.8
  return GRADER_WEIGHTS[grader] ?? 0.8
}

/**
 * Capital exposure — the fifth weight, and the one the others don't cover.
 *
 * Until now a completion counted the same whether the agent delivered a $1
 * practice task or a $200 contract. Every real credit system disagrees: the
 * amount at stake IS information about how much a counterparty trusted you,
 * and about how much was destroyed when you failed.
 *
 * Three properties this has to have, and they fight each other:
 *
 * 1. **Sublinear.** Linear weighting would let one large job dominate a
 *    history, which is the same "farm once, coast" failure the recency
 *    half-life exists to kill.
 * 2. **Capped, hard.** On testnet the escrow token is freely mintable, so
 *    bounty inflation is nearly free here; on mainnet it is merely expensive.
 *    Either way the weight must stop rewarding size well before the numbers
 *    get silly. Past ~$60 a bigger bounty buys nothing.
 * 3. **Asymmetric.** Failing a $200 job is worse than succeeding at one is
 *    good — real credit reporting has this asymmetry and so does this file
 *    already (NEGATIVE_HALF_LIFE_DAYS: bad news lingers longer). Negatives
 *    get a higher ceiling AND a higher floor, so failure on a cheap job
 *    cannot be shrugged off the way a cheap success can be discounted.
 *
 * Reference point is $10 → weight 1.0, so the existing curve is unchanged for
 * a typical job and this is not a silent re-scoring of everyone's history.
 */
export const EXPOSURE_REFERENCE_USD = 10
export const EXPOSURE_SLOPE = 0.25
export const EXPOSURE_MIN_POSITIVE = 0.5
export const EXPOSURE_MAX_POSITIVE = 1.5
/** A failure on a cheap job is still a failure — floor it higher. */
export const EXPOSURE_MIN_NEGATIVE = 0.8
export const EXPOSURE_MAX_NEGATIVE = 2.0

export function exposureWeight(usd: number | null | undefined, opts?: { negative?: boolean }): number {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return 1
  const lo = opts?.negative ? EXPOSURE_MIN_NEGATIVE : EXPOSURE_MIN_POSITIVE
  const hi = opts?.negative ? EXPOSURE_MAX_NEGATIVE : EXPOSURE_MAX_POSITIVE
  const raw = 1 + Math.log2(usd / EXPOSURE_REFERENCE_USD) * EXPOSURE_SLOPE
  return Math.min(hi, Math.max(lo, raw))
}

/** Event types where a bigger number is worse news, not better. Derived from
 *  the type rather than passed in, so a caller cannot wire it backwards. */
const NEGATIVE_SIGNALS = new Set(['JOB_TESTS_FAILED', 'VERIFIED_TASK_FAILED', 'TASK_FAILED', 'REPAYMENT_DEFAULTED'])

export function isNegativeSignal(eventType: string): boolean {
  return NEGATIVE_SIGNALS.has(eventType)
}

/** Reputation is a flow, not a stock: a graded fact loses half its weight
 *  every REPUTATION_HALF_LIFE_DAYS. Kills farm-once-coast-forever, and
 *  makes a bought aged account decay to nothing unless maintained with
 *  fresh verified work. Negative facts (failed gradings, defaults) use the
 *  slower NEGATIVE_HALF_LIFE_DAYS — bad news lingers longer than good, the
 *  same asymmetry real credit reporting uses. */
export const REPUTATION_HALF_LIFE_DAYS = 180
export const NEGATIVE_HALF_LIFE_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

export function recencyWeight(eventAt: Date, now: Date, halfLifeDays: number = REPUTATION_HALF_LIFE_DAYS): number {
  const ageDays = Math.max(0, (now.getTime() - eventAt.getTime()) / DAY_MS)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

/**
 * Collateralized settled volume — the un-farmable dollars behind a loan.
 *
 * A credit LIMIT derived from score alone means anything that inflates the
 * score inflates borrowing power, and borrowing is the only place the
 * platform can actually lose money — the terminal move of every reputation
 * farm is: pump score → draw → default. So the lending ceiling is tied to
 * something the halving math makes expensive to fake: settlement volume,
 * discounted per repeat counterparty (0.5^k, converges to ~2 full trades
 * per partner) and by counterparty credibility (a freshly minted
 * accomplice's dollars count at the 0.25 floor).
 *
 * Trades with NO recorded counterparty (legacy events) are pooled into one
 * shared bucket and floored like strangers: unlike the score path, lending
 * cannot afford to give unknown history the benefit of the doubt.
 */
export type SettledTrade = {
  amountUsd: number
  counterparty: string | null
  counterpartyScore: number | null
  createdAt: Date
  /** See AgentEventInput.counterpartyOtherPartners. Non-independent
   *  counterparties share one halving bucket here too — lending is where the
   *  farm cashes out, so it must not be the looser of the two paths. */
  counterpartyOtherPartners?: number | null
}

export function collateralizedVolume(trades: SettledTrade[]): number {
  const ordered = [...trades]
    .filter((t) => Number.isFinite(t.amountUsd) && t.amountUsd > 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const seen = new Map<string, number>()
  let total = 0
  for (const t of ordered) {
    const key = counterpartyBucket(t.counterparty, t.counterpartyOtherPartners) ?? '__unknown__'
    const k = seen.get(key) ?? 0
    seen.set(key, k + 1)
    const credibility = t.counterparty === null ? CREDIBILITY_FLOOR : credibilityWeight(t.counterpartyScore)
    total += t.amountUsd * collusionWeight(k) * credibility
  }
  return Math.round(total * 100) / 100
}

/** Borrow up to this multiple of collateralized settled volume. */
export const COLLATERAL_MULTIPLE = 2

/** The lending ceiling: the score curve sets ambition, the collateralized
 *  volume sets reality, and the lower one wins. An agent with a great score
 *  and no diverse settled history can borrow ~nothing — by design. */
export function collateralizedCreditLimit(scoreLimit: number, trades: SettledTrade[]): number {
  const cap = COLLATERAL_MULTIPLE * collateralizedVolume(trades)
  return Math.min(scoreLimit, Math.round(cap * 100) / 100)
}

/** Weighted count of a market signal: each event discounted by counterparty
 *  repetition (halving), counterparty credibility, grader strength, capital
 *  exposure, and age.
 *  Chronological order matters — the FIRST trades with a counterparty keep
 *  the most weight — and the result is order-independent w.r.t. input array
 *  order because events are sorted first. */
export function weightedMarketSignal(
  events: AgentEventInput[],
  eventType: string,
  now: Date = new Date(),
  halfLifeDays: number = REPUTATION_HALF_LIFE_DAYS,
): number {
  const seen = new Map<string, number>()
  let total = 0
  const chronological = events
    .filter((e) => e.eventType === eventType)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  for (const e of chronological) {
    let diversity = 1
    const bucket = counterpartyBucket(e.counterparty, e.counterpartyOtherPartners)
    if (bucket) {
      const prior = seen.get(bucket) ?? 0
      diversity = collusionWeight(prior)
      seen.set(bucket, prior + 1)
    }
    total +=
      diversity *
      credibilityWeight(e.counterpartyScore) *
      graderWeight(e.grader) *
      exposureWeight(e.exposureUsd, { negative: isNegativeSignal(eventType) }) *
      recencyWeight(e.createdAt, now, halfLifeDays)
  }
  return total
}

/** A DMN-style decision-table row: "score >= minScore -> value". Rows are
 *  evaluated highest minScore first; the first match wins. */
export type ScoreRule<T extends string> = { minScore: number; value: T }

export const RATINGS: Rating[] = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'D']
export const RISK_LEVELS: RiskLevel[] = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH']

/** The thresholds this file shipped with — used until an admin overrides
 *  them via the credit rating policy editor (/admin/credit-rules). */
export const DEFAULT_RATING_RULES: ScoreRule<Rating>[] = [
  { minScore: 900, value: 'AAA' },
  { minScore: 840, value: 'AA' },
  { minScore: 760, value: 'A' },
  { minScore: 680, value: 'BBB' },
  { minScore: 600, value: 'BB' },
  { minScore: 520, value: 'B' },
  { minScore: 440, value: 'C' },
]

export const DEFAULT_RISK_RULES: ScoreRule<RiskLevel>[] = [
  { minScore: 800, value: 'LOW' },
  { minScore: 680, value: 'MODERATE' },
  { minScore: 560, value: 'ELEVATED' },
]

export function ratingForScore(score: number, rules: ScoreRule<Rating>[] = DEFAULT_RATING_RULES): Rating {
  const hit = [...rules].sort((a, b) => b.minScore - a.minScore).find((r) => score >= r.minScore)
  return hit?.value ?? 'D' // fail to the safest (lowest) rating, never "no rating"
}

/**
 * Programmable credit limit, quadratic above the lending floor:
 *   limit = (score − 500)² / 5.625, rounded to $250.
 * e.g. score 875 → $25,000; score 990 → $42,750; below 520 → $0.
 */
export function creditLimitForScore(score: number): number {
  if (score < 520) return 0
  return Math.round((score - 500) ** 2 / 5.625 / 250) * 250
}

export function riskLevelForScore(score: number, rules: ScoreRule<RiskLevel>[] = DEFAULT_RISK_RULES): RiskLevel {
  const hit = [...rules].sort((a, b) => b.minScore - a.minScore).find((r) => score >= r.minScore)
  return hit?.value ?? 'HIGH' // fail to the safest (most conservative) risk level
}

/** Human-readable explanation of a score change, stored with each entry. */
export function buildCalculationReason(
  next: CreditAssessment,
  previousScore: number | null,
): string {
  const b = next.breakdown
  const parts = [
    previousScore === null
      ? `Initial assessment: ${next.score}`
      : `Score ${previousScore} → ${next.score}`,
    `${b.completedTasks} completed / ${b.failedTasks} failed tasks (success rate ${(b.successRate * 100).toFixed(1)}%)`,
    `avg output quality ${(b.avgQuality * 100).toFixed(0)}%`,
    `factors — performance ${b.performance}, reliability ${b.reliability}, reputation ${b.reputation}, risk ${b.risk}`,
  ]
  return parts.join('; ')
}
