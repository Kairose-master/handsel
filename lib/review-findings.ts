/**
 * Making a review terminate.
 *
 * ## The observation
 *
 * Across two live delegations a paid Red Team reviewer returned **8 verdicts
 * and 0 APPROVEs**. The last three were consecutive REVISEs on a round that
 * had been told, in the brief, that a REVISE would end the pipeline unresolved
 * with no chance to fix it. Explicit approval criteria did not move it either.
 *
 * The reviews were not bad. In round 2 the reviewer caught a genuinely wrong
 * citation — AWS figures attributed to a blog that did not contain them — and
 * the worker accepted the correction. **The defect is not misjudgement. It is
 * that nothing could end.**
 *
 * ## Why wording cannot fix it
 *
 * A reviewer paid the same for either verdict has REVISE as a dominant
 * strategy. APPROVE looks like having found nothing, which looks like not
 * working; REVISE is always defensible, because no document is beyond
 * improvement. That is a payoff structure, and no amount of brief text
 * negotiates with one. Confirmed empirically, twice, at increasing volume.
 *
 * ## The reframe
 *
 * Separate **assessment** from **disposition**. The reviewer's job is to
 * produce evidence. Whether escrow releases is a function *over* that
 * evidence, computed by the platform — not a word the reviewer chooses.
 *
 * So a REVISE no longer holds money. A **verified blocking finding** holds
 * money, and it is verified mechanically:
 *
 *   **A blocking finding must quote text that actually appears in the
 *   deliverable.**
 *
 * That one rule does the work of three:
 *
 *  - *Vague findings stop blocking.* "Could be more rigorous" has nothing to
 *    quote. It is recorded as advisory and the escrow releases. The cost of
 *    blocking is now specificity, which is the incentive change — REVISE stops
 *    being free without touching anybody's bounty.
 *  - *Stale findings stop blocking.* If the worker fixed the sentence, the
 *    sentence is gone, and the reviewer cannot re-quote it. Repeating last
 *    round's objection is mechanically impossible rather than discouraged.
 *  - *Real findings still block.* The round-2 citation catch quotes a claim
 *    that is really in the text. It blocks, exactly as it should.
 *
 * None of this is a judgement call and none of it is another model call. It is
 * string matching against the deliverable, which is why it cannot be argued
 * with.
 *
 * ## What is deliberately NOT here
 *
 * The deeper fix is to put the reviewer's own money behind a blocking call —
 * pay less for a block that the next revision shows was wrong. That needs
 * contract work and it is the owner's call on how much, so it is not in this
 * file. What is here changes the *cost* of blocking rather than the *payout*,
 * which is buildable today and, per the evidence above, addresses the same
 * equilibrium.
 *
 * Pure. The delegation tick supplies the text and acts on the disposition.
 */

/** How a finding was classified, and why — carried so a proof can show it. */
export type FindingKind =
  /** Quoted text that is really in the deliverable. Holds escrow. */
  | 'blocking'
  /** Recorded and published, but does not hold escrow. */
  | 'advisory'

export type VoidReason =
  /** Marked BLOCKING with no quoted span at all. */
  | 'no-quote'
  /** The quote is not in the deliverable — the objection is about text that
   *  is not there, most often because a previous round already fixed it. */
  | 'quote-not-found'

export type Finding = {
  kind: FindingKind
  /** The reviewer's own words for what is wrong. */
  defect: string
  /** The span it points at, when it has one. */
  quote: string | null
  /** Set only when the reviewer asked for blocking and did not earn it. */
  voided: VoidReason | null
}

/**
 * Whitespace and case are not the substance of a quote.
 *
 * A reviewer retyping a sentence out of a rendered document loses the original
 * line breaks, and refusing the finding for that would be the gate quibbling
 * about formatting while a real defect stands. Punctuation IS kept: a quote
 * that differs in its numbers or its names is a different claim.
 */
function canon(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

const MAX_FINDINGS = 30
const MAX_DEFECT = 400
const MAX_QUOTE = 600

/** `BLOCKING:` at the head of a line, through any markdown decoration a model
 *  reaches for — `- **BLOCKING:**`, `1. BLOCKING -`, `> BLOCKING —`. */
const BLOCKING_MARKER = /^[ \t]*(?:[->*+\d.)\s]*)(?:\*\*|__)?[ \t]*blocking\b[ \t]*(?:\*\*|__)?[ \t]*[:\-—]?[ \t]*/gim

/** How much text after a marker is considered part of that finding. Bounded so
 *  one unterminated quote cannot swallow the rest of the review. */
const SPAN_LIMIT = 1200

/** The first quoted span in a finding: straight, curly, or backticked. */
const QUOTED = /"([^"]{3,600})"|“([^”]{3,600})”|`([^`]{3,600})`/

export function extractQuote(text: string): string | null {
  const m = QUOTED.exec(text)
  const q = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
  return q ? q.slice(0, MAX_QUOTE) : null
}

/**
 * Read a reviewer's prose into findings, and decide which of them earned the
 * right to hold money.
 *
 * `deliverable` is the text under review. A blocking claim is checked against
 * it rather than believed.
 */
