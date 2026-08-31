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
/**
 * What is still to happen, and roughly when.
 *
 * `deadlinesDecide` is the V2 market's rule: a failed verdict is NOT re-driven
 * off-chain — `returnFailedJobToMarket` stands down (lib/dispute-policy.ts)
 * and the on-chain review deadline settles it. That is correct, and it is
 * also invisible: `Submitted · grading: FAILED` looks like a terminal state
 * with the money stuck in it.
 *
 * It reads as an outage because nothing says a clock is running. The server
 * log already says it — *"v2 deadlines decide it, escrow settles in ~N min"* —
 * and the comment beside that line records that its absence from the operator
 * surface once "sent one reader hunting a settlement bug that did not exist".
 * It did the same again. Third time this repo has learned that a temporary
 * state has to name its deadline (§45 reservations, §49 cooldowns).
 */
export type SettlementContext = {
  /** The governing on-chain deadline for the CURRENT status, unix seconds.
   *  Null on a market that has none (V1), which is unknown, so nothing is
   *  claimed about timing. */
  deadlineSec?: number | null
  /** True on V2, where the contract settles a failed job rather than the
   *  platform. Defaults true — the deployments that matter are V2, and the
   *  wrong default here is the one that reads as an outage. */
  deadlinesDecide?: boolean
  now?: number
}

function settlesIn(ctx: SettlementContext | undefined): string {
  const deadlineSec = ctx?.deadlineSec
  if (deadlineSec == null) return 'at the on-chain review deadline'
  const mins = Math.max(0, Math.round((deadlineSec * 1000 - (ctx?.now ?? Date.now())) / 60_000))
  if (mins === 0) return 'at the on-chain review deadline, which has passed — the next settlement pass takes it'
  if (mins < 90) return `at the on-chain review deadline, in about ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round((mins / 60) * 10) / 10
  return `at the on-chain review deadline, in about ${hours} hour${hours === 1 ? '' : 's'}`
}

export function describeJobStatus(
  onchainStatus: string,
  verdict: Verdict,
  ctx?: SettlementContext,
): JobStatusText {
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
        // and it is bad, whatever the chain still says. And it must say a
        // clock is running, or a normal wait reads as money stuck.
        const decides = ctx?.deadlinesDecide ?? true
        return {
          hint: decides
            ? `graded NOT PASSED — the bounty is not expected to reach the worker. This is a normal wait, not a stall: the contract settles it ${settlesIn(ctx)}.`
            : 'graded NOT PASSED — awaiting settlement; the bounty is not expected to reach the worker',
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
