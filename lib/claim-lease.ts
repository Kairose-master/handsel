/**
 * A claim is a renewable lease, not ownership.
 *
 * failure-modes §29: a pen plotter browned out mid-job four times, and jobs
 * #5–#8 are still `Accepted` with their escrow held, because **an accepted job
 * has no exit but the deadline**. The worker stopped existing and nothing
 * noticed. `reclaim_job` after the deadline is a correct backstop and a wrong
 * primary path — the operator waits out a timer for a failure that was obvious
 * in thirty seconds.
 *
 * The audit had already recorded this class as Critical (F1, testnet jobs
 * locked with no exit from `Accepted`), so this is not a plotter bug. It is a
 * missing protocol primitive:
 *
 *   claim = ownership   ->   claim = lease, renewed by a heartbeat
 *
 * ## The rule that shapes everything here
 *
 * **Silence is not evidence of fault.** A missing heartbeat tells you the
 * worker stopped reporting. It does not tell you they abandoned the job, and it
 * cannot distinguish a crashed process from a severed network from a malicious
 * walk-away — which is exactly the mistake §29 documents on the operator's side,
 * where three different error messages turned out to be one sagging battery.
 *
 * So this module can revoke a claim and it can never take money.
 * `lib/evidence-assurance.ts` says why: absence-of-heartbeat is a report by the
 * platform about the absence of rows in its own database, with no external
 * witness — `coverage` and `independence` both weak. That compiles below
 * `MIN_CLASS_FOR_MONEY`, so the permissible remedies are the reversible ones:
 *
 *   revoke the claim · relist the job · return the bond in full
 *   record a REPUTATION_NOTE · restrict how fast this worker may claim again
 *
 * A bond slash for a job the worker may simply have crashed on is a remedy on
 * an assertion, and the whole evidence apparatus exists to refuse it. If the
 * worker actually did something wrong, that is a dispute with its own grounds
 * and its own evidence class — not an inference from silence.
 *
 * ## Why returning the bond is not a free option
 *
 * Return it in full and claiming costs nothing, so a griefer claims everything
 * and abandons it — the `free-option` failure the booth's `classifyOperatorship`
 * already names, where nothing filters who takes the slot.
 *
 * The answer is not to charge money on weak evidence. It is that the
 * consequence lands where the evidence supports it: repeated abandonment is a
 * pattern in *our own* records about *our own* claims, which is precisely the
 * kind of fact a platform can attest to honestly. It buys a capability
 * restriction — fewer concurrent claims, a cooldown — which E1/E2 permits, and
 * never a transfer.
 *
 * ## On the constants below
 *
 * `enterprise-graph.ts` has a test that fails if a dollar constant appears, and
 * this file has three numbers in it. The distinction is real and worth stating
 * so the rule is not quietly weakened: those were **risk limits** presented as
 * if measured, which is a fabricated fact. These are **policy timeouts**. There
 * is no true value for "how long before we assume a silent worker is gone" —
 * any number is a choice, the choice is disclosed, and being wrong costs a
 * relist rather than someone's money.
 */

import type { EvidenceClass } from './evidence-assurance'

/** How long a claim survives without a heartbeat before it is at risk. */
export const LEASE_SECONDS = 15 * 60
/**
 * After the lease lapses, how long the worker still has to come back before the
 * claim is taken. A machine worker rebooting is the common case, not the
 * exception — §29's plotter needed roughly this long to reassociate.
 */
export const GRACE_SECONDS = 5 * 60
/** Abandonments before claiming is throttled. Below this, one is an accident. */
export const ABANDON_STREAK_FOR_RESTRICTION = 3

export type ClaimAction =
  /** Alive and reporting. */
  | 'hold'
  /** Lease lapsed, still inside grace. Ping the worker; do not take the claim. */
  | 'warn'
  /** Grace exhausted. Release the claim, relist the job, return the bond. */
  | 'revoke'
  /** Past the job's own deadline — the on-chain reclaim path owns this, not us. */
  | 'deadline'

