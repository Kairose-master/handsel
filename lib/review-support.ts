/**
 * An approval has to be supported too.
 *
 * Two changes landed on 2026-09-02, from two sessions, and both pushed the
 * reviewer the same way:
 *
 *  - `lib/review-findings.ts` — a REVISE holds escrow only if it quotes text
 *    really present in the deliverable. Objecting without evidence became
 *    pointless work.
 *  - `lib/review-stake.ts` — a REVISE driven to the terminal stakes half the
 *    review bounty on the outcome. Objecting became expensive.
 *
 * And `lib/review-stake.ts` says, in its own words: *a conversation the
 * reviewer CLOSES (APPROVE) never stakes anything.* Nothing checks an
 * approval either.
 *
 * So the rational strategy after those two changes is **approve instantly
 * without reading**: zero cost, zero risk, full bounty. We may have converted
 * eight-verdicts-zero-approvals into its mirror image, and the mirror is
 * worse — a stonewalling reviewer only delays a pipeline, while a rubber stamp
 * destroys the thing the review step is bought for.
 *
 * ## Why there is no after-the-fact check to lean on
 *
 * The obvious symmetry — resolve a bad APPROVE the way a bad REVISE is
 * resolved, on somebody's later judgment — has nowhere to attach:
 *
 *  - The independent grader cannot contradict the reviewer, because a job that
 *    failed grading never reaches peer review at all. Every deliverable a
 *    reviewer sees has already passed.
 *  - The requester cannot object afterwards, because an APPROVE calls
 *    `approveJob` immediately and the job is `Completed`. There is no window
 *    left to dispute in.
 *
 * **An approval is terminal and unreviewable by construction.** That is the
 * actual finding, and it is why this file checks the approval itself rather
 * than its consequences.
 *
 * ## What is checked, and who pays when it fails
 *
 * The same evidence the other side already needs: an approval must point at
 * the work. It says which acceptance criteria it checked and quotes the
 * deliverable where they are met, and the quotes are verified against the
 * deliverable exactly as blocking findings are.
 *
 * **An unsupported approval still releases the worker's escrow.** This must be
 * said plainly, because the alternative is the defect this repo just spent a
 * day removing: making the worker's money hostage to a reviewer's paperwork
 * would re-introduce non-termination through a new door. The worker did the
 * work, it passed the grader, and a reviewer's failure to write down what it
 * checked is not evidence against the worker.
 *
 * What an unsupported approval costs is the REVIEWER's own fee. It was paid to
 * review, and a verdict with nothing behind it is not a review. That keeps the
 * penalty on the party that chose the behaviour, which is the property the
 * whole escrow design is built on.
 *
 * Pure.
 */
import { extractQuote } from '@/lib/review-findings'

/** Approvals shorter than this are not summaries, they are noises. `LGTM` is
 *  the canonical one and it is exactly what this exists to stop being free. */
export const MIN_APPROVAL_CHARS = 40

export type ApprovalSupport = {
  /** Quotes from the deliverable the reviewer offered as evidence. */
  verifiedQuotes: string[]
  /** Quotes that are not in the deliverable — invented, or from a draft that
   *  no longer exists. */
  unverifiedQuotes: string[]
  /** Acceptance criteria the approval visibly engages with. */
  criteriaAddressed: number
  criteriaTotal: number
  /** Did this approval earn the review fee? */
  supported: boolean
  /** Why not, in the reviewer's own terms. */
  shortfall: string | null
}

/**
 * Split acceptance criteria into the individual things being promised.
 *
 * Line-per-criterion is how every brief in this codebase writes them, and a
 * blank line or a bullet marker is the separator. Deliberately forgiving: a
 * criteria block that parses as one long line simply means one criterion, and
 * the check below still asks for evidence of it.
 */
export function criteriaLines(acceptanceCriteria: string): string[] {
  return (acceptanceCriteria ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length >= 8)
}

/** Content words a criterion is actually about — the words whose presence in
 *  an approval means it engaged with THAT criterion rather than any other. */
const STOP = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','that','this','is','are','be','must','should','all','any',
  'each','every','it','its','as','at','by','from','has','have','not','no','than','then','there','their','they','was','were',
  'will','would','can','could','job','task','work','output','deliverable','include','includes','including','provide','provided',
])

function contentWords(s: string): string[] {
  return [...new Set(s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].filter((w) => !STOP.has(w))
}

/**
 * Does the approval engage with this criterion?
 *
 * A share of the criterion's own content words has to appear in the approval.
 * Not a semantic check and not pretending to be one — it is a cheap floor that
 * "LGTM" and "Looks good, all criteria met" both fail and a reviewer that
 * actually walked the list passes without trying.
 */
export function addressesCriterion(approval: string, criterion: string): boolean {
  const words = contentWords(criterion)
  if (words.length === 0) return true
  const hay = approval.toLowerCase()
  const hits = words.filter((w) => hay.includes(w)).length
  return hits / words.length >= 0.34
}

/**
 * Read an approval and decide whether it earned the review fee.
 *
 * Never decides anything about the worker — see the file header. The caller
 * releases the escrow either way.
 */
export function approvalSupport(input: {
  approvalText: string
  deliverable: string
  acceptanceCriteria: string
}): ApprovalSupport {
  const text = (input.approvalText ?? '').trim()
  const criteria = criteriaLines(input.acceptanceCriteria)
  const hay = (input.deliverable ?? '').replace(/\s+/g, ' ').toLowerCase()

  // Every quoted span in the approval, not just the first.
  const verified: string[] = []
  const unverified: string[] = []
  for (const raw of text.split('\n')) {
    const q = extractQuote(raw)
    if (!q) continue
    if (hay.includes(q.replace(/\s+/g, ' ').toLowerCase())) verified.push(q)
    else unverified.push(q)
  }

  const addressed = criteria.filter((c) => addressesCriterion(text, c)).length

  let shortfall: string | null = null
  if (text.length < MIN_APPROVAL_CHARS) {
    shortfall = `an approval has to say what was checked — this was ${text.length} characters`
  } else if (verified.length === 0) {
    shortfall =
      unverified.length > 0
        ? 'the approval quotes text that is not in the deliverable'
        : 'the approval quotes nothing from the deliverable'
  } else if (criteria.length > 0 && addressed === 0) {
    shortfall = 'the approval does not engage with any of the acceptance criteria'
  }

  return {
    verifiedQuotes: verified,
    unverifiedQuotes: unverified,
    criteriaAddressed: addressed,
    criteriaTotal: criteria.length,
    supported: shortfall === null,
    shortfall,
  }
}

/** What the reviewer is told, so this is a rule and not a trap. */
export function approvalFormatInstructions(): string {
  return [
    'HOW TO APPROVE. An approval is paid work too, so it has to show what you checked.',
    '',
    'Name the acceptance criteria you verified, and for each one quote the text in the',
    'work that satisfies it:',
    '',
    '    APPROVE',
    '    Every figure is sourced: "the 2026 transit report (Cloudflare)" — cited inline.',
    '    Covers all three regions: "us-east, eu-west and ap-south" — all present.',
    '',
    'The quotes are checked against the deliverable, the same way a BLOCKING finding is.',
    '',
    'An approval that quotes nothing still releases the worker — you cannot hold somebody',
    "else's payment hostage to your paperwork — but it does not earn the review fee. You",
    'were paid to read the work; a verdict with nothing behind it is not a review.',
  ].join('\n')
}
