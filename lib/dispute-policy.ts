/**
 * Who decides an unresolved dispute — and the single place that answers it.
 *
 * ## The policy nobody chose
 *
 * Two automated systems disagreed, and the faster one won by three orders of
 * magnitude.
 *
 * The contract's `expireDispute` fires after DISPUTE_WINDOW (14 days) and pays
 * the WORKER, on an explicit principle written into its source: only requesters
 * can dispute, so if an unanswered dispute refunded the requester, `raiseDispute`
 * would become a free cancel button. **A failed escalation must never pay the
 * party that escalated.**
 *
 * Off-chain, `sweepDisputedJobs` rode the ops cycle — `fast: true`, every five
 * minutes on visitor traffic — and called `resolveDispute(id, false)`
 * unconditionally. Fourteen days against five minutes is not a race. The
 * contract's principle was dead code, and the live policy was **"every
 * unresolved dispute refunds the requester"** — the exact rule the contract was
 * written to refuse, in force because a sweep happened to run first.
 *
 * Nobody decided that. It was inherited from an ordering.
 *
 * ## The rule now
 *
 * > **On a V2 market, the contract decides. Nothing off-chain resolves a dispute
 * > by default; the deadline does, and it pays the worker.**
 *
 * That is not a preference between two defaults, it is a choice about which
 * failure the market can survive. Systematically taking money back from workers
 * who delivered kills the side of this market that is hardest to attract, and it
 * does so quietly — a worker who is not paid does not file a bug, it leaves.
 *
 * ## Why a guard and not a deletion
 *
 * `lib/labor-settle.ts`, `lib/stale-claim.ts` and `lib/exhausted-refund.ts` are
 * byte-identical between the v1 and v2 checkouts. **V1's contract has no timeout
 * of any kind** — its whole external surface is postJob, acceptJob, submitWork,
 * approveJob, raiseDispute, resolveDispute, cancelJob — so on V1 these sweeps
 * are the ONLY exit from `Disputed`. Deleting them there produces escrow that no
 * sweep, no timeout and no contract function can ever move.
 *
 * So the machine paths ask this first. On V1 they behave exactly as before. On
 * V2 they stand down, because there is now a door and something that opens it
 * (`lib/deadline-sweep.ts`).
 */

/**
 * May an off-chain sweep resolve a dispute on the configured market?
 *
 * True only on V1, where nothing else can. Every machine-driven
 * `resolveDispute` call site is expected to consult this — `tests/dispute-
 * policy.test.ts` greps for the ones that do not.
 *
 * This does NOT gate the human admin action. An operator holding the arbiter
 * key can still settle any disputed job, on either contract, and that is
 * deliberate: removing the route would not remove the authority, and pretending
 * otherwise is the dishonest version of this change.
 */
export async function offchainMayResolveDisputes(): Promise<boolean> {
  const { isV2Market } = await import('@/lib/onchain/labor-v2')
  return !(await isV2Market())
}

/** What a stood-down sweep reports, so a quiet pass is legible in the ops log
 *  rather than looking like a sweep that found nothing. */
export const V2_HANDLES_IT = 'skipped: v2 deadlines decide disputes'
