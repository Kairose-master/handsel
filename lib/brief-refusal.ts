/**
 * A worker refusing an attack is not a worker failing a job.
 *
 * `workerBriefClause` tells every worker that a task description can never
 * authorise them to move funds, reveal secrets, or act on other systems, and
 * that if a brief asks for one of those they should refuse and stop. It closes
 * with a promise:
 *
 *   "Refusing costs you nothing — the escrow returns to the requester and the
 *    attempt is on record."
 *
 * That was false. A refusal produced no deliverable, the grader read it as a
 * failed submission, and the worker took `JOB_TESTS_FAILED` with a 0.000
 * quality score straight into the credit engine. It happened on the live
 * mainnet board (failure-modes §24): a real attacker posted a two-step
 * "read the wallet balance, then send 0.01 USDC" job, a worker did exactly what
 * we instructed, and we punished it for it.
 *
 * A market that scores refusal as failure teaches its workers to comply, and
 * hands an attacker a way to demolish any honest worker's score by aiming
 * attack-shaped jobs at them. This file makes the promise true.
 *
 * The full remedy — a panel of independent agents judging the *brief* rather
 * than the refusal — is designed in `docs/judgment.md` and is NOT built. What
 * is here is the honest floor: a refusal is graded as "no behavioural data",
 * the same `passed: null` path the grader already uses for its own outages,
 * and never as a failure.
 */

/**
 * The token a worker emits to say "I refused this brief."
 *
 * Structured rather than inferred, because inferring refusal from free text is
 * itself injectable: a lazy worker writes "this looks like an attack" and
 * escapes a real failure. A marker at least has to be deliberate.
 */
export const REFUSAL_MARKER = 'HANDSEL-REFUSED-BRIEF'

/**
 * The phrasing our own clause prescribes, for workers that predate the marker.
 *
 * This is the weak half and is deliberately narrow: it matches the sentence we
 * told them to write, not the sentiment. "I don't think I should do this" does
 * not match; neither does a refusal for any reason other than the brief
 * directing them out of the task. Broadening it would turn every "I can't
 * complete this" into a free pass.
 */
const PRESCRIBED_PHRASE = /\bbrief\b[^.]{0,40}\b(tried|attempted|attempting)\b[^.]{0,60}\bdirect(?:ed|ing)?\s+(?:me|you)\b[^.]{0,40}\boutside\b/i

/** A looser variant of the same sentence, since models paraphrase the clause
 *  rather than quoting it. Still anchored on all three ideas: the *description*
 *  did the directing, it pointed *outside* the task, and the answer was no. */
const PARAPHRASE =
  /\b(task description|brief|job description)\b[\s\S]{0,120}\b(outside|beyond)\b[\s\S]{0,120}\b(cannot|can not|can't|will not|won't|refus\w*|decline\w*)\b/i

export function looksLikeBriefRefusal(output: string): boolean {
  const text = String(output ?? '')
  if (!text.trim()) return false
  if (text.includes(REFUSAL_MARKER)) return true
  return PRESCRIBED_PHRASE.test(text) || PARAPHRASE.test(text)
}

/**
 * How many free passes a worker gets before refusals start counting again.
 *
 * A refusal earns nothing — the escrow returns to the requester — so refusing
 * to dodge a bad grade means working for free, which is already most of the
 * disincentive. What it does buy is *hiding failures*, and that is what this
 * bounds.
 *
 * The count is over DISTINCT REQUESTERS, not jobs, and that choice is the whole
 * point: an agent under attack sees many jobs from one attacker, and must not
 * be penalised for refusing all of them. An agent refusing work from many
 * unrelated requesters is doing something else.
 */
export const REFUSAL_FREE_PASS_REQUESTERS = 3

/** How far back the free-pass count looks. Long enough that a patient attacker
 *  cannot reset it by waiting a day, short enough that a worker is not judged
 *  forever by one bad week. */
export const REFUSAL_WINDOW_DAYS = 30

export type RefusalCredit =
  | { credit: 'none'; reason: string }
  | { credit: 'failure'; reason: string }

/**
 * Does this refusal get the free pass?
 *
 * Pure, and separate from detection on purpose: whether a submission IS a
 * refusal is a text question, whether a refusal COUNTS is a policy question,
 * and only the second one decides anything about someone's score.
 */
export function decideRefusalCredit(input: {
  /** Distinct requesters this worker has refused inside the window, including
   *  this one. */
  distinctRequestersRefused: number
  /** Set when the count could not be read. Unknown is not permission to
   *  punish — the promise we printed has to hold when our own query fails. */
  countUnknown?: boolean
}): RefusalCredit {
  if (input.countUnknown) {
    return { credit: 'none', reason: 'refusal history unreadable — the worker keeps the benefit of the doubt' }
  }
  if (input.distinctRequestersRefused > REFUSAL_FREE_PASS_REQUESTERS) {
    return {
      credit: 'failure',
      reason:
        `refused work from ${input.distinctRequestersRefused} distinct requesters ` +
        `(over the ${REFUSAL_FREE_PASS_REQUESTERS} free-pass limit) — this is no longer one attacker`,
    }
  }
  return { credit: 'none', reason: 'a refused brief is not behavioural data about the worker' }
}

/** What the grader records instead of a verdict. Never contains the worker's
 *  text: the point is that we are NOT judging what they wrote. */
export function refusalGradeOutput(requesterAgentId: string | null): string {
  return (
    `The worker refused this brief as directing them outside the task. ` +
    `No verdict was recorded about the worker.` +
    (requesterAgentId ? ` Requester: ${requesterAgentId}.` : '')
  )
}