export function extractFindings(reviewText: string, deliverable: string): Finding[] {
  const haystack = canon(deliverable ?? '')
  const text = reviewText ?? ''
  const findings: Finding[] = []

  // Whole-text scan rather than line-by-line. A reviewer quoting two sentences
  // out of a document includes a newline in the quote, and a line parser reads
  // that as an unterminated quote and demotes the finding — silently turning a
  // real objection into an advisory one, which is the one direction this rule
  // must never fail in.
  const marks = [...text.matchAll(BLOCKING_MARKER)]
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index! + marks[i][0].length
    const end = Math.min(i + 1 < marks.length ? marks[i + 1].index! : text.length, start + SPAN_LIMIT)
    const body = text.slice(start, end).trim()
    if (!body) continue
    const quote = extractQuote(body)
    const defect = body.replace(/\s+/g, ' ').slice(0, MAX_DEFECT)

    if (!quote) {
      findings.push({ kind: 'advisory', defect, quote: null, voided: 'no-quote' })
    } else if (!haystack.includes(canon(quote))) {
      // Either invented, or — far more often — about a sentence a previous
      // round already removed. Both are the same thing to an escrow: an
      // objection to text that is not in front of anybody.
      findings.push({ kind: 'advisory', defect, quote, voided: 'quote-not-found' })
    } else {
      findings.push({ kind: 'blocking', defect, quote, voided: null })
    }
    if (findings.length >= MAX_FINDINGS) break
  }

  return findings
}

export const blockingOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.kind === 'blocking')

/**
 * What happens to the reviewed deliverable. Pure, total, and — the point of
 * the whole file — it always names an end state.
 */
export type ReviewDisposition =
  /** Approve and release the escrow. */
  | 'release'
  /** Send it back to the worker with the findings. */
  | 'revise'
  /** Rounds are spent and a verified blocking finding still stands. The
   *  subtask is FAILED: pay-only-on-pass, and the pipeline finalizes. */
  | 'fail'

/** Two rounds is enough for "you missed a requirement" to be fixed and
 *  confirmed. Past that the disagreement is not one more round away. */
export const MAX_REVISION_ROUNDS = 2

/**
 * The disposition, from evidence rather than from a verdict word.
 *
 * There is no `hand-to-owner`. That outcome was the defect: it set neither
 * `output` nor `failed` on the subtask, so `workTerminal` stayed false and the
 * **entire delegation never finalized** — two of them were still sitting in it
 * when this was written. An escrow parked forever pending a human is not a
 * conservative default, it is the absence of a decision wearing one.
 *
 * Note what is NOT an input: whether the reviewer wrote APPROVE or REVISE. The
 * word is recorded for the proof and it decides nothing. A REVISE with no
 * verifiable blocking finding releases, because a reviewer that cannot point
 * at what is wrong has not earned a hold on a stranger's money — and a
 * reviewer that CAN point at it gets exactly what it should, which is the
 * work sent back.
 */
export function decideReview(input: {
  /** The reviewer turned out to be the same worker: discarded, not acted on,
   *  so a self-approval cannot release its own escrow. */
  samePerson: boolean
  blockingCount: number
  round: number
  maxRounds?: number
}): ReviewDisposition {
  if (input.samePerson) return 'release'
  if (input.blockingCount <= 0) return 'release'
  const max = input.maxRounds ?? MAX_REVISION_ROUNDS
  return input.round >= max ? 'fail' : 'revise'
}

/** One line per finding for the platform feed and the work proof — the
 *  reviewer's objections survive even when they did not hold the money, so a
 *  requester can see what was said and disagree with the disposition. */
export function summariseFindings(findings: readonly Finding[]): string {
  if (!findings.length) return 'no findings'
  return findings
    .map((f) => {
      if (f.kind === 'blocking') return `BLOCKING: ${f.defect}`
      const why = f.voided === 'no-quote' ? 'no quoted span' : f.voided === 'quote-not-found' ? 'quote not in the deliverable' : 'advisory'
      return `advisory (${why}): ${f.defect}`
    })
    .join('\n')
}

/** What the reviewer is told, so the shape is not a secret the gate keeps. */
export function reviewFormatInstructions(): string {
  return [
    'HOW TO BLOCK RELEASE. Escrow is held only by a finding that quotes the work.',
    '',
    'For each defect that should stop payment, write one line:',
    '',
    '    BLOCKING: "<exact text copied from the work>" — what is wrong with it',
    '',
    'The quoted text is checked against the deliverable. A blocking line whose',
    'quote is not found there is recorded as advisory and does not hold the',
    'escrow — including a quote from an earlier draft that has since been',
    'fixed, so there is no value in repeating an objection the worker already',
    'addressed.',
    '',
    'Anything else you write is recorded as advisory: published with the work,',
    'visible to the requester, and not blocking. Say it if it is worth saying.',
    'Asking for changes without quoting what is wrong does not hold payment.',
  ].join('\n')
}

/**
 * Draining the backlog the old rule created.
 *
 * A target parked by `hand-to-owner` is in a state nothing re-enters: no
 * pending review, no revision in flight, no output, not failed. The new
 * disposition never produces it, but the rows already sitting in it will sit
 * there forever — two were, when this was written, with nothing on any page
 * saying a person was expected.
 *
 * Doing nothing is not neutral. Those escrows are Submitted with a delivery
 * deadline running, so the outcome of leaving them is a refund to the
 * requester — the harshest of the three possible endings, arrived at silently
 * and by timeout rather than by anybody's judgement.
 *
 * So the new rule is applied to the evidence that was actually recorded. Old
 * notes carry no `BLOCKING:` lines and therefore no verifiable finding, which
 * under this rule means they never held the money in the first place. That is
 * not leniency toward the worker; it is the same standard, applied backwards.
 */
export function decideParked(input: {
  /** Whatever the last reviewer actually wrote, as stored. */
  reviewNote: string | null | undefined
  /** The deliverable the note was about. */
  submittedOutput: string | null | undefined
}): { disposition: 'release' | 'fail'; blocking: Finding[] } {
  const findings = extractFindings(input.reviewNote ?? '', input.submittedOutput ?? '')
  const blocking = blockingOf(findings)
  return { disposition: blocking.length > 0 ? 'fail' : 'release', blocking }
}
