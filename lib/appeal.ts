/**
 * The worker's right to be wrong about.
 *
 * Every grading defect this codebase has recorded shares a shape: the platform
 * decided something about a worker, the worker had no way to say otherwise, and
 * the fix was to classify better next time.
 *
 *   §24 — a worker refused an attack; the grader wrote a 0.000 quality score.
 *   §25 — a worker said it had no tool; we recorded an accusation against the
 *         requester and parked the escrow.
 *
 * Both were answered by sharpening `lib/brief-refusal.ts` until it could tell
 * the cases apart. That is the wrong axis to improve on. A classifier is a
 * guess about text, and *every* guess about text is eventually wrong on an
 * input nobody imagined — so a system whose only defence is a better guess has
 * no floor, just a shrinking error rate.
 *
 * ERC-8195 (`daydreamsai/taskmarket-contracts`, `ITMPEvaluator.sol`) makes the
 * other choice, and reading it is what prompted this file. Their evaluator is
 * not assumed to be right. It returns a verdict, the task enters `Appealing`,
 * and `appeal()` — callable only by the worker, only inside a window — routes
 * to a named `disputeResolver`. They did not build a better evaluator. They
 * built a way to be wrong and recover.
 *
 * ## What decides how an appeal is heard
 *
 * Not the amount, and not who is shouting: **how the original verdict was
 * reached.** `lib/grader-class.ts` already carries that, and it turns out to be
 * exactly the right input.
 *
 * - A **reproducible** verdict (CI, a test suite, a canary fingerprint) is
 *   appealed by *running it again*. There is nothing to deliberate — either the
 *   suite passes on a second run or it does not, and a verdict that changes
 *   between two runs was never evidence in the first place. This costs a
 *   compute job and no one's judgment.
 * - A **model** verdict has no such recourse. Re-prompting the same model is
 *   not a second opinion, it is the same opinion with different sampling noise,
 *   so it takes a panel of independent agents (`lib/judgment.ts`).
 *
 * The incentive this creates is the one we want. The cheapest verdict to defend
 * is the one anybody can recompute; the most expensive is the one that rests on
 * a model's say-so. That is the correct relative price, and it is the same
 * ordering `docs/graders.md` argues for — arrived at from the cost side rather
 * than asserted.
 *
 * ## What this file is not
 *
 * It is not an escrow path. Nothing here moves money. On V2 a failed verdict
 * already does not settle on its own — `returnFailedJobToMarket` records and
 * stops, and `expireReview` settles at the review deadline (see
 * `lib/dispute-policy.ts` for why an off-chain grader is not allowed to be the
 * thing that pays out). An appeal therefore lives *inside* the review window
 * that already exists: it can change the recorded verdict before the deadline
 * arrives, and it can do so without inventing a second settlement authority.
 */
import type { GraderClass } from '@/lib/grader-class'

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * How long a worker has to appeal after a failing verdict is recorded.
 *
 * Bounded by the review window it lives inside, not chosen freely: an appeal
 * that outlives the review deadline is a promise the chain will not keep, since
 * `expireReview` settles regardless of what our database thinks. Twenty-four
 * hours against a one-day review window leaves the finalisation path no room,
 * so this is deliberately shorter than the window it sits in.
 */
export const APPEAL_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * One appeal per job.
 *
 * Not a cost-control measure — a definitional one. An appeal asks for the
 * verdict to be reached a second way; asking a third time is not new evidence,
 * it is shopping for a result. ERC-8195 takes the same position: `appeal()`
 * moves a task to `Disputed`, and `Disputed` has one exit.
 */
export const MAX_APPEALS_PER_JOB = 1

// ---------------------------------------------------------------------------
// How an appeal is heard
// ---------------------------------------------------------------------------

export type AppealRoute =
  /** Re-run the same mechanical check. Deterministic, cheap, no one's judgment. */
  | 'recompute'
  /** Independent agents re-decide, because the original was a model's opinion. */
  | 'panel'

/**
 * Which route a verdict of this class earns.
 *
 * `declared` and `attested` route to a panel for the same reason `model` does:
 * neither can be recomputed by a third party, which is the only property that
 * makes `recompute` meaningful. Note that this is a claim about
 * **recomputability**, not about quality — an attested verdict may be far more
 * reliable than a mechanical one, it simply cannot be re-derived from inputs.
 */
export function appealRoute(cls: GraderClass): AppealRoute {
  return cls === 'reproducible' || cls === 'mechanical' ? 'recompute' : 'panel'
}

// ---------------------------------------------------------------------------
// Whether this appeal may be heard at all
// ---------------------------------------------------------------------------

export type AppealRequest = {
  /** The agent asking. Must be the graded worker; anyone else is not appealing,
   *  they are commenting. */
  requestingAgentId: string
  workerAgentId: string | null
  /** The recorded verdict. Only a `false` is appealable — see below. */
  passed: boolean | null
  /** How the verdict was reached. */
  graderClass: GraderClass
  /** When the verdict was recorded, ms since epoch. */
  gradedAtMs: number | null
  /** Appeals already filed against this job. */
  priorAppeals: number
  /** Now, injected so this stays pure and testable. */
  nowMs: number
}

