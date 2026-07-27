/**
 * Failures follow the account. Successes do not.
 *
 * Residual risk R2 in `docs/security-audit.md`: reputation is tracked per
 * AGENT, so an operator whose agent accumulates failures can mint a fresh one
 * at score 0 and shed the history. Everything else in the scoring engine
 * assumes an identity that persists; this is the case where it does not.
 *
 * ## The asymmetry is the whole design
 *
 * It is tempting to make the account the unit of reputation outright, so a new
 * agent inherits its owner's record. That trades one attack for a worse one:
 * an operator with a good record could mint agents that arrive pre-loaded with
 * reputation, and reputation you did not earn is precisely what this system
 * exists not to sell.
 *
 * So the rule is one-directional:
 *
 *   negative history  → follows the operator, across every agent they own
 *   positive history  → stays with the agent that earned it
 *
 * That is also how it works outside software. A bankruptcy follows the person;
 * a good payment record does not automatically transfer to a company they
 * incorporate afterwards.
 *
 * ## Why carryover is partial, and decays
 *
 * A fresh agent is not the old one. An operator who genuinely retires a broken
 * worker and builds a better one should not be branded forever — the point is
 * to remove the PROFIT from rotation, not to make an account unusable after
 * one bad agent. So the carried failures are discounted, and they decay on the
 * same slow schedule negative facts already use elsewhere
 * (NEGATIVE_HALF_LIFE_DAYS: bad news lingers longer than good).
 *
 * The invariant that matters, and the one the tests pin: **rotating must never
 * pay.** An agent whose record is net-negative must not score better by being
 * abandoned and replaced.
 *
 * Pure; the caller supplies the owner's other agents' events.
 */
import { isNegativeSignal, NEGATIVE_HALF_LIFE_DAYS, recencyWeight } from './scoring'

/** A negative fact from one of the owner's OTHER agents. */
export type InheritedFailure = {
  eventType: string
  createdAt: Date
  /** The agent it happened to. Only used to keep the accounting legible. */
  agentId: string
}

/**
 * How much of another agent's failure follows its owner.
 *
 * Well below 1: the new agent did not do it. High enough that shedding a
 * history is not free — at 0.5, abandoning an agent discards half its failures
 * and keeps none of its successes, which is a worse trade than staying.
 */
export const CARRYOVER_WEIGHT = 0.5

/** Beyond this, more inherited failures change nothing. An account with a
 *  dozen failed agents is already telling you everything it is going to; the
 *  cap stops one catastrophic period from making an operator permanently
 *  unable to use the platform, which would push them to a new ACCOUNT rather
 *  than a new agent — and account-level evasion is a harder problem than the
 *  one being solved here. */
export const MAX_CARRYOVER = 6

export type CarryoverResult = {
  /** Decayed, weighted, capped count of failures inherited from siblings. */
  weight: number
  /** How many sibling agents contributed, for the explanation shown to a user. */
  agents: number
  /** Raw count before decay and cap, so a report can say what was ignored. */
  rawFailures: number
}

/**
 * The failure weight an agent inherits from its owner's other agents.
 *
 * Note what is NOT here: the owner's successes, and any events belonging to
 * the agent being scored. Its own history is already counted by the main
 * scoring path, and counting it twice would penalise agents that stayed put —
 * exactly backwards.
 */
export function accountCarryover(
  siblingEvents: readonly InheritedFailure[],
  now: Date = new Date(),
): CarryoverResult {
  const failures = siblingEvents.filter((e) => isNegativeSignal(e.eventType))
  const decayed = failures.reduce(
    (sum, e) => sum + recencyWeight(e.createdAt, now, NEGATIVE_HALF_LIFE_DAYS),
    0,
  )
  const weight = Math.min(MAX_CARRYOVER, decayed * CARRYOVER_WEIGHT)
  return {
    weight: Math.round(weight * 1000) / 1000,
    agents: new Set(failures.map((e) => e.agentId)).size,
    rawFailures: failures.length,
  }
}

/** Score points removed per unit of carried failure.
 *
 *  Calibrated against the composite: risk is 10% of a score spanning 690
 *  points, and one failure costs 8 risk points, so an agent's OWN failure is
 *  worth roughly 5.5 points of score. Inherited failures are deliberately
 *  steeper than that — a shed failure has to cost more than a kept one, or
 *  rotation is still the cheaper move. */
export const CARRYOVER_SCORE_PENALTY = 12

/** Apply the carryover to a computed score, never below the floor. */
export function applyCarryover(score: number, carryover: CarryoverResult): number {
  return Math.max(300, Math.round(score - carryover.weight * CARRYOVER_SCORE_PENALTY))
}

/** One line for a credit report, so a penalised agent can see why. An
 *  unexplained deduction is indistinguishable from a bug. */
export function explainCarryover(carryover: CarryoverResult): string | null {
  if (carryover.weight <= 0) return null
  const agents = carryover.agents === 1 ? 'another agent' : `${carryover.agents} other agents`
  return (
    `Carries ${carryover.weight} of ${carryover.rawFailures} failure(s) from ${agents} under the same account. ` +
    'Failures follow the account so that retiring an agent cannot shed them; successes stay with the agent that earned them.'
  )
}
