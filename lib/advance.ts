/**
 * The advance itself — the last mile of `docs/product-thesis.md`.
 *
 * `lib/orchestration-risk.ts` measures how much a prime may borrow.
 * `LaborMarketV2.assignPayee` makes a claim on the parent escrow irrevocable.
 * Both shipped, and for a month neither was reachable from anything a person
 * could click: `advanceLimit` was called nowhere in the app, and every
 * reference to `assignPayee` outside the contract lived in a test file. The
 * headline claim — behaviour earns a score, the score unlocks borrowing — was
 * true of two components and false of the product.
 *
 * This module is the decision that joins them. It is pure: the collateral is
 * read from chain by the caller, the record from the credit ledger, and what
 * comes back is a quote or a named reason there isn't one.
 *
 * ## What is actually being lent against
 *
 * Not the borrower. A prime that has ACCEPTED an on-chain job is sitting on a
 * bounty that is already locked in escrow, and it needs cash *now* to escrow
 * the subcontractors that will earn it. The lender's exposure is therefore not
 * "will this agent repay" — it cannot choose not to, the assignment is
 * irrevocable — it is "will this job ever release at all". Execution risk, not
 * credit risk, which is why the LTV comes from orchestration history rather
 * than from the credit score.
 *
 * ## The three numbers
 *
 * - **advance** — what the borrower receives. Capped by `advanceLimit`.
 * - **fee** — what the lender earns for carrying execution risk.
 * - **pledge** — `advance + fee`, the `payeeAmount` written on chain.
 *
 * The pledge is the one the contract sees, and it is capped at the bounty. So
 * the fee is not free headroom: a bounty barely above the limit binds the
 * advance below it, because the fee has to fit inside the same escrow. Getting
 * that wrong produces a quote the chain then rejects — `BadPayeeAmount`, after
 * the borrower has been told yes.
 */
import type { V2JobStatus } from '@/lib/deadlines'
import { advanceLimit, orchestrationLtv, LTV_MAX, LTV_MIN, type OrchestrationRecord } from '@/lib/orchestration-risk'

/** A job the prime accepted, as the chain reports it. */
export type AdvanceCollateral = {
  jobId: number
  /** WHICH market. A jobId alone is not an identifier — every deployment
   *  restarts the counter, the defect `job_specs.onchainContract` exists for. */
  contract: string
  /** Locked in escrow, in USD. */
  bountyUsd: number
  /** The contract's own status word, from the shared enum rather than a
   *  hand-rolled union — the first draft of this omitted `Expired` and would
   *  have quoted against it as if it were just an unknown string. */
  status: V2JobStatus
  /** Unix ms. Past this an Accepted job is dead, not late. */
  deliveryDeadlineMs: number
  /** Zero address / null when nothing is pledged yet. */
  existingPayee: string | null
}

/**
 * How much runway a lien needs to be worth anything.
 *
 * The contract refuses `assignPayee` at or after `deliveryDeadline`, and that
 * is the correct place to draw a *validity* line. It is the wrong place to
 * draw a *lending* line: a perfected claim on a job with four minutes left is
 * valid, discloseable, and near-certainly worthless, because the work still
 * has to be done and submitted inside those four minutes. Quoting against it
 * would be technically accurate and substantively a lie.
 *
 * Thirty minutes is not a guess about how long work takes — it is the point
 * below which the lender is buying a lottery ticket rather than pricing a
 * risk, and the LTV was not built to price lottery tickets.
 */
export const MIN_RUNWAY_MS = 30 * 60 * 1000

/**
 * The fee band, per advance — NOT annualised, and the distinction matters.
 *
 * A delegation runs for hours. Expressing 6% over four hours as an APR
 * produces a number in the thousands that describes nothing anybody is
 * actually paying, and every reader who has seen payday-loan disclosure would
 * be right to distrust the page it appeared on. The fee is priced per advance
 * because the exposure is per advance: it ends when the job releases, whenever
 * that is.
 */
export const FEE_RATE_MIN = 0.02
export const FEE_RATE_MAX = 0.1

/**
 * Price per dollar advanced, off the same LTV that sized the advance.
 *
 * The two do different work and both are needed. LTV limits *how much* is
 * exposed; the fee prices *each dollar* of it. A cold-start prime at 0.5 LTV
 * has the lender carrying all of the execution risk on every dollar, so those
 * dollars cost more — while a prime at the 0.9 ceiling has five completed
 * delegations saying the escrow probably releases.
 *
 * Linear between the two ends of the LTV band, because a curve here would be
 * a claim about the shape of the risk that nothing in the data supports.
 */
export function feeRate(ltv: number): number {
  const span = LTV_MAX - LTV_MIN
  const position = span <= 0 ? 1 : (Math.min(LTV_MAX, Math.max(LTV_MIN, ltv)) - LTV_MIN) / span
  return Math.round((FEE_RATE_MAX - (FEE_RATE_MAX - FEE_RATE_MIN) * position) * 10000) / 10000
}

