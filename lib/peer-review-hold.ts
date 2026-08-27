/**
 * Does a passing grade release this job's escrow, or is somebody still owed a
 * look at it first?
 *
 * The peer-review gate (`reviewOf`, docs/collaboration.md) was written inside
 * `tickDelegation`: when a reviewed subtask passes grading, the tick sets
 * `awaitingReview` and holds the money until the peer returns APPROVE. That is
 * the whole gate — and it is not the only thing that can release escrow.
 *
 * `autoApprovePassedJob` (lib/labor-settle.ts) releases on a passing grade too,
 * from the ops cycle, and it knows nothing about delegations. So the two race,
 * and whichever fires first decides. When settlement wins, a reviewed subtask
 * pays out before its reviewer has read a word — and the review, when it finally
 * runs, is graded and paid for an opinion that can no longer change anything.
 * That is not a slow gate, it is an absent one: the escrow it was supposed to
 * hold is already gone.
 *
 * This module is the gate's own predicate, extracted so BOTH paths can ask it.
 * It is deliberately pure and deliberately pessimistic: given subtasks it cannot
 * make sense of, it holds. A wrongly-held job stays Submitted and the next
 * delegation tick releases it; a wrongly-released one has moved real money.
 */

/** The shape this predicate needs. Structurally a subset of DelegationSubtask,
 *  declared locally so the pure module doesn't drag in lib/delegation.ts. */
export type ReviewableSubtask = {
  title?: unknown
  reviewOf?: unknown
  reviewVerdict?: unknown
  onchainJobId?: unknown
}

export type HoldVerdict =
  | { hold: false }
  | { hold: true; reason: string }

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/**
 * Is `jobId` the on-chain job of a subtask that still owes a peer sign-off?
 *
 * Held when some other subtask names this one in `reviewOf` and has not yet
 * recorded a verdict. A verdict of any kind — approve OR revise — ends the
 * hold: 'revise' has its own route (back to the worker), and keeping the
 * money frozen here would strand it behind a gate that already opened.
 *
 * Tiers (`reviewTier`) need no special handling. Tier N is not posted until
 * tier N-1 approves, and a tier that has not been posted has no verdict, so
 * the hold simply persists until the last tier records one.
 */
export function heldForPeerReview(
  subtasks: readonly ReviewableSubtask[],
  jobId: number,
): HoldVerdict {
  const target = subtasks.find(
    (s) => typeof s.onchainJobId === 'number' && s.onchainJobId === jobId,
  )
  if (!target) return { hold: false } // not a delegation subtask at all
  const title = str(target.title)
  if (!title) {
    // A subtask with a job id but no title: we cannot match reviewers to it,
    // so we cannot prove nobody is waiting. Hold and let the tick sort it out.
    return { hold: true, reason: 'subtask has an on-chain job but no title to match reviewers against' }
  }
  // A review subtask is never itself reviewed (the planner rejects reviewing a
  // review), so it never holds.
  if (str(target.reviewOf)) return { hold: false }

  const pending = subtasks.filter(
    (s) => str(s.reviewOf) === title && s.reviewVerdict === undefined,
  )
  if (!pending.length) return { hold: false }
  return {
    hold: true,
    reason:
      pending.length === 1
        ? `"${title}" is peer-reviewed by "${str(pending[0].title) ?? 'an unnamed reviewer'}", which has not returned a verdict`
        : `"${title}" has ${pending.length} peer reviewers that have not returned a verdict`,
  }
}
