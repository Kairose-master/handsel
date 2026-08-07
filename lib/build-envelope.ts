/**
 * The budget envelope — the pure core of `docs/build-service.md`.
 *
 * "Give a goal and a budget. Get a graded deliverable. Failed attempts cost
 * you nothing — and that is enforced by escrow, not promised by us." The
 * envelope is the enforcement: every draw against a build's budget goes
 * through `decideBuildDraw` (`lib/decision-table.ts`), so "the sum of draws
 * can never exceed the budget" is one auditable rule, not scattered ifs.
 *
 * Everything here is pure and immutable — no DB, no chain, no clock. The
 * caller (the `/api/build` route) is responsible for persisting the returned
 * envelope after each operation and for the reserve-then-settle sequencing:
 * draw() BEFORE calling a money-moving primitive (e.g. `postRepoJob`), then
 * refund() immediately if that primitive throws — so a failed attempt to
 * spend never leaves the envelope showing money spent that never moved.
 *
 * Amounts are USDC base units (6 decimals) as decimal strings, matching the
 * convention in `lib/taskmarket-evaluator.ts` — BigInt arithmetic, never
 * floating point, on money.
 */

import { decideBuildDraw } from '@/lib/decision-table'

export interface BuildEnvelope {
  /** The total this build may ever spend. Fixed at open — never mutated. */
  budgetBaseUnits: string
  /** Currently reserved/spent against the budget. */
  drawnBaseUnits: string
  /** Returned to the requester so far — either a rejected draw's reservation
   *  being released, or the unspent remainder folded in at close(). */
  refundedBaseUnits: string
  closed: boolean
}

export type DrawResult =
  | { ok: true; envelope: BuildEnvelope }
  | { ok: false; reason: string; envelope: BuildEnvelope }

const UINT_RE = /^\d+$/

function assertBaseUnits(value: string, label: string): void {
  if (!UINT_RE.test(value)) throw new Error(`${label} must be a non-negative integer string of base units, got ${JSON.stringify(value)}`)
}

/** Open a new envelope. Refuses a non-positive budget — an envelope with
 *  nothing to spend is a build that can never draw, which is a configuration
 *  error at the caller, not a build with zero-value semantics. */
export function openEnvelope(budgetBaseUnits: string): BuildEnvelope {
  assertBaseUnits(budgetBaseUnits, 'budgetBaseUnits')
  if (budgetBaseUnits === '0') throw new Error('budgetBaseUnits must be positive — a zero-budget build cannot draw anything')
  return { budgetBaseUnits, drawnBaseUnits: '0', refundedBaseUnits: '0', closed: false }
}

/** What remains available to draw: budget minus what is currently drawn. A
 *  refund reduces drawnBaseUnits, so it DOES restore headroom here — "a
 *  failed or expired subtask's escrow returns to the envelope" is the exact
 *  line in docs/build-service.md, and this is what makes it literal: a build
 *  with one failed $10 subtask and $90 left can still fund a $95 retry
 *  against the freed $10 plus what was never drawn, not just what was never
 *  drawn. What refunds do NOT do is inflate the budget itself — the ceiling
 *  in closeEnvelope() is always budgetBaseUnits, refunded or not. */
export function remaining(envelope: BuildEnvelope): string {
  return (BigInt(envelope.budgetBaseUnits) - BigInt(envelope.drawnBaseUnits)).toString()
}

/**
 * Reserve `amountBaseUnits` against the envelope. Call this BEFORE the
 * money-moving primitive it funds, never after — a draw recorded post-hoc
 * cannot bound anything, it can only describe what already happened.
 *
 * Returns `{ ok: false }` rather than throwing on a rejected draw, because
 * "the budget is exhausted" is a normal outcome an `/api/build` handler must
 * branch on (reject the subtask, not crash the request).
 */
export function draw(envelope: BuildEnvelope, amountBaseUnits: string): DrawResult {
  const gate = decideBuildDraw({
    closed: envelope.closed,
    amountBaseUnits,
    remainingBaseUnits: envelope.closed ? '0' : remaining(envelope),
  })
  if (gate.decision === 'reject') {
    return { ok: false, reason: gate.reason, envelope }
  }
  return {
    ok: true,
    envelope: { ...envelope, drawnBaseUnits: (BigInt(envelope.drawnBaseUnits) + BigInt(amountBaseUnits)).toString() },
  }
}

/**
 * Release a previously drawn amount back to the requester — a subtask that
 * failed grading, a money-moving primitive that threw after the draw was
 * reserved, or a build cancelled mid-flight. Refuses to refund more than is
 * currently drawn: a refund is un-reserving a specific draw, not a second
 * credit line.
 */
export function refund(envelope: BuildEnvelope, amountBaseUnits: string): BuildEnvelope {
  assertBaseUnits(amountBaseUnits, 'amountBaseUnits')
  if (BigInt(amountBaseUnits) > BigInt(envelope.drawnBaseUnits)) {
    throw new Error(`cannot refund ${amountBaseUnits} — only ${envelope.drawnBaseUnits} is currently drawn`)
  }
  return {
    ...envelope,
    drawnBaseUnits: (BigInt(envelope.drawnBaseUnits) - BigInt(amountBaseUnits)).toString(),
    refundedBaseUnits: (BigInt(envelope.refundedBaseUnits) + BigInt(amountBaseUnits)).toString(),
  }
}

export interface ClosedEnvelope {
  envelope: BuildEnvelope
  /** What actually stayed drawn — the number a manifest reports as "spent". */
  spentBaseUnits: string
  /** refundedBaseUnits at close, INCLUDING whatever unspent remainder this
   *  call folds in — the number a manifest reports as "refunded". */
  refundedBaseUnits: string
}

/**
 * Close the envelope: whatever is still drawn is final spend, and whatever
 * remains unspent returns to the requester. Idempotent — closing an
 * already-closed envelope returns the same totals rather than double-folding
 * the remainder into refunded.
 *
 * "Partial success is first-class... the sum is a completed build, not a
 * failure state" (docs/build-service.md) — this is the function that makes
 * that literal: it always succeeds, whether drawn is 0, the full budget, or
 * anything between.
 */
export function closeEnvelope(envelope: BuildEnvelope): ClosedEnvelope {
  if (envelope.closed) {
    return { envelope, spentBaseUnits: envelope.drawnBaseUnits, refundedBaseUnits: envelope.refundedBaseUnits }
  }
  const leftover = remaining(envelope)
  const closed: BuildEnvelope = {
    ...envelope,
    refundedBaseUnits: (BigInt(envelope.refundedBaseUnits) + BigInt(leftover)).toString(),
    closed: true,
  }
  return { envelope: closed, spentBaseUnits: closed.drawnBaseUnits, refundedBaseUnits: closed.refundedBaseUnits }
}