export type AppealDecision =
  | { ok: true; route: AppealRoute }
  | { ok: false; reason: string }

/**
 * May this appeal proceed?
 *
 * Pure, and separate from filing it on purpose: whether someone is *entitled*
 * to an appeal is a rule, whether an appeal *succeeds* is evidence, and mixing
 * the two is how a right becomes a favour.
 *
 * Note what is NOT appealable, and why each is deliberate:
 *
 * - **A pass.** Nobody appeals winning. A requester who disagrees with a pass
 *   has the dispute path, which is a different mechanism with a different payer.
 * - **`passed: null`.** That is not a verdict about the worker — it is us
 *   saying we do not know (a grader outage, a refused brief, an incapable
 *   worker). There is nothing to overturn, and offering an appeal against it
 *   would invite workers to convert "no verdict" into "a verdict in my favour",
 *   which is strictly worse than the §24 floor it replaced.
 */
export function canAppeal(req: AppealRequest): AppealDecision {
  if (!req.workerAgentId || req.requestingAgentId !== req.workerAgentId) {
    return { ok: false, reason: 'only the graded worker may appeal its own verdict' }
  }
  if (req.passed === true) {
    return { ok: false, reason: 'this verdict passed — there is nothing to appeal' }
  }
  if (req.passed === null) {
    return {
      ok: false,
      reason: 'no verdict was recorded about the worker, so there is none to overturn',
    }
  }
  if (req.priorAppeals >= MAX_APPEALS_PER_JOB) {
    return { ok: false, reason: `this job has already been appealed ${req.priorAppeals} time(s)` }
  }
  if (req.gradedAtMs === null) {
    // An unknown grading time cannot be shown to be inside the window, and the
    // window is what keeps an appeal inside the review period the chain
    // enforces. Unknown timing is not permission — the same rule the settlement
    // paths already follow.
    return { ok: false, reason: 'the verdict carries no grading time, so the appeal window cannot be checked' }
  }
  const age = req.nowMs - req.gradedAtMs
  if (age > APPEAL_WINDOW_MS) {
    return { ok: false, reason: `the ${APPEAL_WINDOW_MS / 3_600_000}h appeal window has closed` }
  }
  if (age < 0) {
    // A verdict stamped in the future is a clock problem, not an appeal. Reject
    // rather than silently treating it as fresh.
    return { ok: false, reason: 'the verdict is stamped in the future — refusing to act on a clock disagreement' }
  }
  return { ok: true, route: appealRoute(req.graderClass) }
}

// ---------------------------------------------------------------------------
// What the outcome means
// ---------------------------------------------------------------------------

export type AppealOutcome = {
  /** The verdict that now stands. */
  passed: boolean | null
  /** Whether the original verdict was replaced. */
  overturned: boolean
  /** Printable, and stored — an appeal that cannot be explained is not a right. */
  reason: string
}

/**
 * A recompute appeal: the same check, run again.
 *
 * The interesting case is **disagreement**, and it does not resolve to "the
 * second run wins". Two runs of a deterministic check that disagree prove the
 * check is not deterministic, and a non-deterministic check is not evidence
 * about the worker in either direction. So a flip lands on `passed: null` —
 * no verdict — rather than on a pass.
 *
 * That may look generous to the worker and is not: `null` earns nothing, writes
 * no credit event, and leaves the escrow to the requester exactly as the §24
 * path does. What it removes is a **failure** recorded on the strength of a
 * coin flip.
 */
export function recomputeOutcome(input: { original: boolean; rerun: boolean | null }): AppealOutcome {
  if (input.rerun === null) {
    return {
      passed: input.original,
      overturned: false,
      reason: 'the check could not be re-run, so the original verdict stands unchanged',
    }
  }
  if (input.rerun === input.original) {
    return {
      passed: input.original,
      overturned: false,
      reason: 'the check was re-run and reached the same verdict',
    }
  }
  return {
    passed: null,
    overturned: true,
    reason:
      'the check reached a different verdict on a second run. A check that disagrees with itself is not ' +
      'evidence about the worker, so no verdict is recorded.',
  }
}

/**
 * A panel appeal: independent agents re-decide.
 *
 * Reuses `tallyPanel`'s three-way result rather than a majority, because the
 * split case is a real answer here too — a panel that cannot agree has not
 * established a failure, and the absence of an established failure is `null`,
 * not a pass. Only a panel that affirmatively agrees the work was acceptable
 * turns a failure into one.
 */
export function panelOutcome(input: { verdict: 'upheld' | 'unproven' | 'overturned' }): AppealOutcome {
  switch (input.verdict) {
    case 'upheld':
      return { passed: false, overturned: false, reason: 'an independent panel upheld the original verdict' }
    case 'overturned':
      return { passed: true, overturned: true, reason: 'an independent panel found the work acceptable' }
    default:
      return {
        passed: null,
        overturned: true,
        reason: 'an independent panel did not reach agreement, so no verdict is recorded about the worker',
      }
  }
}
