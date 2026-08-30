/**
 * Can this agent actually DO this job — before it stakes anything on it?
 *
 * Accepting a job on the V2 market is not free and not reversible on a whim:
 * it pulls a USDC bond out of the worker's own account, spends gas, takes the
 * work unit off the board so nobody else does it, and then burns however much
 * compute the run costs. A claim the agent was never able to complete costs
 * all of that and returns a failed grading, a bond at risk and a credit
 * score dent — and the operator learns about it afterwards, from `my_work`.
 *
 * The eligibility rules in lib/mining-scheduler.ts already refuse what the
 * CONTRACT would refuse: too low a score, an unaffordable bond, a self-deal,
 * a lane for another machine. Those are all "this transaction would revert".
 * This module answers the different question — the transaction would succeed
 * and the work would still not get done:
 *
 *   · the local worker that is supposed to do it has been offline for an hour
 *   · it is a repo job and this account has no access to that repository
 *   · the deadline is shorter than anything this agent has ever finished in
 *   · this agent has failed the last three jobs of exactly this shape
 *
 * ── Two rules the whole file obeys ────────────────────────────────────────
 *
 * 1. UNKNOWN NEVER BLOCKS. Every fact arrives with an explicit "unknown",
 *    and unknown is always treated as permission to proceed. A probe that
 *    cannot answer must not be the thing that stops a working agent from
 *    earning — the same posture as the gas and bond preflights, and the
 *    reason `repoAccess: 'unknown'` reads as allow rather than deny.
 *
 * 2. HARD CHECKS BIND EVERYONE; SOFT CHECKS BIND ONLY AUTONOMOUS CLAIMS.
 *    An offline worker or a missing repository permission is a certainty —
 *    nobody should claim into it, owner included. A tight deadline or a run
 *    of recent failures is a JUDGEMENT, and an owner is entitled to make it
 *    for themselves. An auto-mine worker is not entitled to make it with the
 *    owner's bond, so for autonomous claims a soft check refuses too. Manual
 *    claims get the same finding back as a warning.
 *
 * Pure. Every fact is injected, so the rules that decide what an autonomous
 * agent may spend money on are testable without a database or a chain.
 */

import { jobClassOf } from '@/lib/market-price'

/** How the runtime that would actually do the work is doing. */
export type Liveness =
  /** Heartbeat current, or a push runtime that needs none. */
  | 'ready'
  /** Late but inside the grace window — see lib/worker-fleet.ts. */
  | 'stale'
  /** Nothing is there to run the job. */
  | 'offline'
  | 'unknown'

export type RepoAccess = 'granted' | 'denied' | 'not-applicable' | 'unknown'

/** How many of this agent's own graded jobs of one shape went which way, and
 *  when the most recent failure was. Derived per claim; nothing is stored. */
export type ClassHistory = {
  jobClass: string
  graded: number
  failed: number
  /** Epoch ms of the most recent failing verdict in this class. */
  lastFailedAt: number | null
}

export type ClaimFacts = {
  /** Wall clock, ms. */
  now: number
  /** True for auto-mine and the dispatch sweeps; false when a person clicked
   *  claim or called claim_job themselves. Decides whether the soft checks
   *  refuse or merely warn. */
  autonomous: boolean

  liveness: Liveness
  /** Seconds since the last heartbeat, when there is one — quoted in the
   *  refusal so "offline" is a measurement rather than an accusation. */
  heartbeatAgeSec: number | null

  /** Does this worker declare what the job needs? (lib/artifacts.ts) */
  canDeliver: boolean
  deliverableKind: string
  /** The specific ones it is missing, for a refusal that says what to fix. */
  missingCapabilities: string[]

  repoAccess: RepoAccess
  repoFullName: string | null

  /** The governing on-chain deadline, unix SECONDS. Null on a market with no
   *  deadlines (V1), which is unknown, which does not block. */
  deadlineSec: number | null
  /** This agent's own observed median claim→graded time, seconds. Null until
   *  it has enough finished jobs to have a median at all. */
  medianTurnaroundSec: number | null

  /** Null when this agent has never been graded on a job of this shape. */
  classHistory: ClassHistory | null
}

export type FitnessCode = 'runtime-offline' | 'capability' | 'repo-access' | 'deadline' | 'cooldown'

export type FitnessFinding = {
  code: FitnessCode
  /** Hard findings refuse every claim; soft findings refuse only autonomous
   *  ones, and come back as warnings on a manual claim. */
  hard: boolean
  /** Operator-readable, and carrying the evidence it was decided on. */
  reason: string
  /** For a finding that lifts by itself, when. Epoch ms. */
  clearsAt?: number
}

export type FitnessVerdict = {
  /** May this claim proceed? */
  ok: boolean
  /** Everything found, whether or not it blocked. A manual claim that
   *  proceeds still gets its warnings. */
  findings: FitnessFinding[]
  /** The one that stopped it, when something did. */
  blocked: FitnessFinding | null
}

/**
 * How much slack a deadline needs over this agent's own median.
 *
 * 1.5, not 1.0: a median means half its runs were slower than that, so a
 * deadline equal to the median is a coin flip on an escrow. And not higher,
 * because turnaround here includes the platform's own grading queue, which is
 * not the agent being slow.
 */
export const DEADLINE_SAFETY = 1.5

/** Below this many finished jobs there is no median worth calling one, so
 *  the deadline check does not run. A cold-start agent must be able to take
 *  its first job. */
export const MIN_TURNAROUND_SAMPLES = 3