export interface ClaimState {
  jobId: string
  worker: string
  acceptedAtSec: number
  /** Last time the worker reported. Absent means it never did. */
  lastHeartbeatSec?: number
  /** The job's on-chain deadline, if it has one. */
  deadlineSec?: number
}

export interface ClaimDecision {
  action: ClaimAction
  /** Seconds since the worker was last heard from. */
  silentForSec: number
  reason: string
  /**
   * Always false. Present so a caller that wants to slash has to read the
   * field and find out it cannot, rather than reaching for a bond transfer
   * that this module never authorises.
   */
  maySlashBond: false
  /** What the platform may honestly attest to on a revoke. */
  remedy?: 'REPUTATION_NOTE' | 'CAPABILITY_RESTRICTION'
}

/**
 * The evidence class of "this worker has not reported".
 *
 * The platform observing the absence of its own heartbeat rows is a
 * related-party report with no external witness and no way for a stranger to
 * re-derive it. It is not nothing — the rows are tamper-evident and the
 * platform gains nothing by lying about them — but it is nowhere near enough to
 * move money, and naming the class is how that stays true when someone later
 * wonders why revoke does not slash.
 */
export const SILENCE_EVIDENCE_CLASS: EvidenceClass = 'E1'

export function decideClaim(state: ClaimState, nowSec: number): ClaimDecision {
  const lastSeen = state.lastHeartbeatSec ?? state.acceptedAtSec
  const silentForSec = Math.max(0, nowSec - lastSeen)

  if (state.deadlineSec !== undefined && nowSec >= state.deadlineSec) {
    return {
      action: 'deadline',
      silentForSec,
      maySlashBond: false,
      reason:
        'past the job deadline — the on-chain reclaim path decides this, and duplicating it here would race the contract',
    }
  }

  if (silentForSec <= LEASE_SECONDS) {
    return { action: 'hold', silentForSec, maySlashBond: false, reason: 'lease is current' }
  }

  if (silentForSec <= LEASE_SECONDS + GRACE_SECONDS) {
    return {
      action: 'warn',
      silentForSec,
      maySlashBond: false,
      reason: `lease lapsed ${silentForSec - LEASE_SECONDS}s ago, still inside grace — a rebooting worker looks exactly like this`,
    }
  }

  return {
    action: 'revoke',
    silentForSec,
    maySlashBond: false,
    remedy: 'REPUTATION_NOTE',
    reason: `silent for ${silentForSec}s, past lease + grace — release the claim and relist; the bond returns in full because silence is ${SILENCE_EVIDENCE_CLASS} evidence and cannot support taking it`,
  }
}

/**
 * The one consequence weak evidence does support, applied to a *pattern* rather
 * than an incident.
 *
 * One abandonment is an accident and we say so by doing nothing. A streak is a
 * fact about our own claim records, which the platform can attest to honestly,
 * and it buys a restriction on how much of the board this worker may hold at
 * once — never a transfer.
 */
export function restrictionFor(abandonStreak: number): {
  remedy: 'NONE' | 'REPUTATION_NOTE' | 'CAPABILITY_RESTRICTION'
  maxConcurrentClaims: number
  reason: string
} {
  if (abandonStreak <= 0) {
    return { remedy: 'NONE', maxConcurrentClaims: Infinity, reason: 'no abandonments on record' }
  }
  if (abandonStreak < ABANDON_STREAK_FOR_RESTRICTION) {
    return {
      remedy: 'REPUTATION_NOTE',
      maxConcurrentClaims: Infinity,
      reason: `${abandonStreak} abandonment(s) — recorded, not acted on; a crash is not misconduct`,
    }
  }
  return {
    remedy: 'CAPABILITY_RESTRICTION',
    maxConcurrentClaims: 1,
    reason: `${abandonStreak} abandonments — one claim at a time until a job is delivered, so an unreliable worker cannot hold the board`,
  }
}
