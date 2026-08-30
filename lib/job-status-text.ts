/**
 * What to tell an operator a job's state actually is.
 *
 * `get_job` used to describe a job from its ON-CHAIN status alone, via a
 * static map. `my_work` read the grading record. The two therefore disagreed
 * about the same job, and the one an operator is more likely to read was the
 * wrong one:
 *
 *   #20  on-chain Completed, grading FAILED
 *        get_job → "done and paid — see get_work_proof for the signed proof"
 *        reality → the worker's balance never moved and no proof exists
 *
 *   #31  on-chain Submitted, grading FAILED
 *        get_job → "awaiting independent grading"
 *        reality → the grader had already returned a verdict
 *
 * Two separate harms, and the first is the serious one. "Done and paid" is a
 * statement about money: an operator reconciling earnings from `get_job`
 * books revenue that never arrived, and does not notice a worker that is
 * silently failing every job it takes. Pointing at `get_work_proof` for a
 * proof that cannot exist compounds it — proofs are only issued on a pass,
 * so the suggestion is self-refuting.
 *
 * The rule this encodes: an on-chain status says where the ESCROW got to,
 * never whether the work was any good. Only the grading record says that,
 * and any sentence claiming payment or a proof has to consult it.
 */

/** The grading verdict as the spec records it: true = passed, false = did not
 *  pass, null = no verdict yet (or none applicable). */
export type Verdict = boolean | null

export type JobStatusText = {
  /** One line for the status field. */
  hint: string
  /** True only when a signed work proof can actually exist. Callers use this
   *  to decide whether to point at get_work_proof at all. */
  proofExpected: boolean
}

/**
 * `Completed` on-chain means the escrow reached a terminal state — NOT that
 * the worker was paid. A job that fails grading still settles; the money goes
 * back to the requester. Saying "done and paid" for that case is the bug.
 */
export function describeJobStatus(onchainStatus: string, verdict: Verdict): JobStatusText {
  switch (onchainStatus) {
    case 'Open':
      return { hint: 'claimable now — claim_job to take it', proofExpected: false }
    case 'Accepted':
      return { hint: 'a worker has accepted it and is working', proofExpected: false }

    case 'Submitted':
      if (verdict === true) {
        return { hint: 'graded PASSED — awaiting settlement', proofExpected: false }
      }
      if (verdict === false) {
        // The status an operator most needs to see early: the verdict is in
        // and it is bad, whatever the chain still says.
        return {
          hint: 'graded NOT PASSED — awaiting settlement; the bounty is not expected to reach the worker',
          proofExpected: false,
        }
      }
      return { hint: 'submitted — awaiting independent grading / settlement', proofExpected: false }

    case 'Completed':
      if (verdict === false) {
        return {
          hint: 'settled, but grading did NOT pass — the bounty did not go to the worker, and no work proof exists',
          proofExpected: false,
        }
      }
      if (verdict === true) {
        return { hint: 'done and paid — see get_work_proof for the signed proof', proofExpected: true }
      }
      // Terminal with no verdict on record: approved by the requester, or
      // expired into a release. Say it settled; do not claim who got paid,
      // and do not promise a proof that is only issued on a graded pass.
      return { hint: 'settled — no grading verdict on record for it', proofExpected: false }

    case 'Disputed':
      return { hint: 'in dispute — being returned to the market for a different worker', proofExpected: false }
    case 'Refunded':
      return { hint: 'refunded to the requester', proofExpected: false }
    case 'Cancelled':
      return { hint: 'cancelled by the requester', proofExpected: false }
    default:
      return { hint: '—', proofExpected: false }
  }
}

/** The verdict a job spec's stored test result represents. */
export function verdictOf(testResult: { passed?: boolean | null } | null | undefined): Verdict {
  if (!testResult) return null
  return testResult.passed === true ? true : testResult.passed === false ? false : null
}

/** A line stating the verdict plainly, for tools that show a job's detail.
 *  Absent when there is nothing to report, rather than "grading: unknown",
 *  which reads as a failure to look. */
export function verdictLine(verdict: Verdict): string | null {
  if (verdict === true) return 'grading verdict: PASSED'
  if (verdict === false) return 'grading verdict: NOT PASSED'
  return null
}