/** The recent-failure window, and how much of it has to have failed. Three
 *  of the last four is a pattern; two of two is a bad afternoon. */
export const FAILURE_WINDOW = 4
export const FAILURE_THRESHOLD = 3

/**
 * How long a class cooldown lasts.
 *
 * A cooldown, never a ban: the point is to stop a worker burning bonds in a
 * loop on work it currently cannot do, not to disqualify it forever. It also
 * lifts on its own with no operator action, because the alternative is a
 * state only a human can leave, which this repo calls limbo rather than a
 * queue.
 */
export const COOLDOWN_MS = 6 * 60 * 60 * 1000

/** Is a run of recent failures bad enough to sit this class out, and until
 *  when? Pure so the rule that stops an agent earning is inspectable. */
export function cooldownUntil(history: ClassHistory | null): number | null {
  if (!history || history.lastFailedAt === null) return null
  // Only the recent window counts. An agent with 40 graded jobs and 3 old
  // failures is not in trouble; one whose last four all failed is.
  const considered = Math.min(history.graded, FAILURE_WINDOW)
  if (considered < FAILURE_THRESHOLD) return null
  if (history.failed < FAILURE_THRESHOLD) return null
  return history.lastFailedAt + COOLDOWN_MS
}

/** A duration an operator can act on. Coarse on purpose — the exact second
 *  is noise in a sentence whose point is "this is not enough time". */
function duration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${Math.round((sec / 3600) * 10) / 10}h`
}

/**
 * The whole decision.
 *
 * Order is deliberate: the most certain and cheapest-to-explain findings
 * come first, so the reason an operator reads is the most actionable one
 * rather than whichever check happened to be written first.
 */
export function assessClaim(facts: ClaimFacts): FitnessVerdict {
  const findings: FitnessFinding[] = []

  // ── Hard: the runtime is not there ──────────────────────────────────────
  // Claiming with nothing running does not fail fast. It takes the work off
  // the board and holds the escrow until the deadline expires, which is the
  // most expensive way for a job to go wrong for everyone involved.
  if (facts.liveness === 'offline') {
    const age = facts.heartbeatAgeSec === null ? 'never' : `${duration(facts.heartbeatAgeSec)} ago`
    findings.push({
      code: 'runtime-offline',
      hard: true,
      reason: `The worker that would do this job is offline (last heartbeat: ${age}). A claim it cannot run holds the escrow until the deadline expires.`,
    })
  }

  // ── Hard: it cannot produce what was asked for ──────────────────────────
  if (!facts.canDeliver) {
    const missing = facts.missingCapabilities.length
      ? ` It is missing: ${facts.missingCapabilities.join(', ')}.`
      : ''
    findings.push({
      code: 'capability',
      hard: true,
      reason: `This job needs a ${facts.deliverableKind} deliverable and this agent does not declare that capability.${missing}`,
    })
  }

  // ── Hard: no permission on the repository the job is about ──────────────
  // The clearest case of "the transaction would succeed and the work still
  // could not happen": the run starts, cannot read the repo, and produces a
  // deliverable about a codebase it never saw.
  if (facts.repoAccess === 'denied') {
    findings.push({
      code: 'repo-access',
      hard: true,
      reason: `This is a repo job on ${facts.repoFullName ?? 'a repository'} and this account has no access to it. Connect it under Settings → GitHub, or grant the app that repository.`,
    })
  }

  // ── Soft: the deadline is shorter than this agent has ever managed ──────
  if (facts.deadlineSec !== null && facts.medianTurnaroundSec !== null) {
    const remainingSec = facts.deadlineSec - Math.floor(facts.now / 1000)
    const needed = facts.medianTurnaroundSec * DEADLINE_SAFETY
    if (remainingSec < needed) {
      findings.push({
        code: 'deadline',
        hard: false,
        reason: `Only ${duration(Math.max(0, remainingSec))} left on this job, and this agent's own median is ${duration(facts.medianTurnaroundSec)} claim-to-graded. Claiming it most likely stakes the bond on a job that expires unfinished.`,
      })
    }
  }

  // ── Soft: it keeps failing exactly this kind of work ────────────────────
  const until = cooldownUntil(facts.classHistory)
  if (until !== null && until > facts.now && facts.classHistory) {
    const h = facts.classHistory
    findings.push({
      code: 'cooldown',
      hard: false,
      clearsAt: until,
      reason: `This agent failed ${h.failed} of its last ${Math.min(h.graded, FAILURE_WINDOW)} graded "${h.jobClass}" jobs. Sitting the class out until ${new Date(until).toISOString()} rather than staking another bond on it — nothing else is required to clear it.`,
    })
  }

  const blocked = findings.find((f) => f.hard || facts.autonomous) ?? null
  return { ok: blocked === null, findings, blocked }
}

/** The job class a spec belongs to, for the failure history. Same classifier
 *  the market uses for prices, so "this kind of job" means one thing in this
 *  codebase rather than two. */
export function claimJobClass(spec: { title?: string | null; deliverableKind?: string | null }): string {
  return jobClassOf(spec.title, spec.deliverableKind)
}

/** One line for a log or a tool response. */
export function fitnessSummary(verdict: FitnessVerdict): string {
  if (verdict.ok && verdict.findings.length === 0) return 'fit to claim'
  const lead = verdict.blocked ? verdict.blocked.reason : verdict.findings[0]?.reason ?? 'fit to claim'
  const others = verdict.findings.length - 1
  return others > 0 ? `${lead} (+${others} more)` : lead
}
