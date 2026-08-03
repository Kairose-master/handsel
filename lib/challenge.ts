/**
 * State of the open challenge, derived from the chain.
 *
 * `docs/open-challenge.md` fixes the terms and says the marketing object is a
 * live page, not a blog post — showing "the current escrow balance and the
 * address holding it" and "days elapsed". Everything here is the derivation
 * behind that page, kept pure so the interesting states can be tested instead
 * of waited for.
 *
 * The prize is locked as a **self-to-self escrow**: a $100 job posted and
 * accepted by the operator's own agents, never submitted, so it sits
 * `Accepted` for the whole window. That shape is deliberate — it removes the
 * grader and the review timeout from the attack surface, leaving a contract
 * bug as the only way out.
 *
 * Which is also why this file exists rather than a hardcoded "$100 · locked".
 * Job **#2 was the first attempt and it reads `Refunded`**: the delivery
 * window lapsed and the escrow came back. A page that asserted the prize was
 * locked would have been advertising money that was no longer there. The
 * lapsed and settled states below are that failure, made renderable.
 */

/** The on-chain fields this module needs. A structural subset of `OnchainJob`
 *  (lib/onchain/labor.ts) so the logic is testable without a chain. */
export type ChallengeJobInput = {
  id: number
  status: string
  bounty: number
  deadline: number | null
  worker: string
}

/** Titles are off-chain (jobSpec); the chain only carries a spec hash. The
 *  page joins them by id, and this prefix is how a challenge escrow is
 *  recognised without pinning a job number into config that goes stale the
 *  first time the escrow is replaced. */
export const CHALLENGE_TITLE_PREFIX = 'OPEN CHALLENGE'

export function isChallengeTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && title.trimStart().toUpperCase().startsWith(CHALLENGE_TITLE_PREFIX)
}

/**
 * The challenge escrow, or null.
 *
 * Highest id wins, so replacing a lapsed escrow with a fresh one moves the
 * page over automatically — which is exactly what job #2 → #3 was.
 */
export function pickChallengeJob<T extends ChallengeJobInput>(
  jobs: T[],
  titleOf: (job: T) => string | null | undefined,
): T | null {
  const candidates = jobs.filter((j) => isChallengeTitle(titleOf(j)))
  if (candidates.length === 0) return null
  return candidates.reduce((best, j) => (j.id > best.id ? j : best))
}

export type ChallengeState =
  | { kind: 'none' }
  /** Accepted, deadline in the future — the money is locked and the clock runs. */
  | { kind: 'live'; jobId: number; prizeUsd: number; endsAt: number; daysElapsed: number; daysLeft: number }
  /** Accepted but past its deadline: reclaimable by anyone who calls it, so the
   *  prize is no longer reliably locked. Not the same as "still here". */
  | { kind: 'lapsed'; jobId: number; prizeUsd: number; endsAt: number; daysElapsed: number }
  /** Refunded, cancelled or completed — the escrow is gone. */
  | { kind: 'settled'; jobId: number; prizeUsd: number; status: string; taken: boolean }

/** The published window, from `docs/open-challenge.md` ("a $100 pot, a 30-day
 *  window"). A term, not a tunable: the page derives the start date from it and
 *  the chain's deadline, so changing it moves a date that was published before
 *  the challenge began. Lives here rather than in the server action because a
 *  `'use server'` module may only export async functions. */
export const CHALLENGE_WINDOW_DAYS = 30

const DAY = 86_400

/**
 * Classify the escrow.
 *
 * `startedAt` comes from the caller because the chain's `deadline` is the only
 * timestamp `OnchainJob` carries for an accepted job; the window length is a
 * published term, so the start is `deadline − window` rather than a second
 * source that could disagree with the first.
 *
 * `taken` on a settled job means `Completed`: the escrow paid out to a worker.
 * For a self-to-self challenge escrow that should never happen, and if it does
 * the page says so rather than rounding it to "the challenge ended".
 */
export function describeChallenge(
  job: ChallengeJobInput | null,
  nowSec: number,
  windowDays: number,
): ChallengeState {
  if (!job) return { kind: 'none' }

  if (job.status !== 'Accepted') {
    return {
      kind: 'settled',
      jobId: job.id,
      prizeUsd: job.bounty,
      status: job.status,
      taken: job.status === 'Completed',
    }
  }

  // An accepted job with no deadline is a V1 job — no window to reason about,
  // so it is not a live challenge no matter what its title says.
  if (job.deadline === null) return { kind: 'settled', jobId: job.id, prizeUsd: job.bounty, status: job.status, taken: false }

  const startedAt = job.deadline - windowDays * DAY
  const daysElapsed = Math.max(0, Math.floor((nowSec - startedAt) / DAY))

  if (nowSec >= job.deadline) {
    return { kind: 'lapsed', jobId: job.id, prizeUsd: job.bounty, endsAt: job.deadline, daysElapsed }
  }
  return {
    kind: 'live',
    jobId: job.id,
    prizeUsd: job.bounty,
    endsAt: job.deadline,
    daysElapsed,
    daysLeft: Math.ceil((job.deadline - nowSec) / DAY),
  }
}

/** The headline `docs/open-challenge.md` specifies, in the state the chain is
 *  actually in. Kept here so the two possible headlines the doc names — and
 *  the two it did not — are one switch rather than JSX branching. */
export function challengeHeadline(state: ChallengeState): string {
  switch (state.kind) {
    case 'live':
      return `$${state.prizeUsd}. Day ${state.daysElapsed}. Still here.`
    case 'lapsed':
      return `$${state.prizeUsd}. Day ${state.daysElapsed}. The window closed — escrow reclaimable.`
    case 'settled':
      return state.taken
        ? `$${state.prizeUsd} left the escrow.`
        : `No prize locked right now (job #${state.jobId} is ${state.status}).`
    case 'none':
      return 'No challenge escrow on chain.'
  }
}
