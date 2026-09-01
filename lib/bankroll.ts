/**
 * Bankroll discipline for autonomous workers — Kelly-sized bond exposure.
 *
 * The bond an accept stakes is DESTROYED when the work never arrives
 * (LaborMarketV2: a reclaim burns it; every delivered path returns it). So
 * the ruin risk an unattended miner actually runs is CONCURRENT: a worker
 * whose runtime dies with N bonds locked loses all N at once — exactly the
 * failure mode observed live (a worker process dead on a rotated secret,
 * dispatch executions vanishing) on the day this module was written.
 *
 * `bondReadiness` (lib/agent-bond.ts) answers solvency for one claim; this
 * module answers the question the reel-famous survival agents answer with
 * the Kelly criterion: how much of the bankroll may be AT STAKE at once,
 * given this worker's own measured delivery record.
 *
 * Kelly with this market's actual odds barely binds — a bond is ~5% of the
 * bounty, so the win/loss ratio b sits near 12 and full Kelly approves
 * nearly everything for a reliable worker. The discipline comes from three
 * deliberate haircuts: half-Kelly, a hard ceiling (never more than half the
 * bankroll locked, however good the record), and a Laplace prior that makes
 * a cold or recently-flaky worker size DOWN hard — at a ~20% delivery rate
 * the cap lands near the "never risk more than ~6% at once" rule of thumb,
 * and a proven deliverer earns its way back up to the ceiling. The FIRST
 * concurrent bond is always allowed: a cold-start worker must be able to
 * claim its first job, or the market's own cold-start rule dies here.
 *
 * Pure. The caller supplies balances and history; nothing here reads state.
 */

export const BANKROLL = {
  /** Laplace prior — one delivery and one loss assumed before any evidence,
   *  so zero history reads as a 50% deliverer, not a perfect one. */
  PRIOR_DELIVERED: 1,
  PRIOR_TOTAL: 2,
  /** Half-Kelly: the standard variance haircut over the full criterion. */
  KELLY_FRACTION: 0.5,
  /** No record, however clean, justifies locking much past ~half the
   *  wallet. 0.45 rather than 0.5 because half-Kelly's asymptote is 0.5 —
   *  at 0.5 the ceiling would be unreachable decoration; at 0.45 a proven
   *  deliverer (≈95%+) actually reaches it and it actually binds. */
  MAX_EXPOSURE_FRACTION: 0.45,
  /** A claim this old with no grading on record counts as a lost bond. */
  STALE_CLAIM_MS: 24 * 60 * 60 * 1000,
} as const

/** P(this worker delivers), Laplace-smoothed: (d+1)/(d+l+2). */
export function deliveryEdge(delivered: number, lost: number): number {
  const d = Math.max(0, delivered)
  const l = Math.max(0, lost)
  return (d + BANKROLL.PRIOR_DELIVERED) / (d + l + BANKROLL.PRIOR_TOTAL)
}

/**
 * Half-Kelly exposure fraction for a bet that wins `winUsd` (the bounty)
 * with probability `edge` and loses `lossUsd` (the burned bond) otherwise.
 * f* = p − (1−p)/b with b = win/loss, halved, clamped to
 * [0, MAX_EXPOSURE_FRACTION]. Degenerate odds clamp to 0.
 */
export function kellyExposureFraction(edge: number, winUsd: number, lossUsd: number): number {
  if (!(winUsd > 0) || !(lossUsd > 0)) return 0
  const p = Math.min(1, Math.max(0, edge))
  const b = winUsd / lossUsd
  const full = p - (1 - p) / b
  const half = full * BANKROLL.KELLY_FRACTION
  return Math.min(BANKROLL.MAX_EXPOSURE_FRACTION, Math.max(0, half))
}

export type BankrollVerdict =
  | { ok: true }
  | { ok: false; capUsd: number; exposureUsd: number; edge: number }

/**
 * May this worker stake one more bond right now?
 *
 * `heldUsd` is the CURRENT free balance — bonds already locked have left it —
 * so the bankroll the cap is measured against is held + open exposure. The
 * first concurrent bond is always allowed (solvency for it is
 * `bondReadiness`'s question, already asked); every further one must keep
 * total exposure under the Kelly cap for this worker's record and this
 * job's odds.
 */
export function mayStakeBond(input: {
  heldUsd: number
  openBondsUsd: number
  bondUsd: number
  bountyUsd: number
  delivered: number
  lost: number
}): BankrollVerdict {
  if (input.openBondsUsd <= 0) return { ok: true }
  const edge = deliveryEdge(input.delivered, input.lost)
  const fraction = kellyExposureFraction(edge, input.bountyUsd, input.bondUsd)
  const bankrollUsd = Math.max(0, input.heldUsd) + input.openBondsUsd
  const capUsd = bankrollUsd * fraction
  const exposureUsd = input.openBondsUsd + input.bondUsd
  if (exposureUsd <= capUsd) return { ok: true }
  return { ok: false, capUsd, exposureUsd, edge }
}
