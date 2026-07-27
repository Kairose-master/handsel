/**
 * Who gets sponsored gas, and how much.
 *
 * Every UserOperation this system sends is paid for by the operator's
 * paymaster. That was invisible on a testnet, where gas is free, and becomes
 * the operator's wallet on a real chain: sponsored gas is money spendable by
 * anyone who can cause an operation, and causing one costs an agent nothing.
 * It is the same shape as `docs/security-audit.md` F15 — "a paywall is a price,
 * not a rate limit" — with the price set to zero.
 *
 * **This is a real gate, not advice.** `ZERODEV_RPC` is server-side only, and
 * every sponsored operation funnels through `sendAgentCall`, so an agent has no
 * path to the paymaster that does not pass through here. A policy on the
 * ZeroDev project is still worth setting as a backstop — it is what protects
 * against a defect in this file — but it is the outer wall, not the only one.
 *
 * ## The allowance is earned, not granted
 *
 * A fresh agent gets enough to do a few jobs and no more. Beyond that,
 * sponsorship scales with **settled volume** — the same un-farmable quantity
 * the lending ceiling uses (`collateralizedVolume` in credit-engine/scoring).
 * So gas abuse is bounded by the same convergent maths as everything else: to
 * be sponsored a lot you must first have settled a lot, and settling requires
 * a counterparty who paid you, a grader who passed you, and a posting fee.
 *
 * Minting agents does not help. Each new agent starts at the cold-start
 * allowance, so N agents buy N × the free tier — linear, and each one costs an
 * account and a registration under the existing throttles. The alternative,
 * an unmetered paymaster, is unbounded.
 *
 * ## Counted in operations, not dollars
 *
 * The cost of an operation is not known until after it lands, and refusing
 * after the fact spends the money you were trying to protect. Operations are
 * countable before the fact. The conversion is `GAS_COST_PER_OP_USD`, which the
 * operator sets from an actual measurement on the target chain — `docs/v2-plan.md`
 * makes measuring one full job cycle a step for exactly this reason.
 *
 * Pure and unit-tested; the caller supplies the counts.
 */

/** Enough for roughly three full job cycles a day (post, accept, submit,
 *  approve) with headroom for a retry. An agent that cannot get started cannot
 *  earn its way to a larger allowance. */
export const FREE_OPS_PER_DAY = 12

/** Extra sponsored operations per dollar of settled volume. An agent that has
 *  settled $50 of real work gets 100 more, which is far more than that work
 *  itself consumed — sponsorship is meant to be comfortable for anyone actually
 *  trading, and only uncomfortable for something that is not. */
export const OPS_PER_SETTLED_USD = 2

/** Hard ceiling regardless of history. No single agent should be able to spend
 *  the whole gas budget, however good its record — a compromised well-behaved
 *  agent is a likelier failure than a badly-behaved new one. */
export const MAX_OPS_PER_DAY = 400

/** Testnet gets a larger allowance, but the SAME code path.
 *
 *  Disabling the gate off-mainnet would leave it exercised for the first time
 *  in the place it must not fail — which is the mistake this project already
 *  documented: a free resource cannot be audited, and the defect classes that
 *  only appear once a resource is scarce are exactly the ones nobody finds in
 *  testing. */
export const TESTNET_ALLOWANCE_MULTIPLIER = 10

export type AllowanceInput = {
  /** Settled volume in USD, discounted the way the lending ceiling discounts
   *  it. Zero for a new agent. */
  settledVolumeUsd: number
  isRealMoney: boolean
}

/** How many sponsored operations this agent may cause today. */
export function dailyOpAllowance(input: AllowanceInput): number {
  const volume = Number.isFinite(input.settledVolumeUsd) && input.settledVolumeUsd > 0 ? input.settledVolumeUsd : 0
  const earned = Math.floor(volume * OPS_PER_SETTLED_USD)
  const base = Math.min(MAX_OPS_PER_DAY, FREE_OPS_PER_DAY + earned)
  return input.isRealMoney ? base : base * TESTNET_ALLOWANCE_MULTIPLIER
}

export type GasDecision =
  | { allow: true; used: number; allowance: number; remaining: number }
  | { allow: false; used: number; allowance: number; remaining: 0; reason: string }

/**
 * Decide one operation.
 *
 * Fails CLOSED when the count is unknown. Elsewhere in this codebase an
 * unreadable value is treated as unknown rather than as zero
 * (`lib/onchain/labor-read.ts`), and the reasoning is the same here with the
 * opposite conclusion: there, an unknown must not authorise SPENDING; here, an
 * unknown usage count would authorise spending, so it must not be treated as
 * "nothing used yet".
 */
export function decideSponsoredOp(usedToday: number | null, allowance: number): GasDecision {
  if (usedToday === null || !Number.isFinite(usedToday)) {
    return {
      allow: false,
      used: 0,
      allowance,
      remaining: 0,
      reason:
        'Sponsored-gas usage could not be read, so this operation is refused. An unknown count cannot be treated as ' +
        'zero: that is the reading an attacker wants, and it is the one that spends the operator’s money.',
    }
  }
  const used = Math.max(0, usedToday)
  const remaining = allowance - used
  if (remaining <= 0) {
    return {
      allow: false,
      used,
      allowance,
      remaining: 0,
      reason:
        `This agent has used its ${allowance} sponsored operations for today. The allowance grows with settled ` +
        'volume, so the way to get a larger one is to complete paid work.',
    }
  }
  return { allow: true, used, allowance, remaining }
}

/** Sponsored operations an allowance is worth in dollars, for a diagnostics
 *  page. `perOpUsd` comes from a measurement on the target chain, not a guess —
 *  see docs/v2-plan.md. Null when it has not been measured. */
export function allowanceCostUsd(allowance: number, perOpUsd: number | null): number | null {
  if (perOpUsd === null || !Number.isFinite(perOpUsd) || perOpUsd < 0) return null
  return Math.round(allowance * perOpUsd * 100) / 100
}