export type AdvanceRefusal =
  /** The prime never accepted this job, or already delivered it. Only an
   *  Accepted job has an escrow that has not yet chosen where it is going. */
  | 'not-accepted'
  /** Accepted, but past the delivery deadline: `submitWork` is closed and the
   *  only remaining transition pays the requester 100%. */
  | 'expired'
  /** Alive, but not for long enough to be worth securing. */
  | 'too-little-runway'
  /** One assignment per job, by contract. The first lender's claim is public
   *  precisely so the second one finds out here instead of at release. */
  | 'already-pledged'
  /** No escrow to attach to. */
  | 'no-collateral'
  /** The limit, or what the bounty can carry after the fee, rounded to zero. */
  | 'below-minimum'

/** Under a dollar there is nothing to lend: gas and the ledger row cost more
 *  than the advance, and a sub-cent pledge is noise on the chain. */
export const MIN_ADVANCE_USD = 1

export type AdvanceQuote = {
  ok: true
  /** Paid to the borrower. */
  advanceUsd: number
  /** Earned by the lender on release. */
  feeUsd: number
  /** `payeeAmount` on chain — what the lender is assigned. */
  pledgeUsd: number
  feeRate: number
  ltv: number
  /** What the borrower keeps of its own bounty once the lender is paid. */
  residualUsd: number
}

export type AdvanceRefused = { ok: false; reason: AdvanceRefusal }

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Quote an advance against an accepted job, or say why there isn't one.
 *
 * `requestedUsd` is what the borrower asked for; omit it for the maximum. A
 * request above what is available is not an error — it is quoted down, which
 * is what a lender does.
 */
export function quoteAdvance(input: {
  collateral: AdvanceCollateral
  record: OrchestrationRecord
  requestedUsd?: number
  now: number
}): AdvanceQuote | AdvanceRefused {
  const { collateral: c, record, now } = input

  if (c.status !== 'Accepted') return { ok: false, reason: 'not-accepted' }
  if (!Number.isFinite(c.bountyUsd) || c.bountyUsd <= 0) return { ok: false, reason: 'no-collateral' }
  if (c.existingPayee && !/^0x0{40}$/i.test(c.existingPayee)) return { ok: false, reason: 'already-pledged' }
  if (now >= c.deliveryDeadlineMs) return { ok: false, reason: 'expired' }
  if (c.deliveryDeadlineMs - now < MIN_RUNWAY_MS) return { ok: false, reason: 'too-little-runway' }

  const ltv = orchestrationLtv(record)
  const rate = feeRate(ltv)
  const byRecord = advanceLimit(c.bountyUsd, record)
  // The pledge is what the escrow must cover, so the bounty caps
  // advance + fee, not the advance alone. Solving `a * (1 + rate) <= bounty`
  // for `a` is the whole of it, and floor rather than round: a pledge one cent
  // over the bounty is `BadPayeeAmount` at the moment of truth.
  //
  // Under the constants as they stand this cap never actually binds — the
  // worst case is `LTV_MAX * (1 + feeRate(LTV_MAX))` = 0.918, comfortably
  // inside the escrow — and it is here anyway, with a test pinning that
  // headroom, because the two files that set those constants have no idea
  // about each other. Raise `LTV_MAX` toward 1 or lift `FEE_RATE_MIN` and the
  // product of the two crosses 1.0 silently; this is what stops that from
  // becoming a chain revert in front of a borrower who was already told yes.
  const byBounty = Math.floor((c.bountyUsd / (1 + rate)) * 100) / 100
  const available = Math.min(byRecord, byBounty)
  const requested = Number.isFinite(input.requestedUsd) ? Math.max(0, input.requestedUsd!) : available
  const advanceUsd = round2(Math.min(available, requested))

  if (advanceUsd < MIN_ADVANCE_USD) return { ok: false, reason: 'below-minimum' }

  // Ceil the fee so rounding never favours the borrower at the lender's
  // expense, then re-check the pledge: a ceil can be the cent that breaks it.
  const feeUsd = Math.ceil(advanceUsd * rate * 100) / 100
  const pledgeUsd = round2(advanceUsd + feeUsd)
  if (pledgeUsd > c.bountyUsd) {
    const shaved = round2(advanceUsd - 0.01)
    if (shaved < MIN_ADVANCE_USD) return { ok: false, reason: 'below-minimum' }
    return quoteAdvance({ ...input, requestedUsd: shaved })
  }

  return {
    ok: true,
    advanceUsd,
    feeUsd,
    pledgeUsd,
    feeRate: rate,
    ltv,
    residualUsd: round2(c.bountyUsd - pledgeUsd),
  }
}

export const REFUSAL_TEXT: Record<AdvanceRefusal, string> = {
  'not-accepted': 'Only a job this agent has accepted has escrow to lend against.',
  expired: 'The delivery deadline has passed — this escrow can now only return to the requester.',
  'too-little-runway': 'Too close to the delivery deadline to secure an advance against.',
  'already-pledged': 'This job already has a lender assigned. One assignment per job.',
  'no-collateral': 'This job has no bounty in escrow.',
  'below-minimum': `Nothing left to advance above the $${MIN_ADVANCE_USD} minimum.`,
}
