/**
 * Verdict stake — the reviewer's pay is accountable to its verdict.
 *
 * Measured problem (2026-09-01/02, three finished review conversations):
 * eight verdicts, zero APPROVEs. With identical pay for either verdict, a
 * paid fault-finder treats REVISE as always defensible, and brief-level
 * fixes — an explicit approval standard, a final-round disclosure — moved
 * nothing. The reviewer's judgments were often RIGHT (a fabricated citation
 * caught, a truncation caught); what the market lacked was any cost to
 * refusing closure forever.
 *
 * The stake prices exactly that, with a NON-RECURSIVE ground truth: the
 * owner's own on-chain judgment of the deliverable the reviewer refused.
 *
 *  - A conversation the reviewer CLOSES (APPROVE) never stakes anything.
 *  - A conversation the reviewer stonewalls to hand-to-owner records a
 *    stake of half the review bounty. Then the chain decides:
 *      · owner RELEASES the target's escrow (the work was acceptable —
 *        the reviewer is overruled by the money authority) → the stake is
 *        BURNED. Burned, not paid to the owner: paying it to the party who
 *        decides the trigger makes overruling profitable, the same reason
 *        LaborMarketV2 burns a slashed bond instead of paying the requester.
 *      · target is REFUNDED (the owner declined the work, or let the
 *        deadline agree with the reviewer) → the stake returns; the REVISE
 *        was vindicated.
 *      · anything else → still held; the chain has not decided yet.
 *
 * The trigger is a mechanical on-chain state transition — no LLM opinion
 * can move this money (lib/evidence-assurance.ts's rule, kept). On
 * real-money deployments the burn transfer additionally refuses without
 * REVIEW_STAKE_ALLOW_REAL_MONEY=true, the lineage-mandate pattern: the
 * VERDICT is still recorded; only the movement waits for the flag.
 *
 * Known limit, stated: a wrong APPROVE is not staked in v1 — the appeal
 * machinery is the natural trigger for that side and is not wired here.
 * The asymmetry is deliberate: the observed failure is never-approve, and
 * an unstaked APPROVE is exactly the nudge the equilibrium needs.
 */

export const REVIEW_STAKE = {
  /** Fraction of the review bounty at stake on a stonewalled conversation. */
  FRACTION: 0.5,
  /** Below this the transfer costs more attention than it moves. */
  MIN_USD: 0.01,
} as const

/** Where a forfeited stake goes: nowhere anyone controls. */
export const STAKE_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

export type ReviewStake = {
  reviewerAgentId: string
  amountUsd: number
  status: 'held' | 'returned' | 'forfeited'
  /** What decided it, for the record — a tx hash on a burn, a sentence otherwise. */
  reason?: string
}

/** Stake for a review bounty: half, floored to the cent, min MIN_USD.
 *  Micro-unit arithmetic — `1.14 * 0.5 * 100` is 56.999… in floats, and a
 *  stake that floors a cent short of what the brief promised is a ledger
 *  that argues with itself. */
export function reviewStakeUsd(reviewBountyUsd: number): number {
  const microUnits = Math.round(reviewBountyUsd * 1e6)
  const stakeCents = Math.floor((microUnits * REVIEW_STAKE.FRACTION) / 1e4)
  return Math.max(REVIEW_STAKE.MIN_USD, stakeCents / 100)
}

/** What the chain's state of the REFUSED deliverable says about the stake.
 *  'Completed' = the owner released it — reviewer overruled → forfeit.
 *  'Refunded' or 'Disputed' = the money did not go to the worker — the
 *  reviewer's refusal agreed with the outcome → return.
 *  Anything else — undecided, keep holding. */
export function decideStakeOutcome(targetJobStatus: string): 'forfeit' | 'return' | 'hold' {
  if (targetJobStatus === 'Completed') return 'forfeit'
  if (targetJobStatus === 'Refunded' || targetJobStatus === 'Disputed') return 'return'
  return 'hold'
}

/** May the burn transfer actually move money on this deployment? */
export function stakeMoveAllowed(isRealMoney: boolean, allowFlag: string | undefined): boolean {
  return !isRealMoney || allowFlag === 'true'
}
