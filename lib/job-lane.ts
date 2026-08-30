/**
 * Which machine a job is supposed to run on.
 *
 * Two kinds of worker do fundamentally different work here, and until now
 * nothing said so:
 *
 *  - **local** — the owner's own machine, running `public/handsel-worker.mjs`.
 *    It pulls its own work (`/api/worker/poll`), so the platform spends
 *    nothing on it, and with `--workdir` it is the only worker that can open
 *    a file, run a test or produce a diff.
 *  - **handsel** — a runtime the PLATFORM drives: `cloud` and `mcp` agents
 *    dispatched from `fleetTick`, plus `platform` agents run on the
 *    platform's own key. Every one of those costs the platform an LLM call
 *    or an outbound request per job.
 *
 * With one undifferentiated pool, a platform-driven agent can and does claim
 * work a local worker was going to do for free. The platform pays for a job
 * whose whole point was that somebody else's computer would run it, and the
 * local worker — which is the only one that could have touched real source —
 * sits idle. That is the compute waste this exists to stop.
 *
 * `any` stays the default and the meaning of every job posted before this
 * existed: no lane declared, anyone may take it. The split only binds where
 * somebody actually asked for it.
 */

export type JobLane = 'local' | 'handsel' | 'any'

export const JOB_LANES: readonly JobLane[] = ['local', 'handsel', 'any']

/** The runtimes the platform pays to drive. `local` is absent on purpose —
 *  that is the whole distinction. */
const PLATFORM_DRIVEN = new Set(['platform', 'cloud', 'mcp', 'webhook'])

/** Normalize whatever a caller stored. Anything unrecognised — a null from a
 *  row written before this column existed, a typo, a future lane this build
 *  does not know — reads as `any`, which is the permissive default that
 *  keeps old jobs claimable. A stricter fallback would silently retire every
 *  job posted before this shipped. */
export function normalizeLane(raw: string | null | undefined): JobLane {
  return raw === 'local' || raw === 'handsel' ? raw : 'any'
}

/**
 * May a worker of this runtime take a job in this lane?
 *
 * The rule is deliberately symmetric. It is as wrong for a platform agent to
 * take a `local` job (the platform pays for work that was free, and cannot
 * touch the filesystem the job needs) as for a local worker to take a
 * `handsel` job it was never meant to serve.
 */
export function laneAcceptsRuntime(lane: JobLane, runtimeType: string | null | undefined): boolean {
  const runtime = runtimeType ?? 'platform'
  if (lane === 'any') return true
  if (lane === 'local') return runtime === 'local'
  return PLATFORM_DRIVEN.has(runtime)
}

/** One line for a human: why this worker cannot have this job. */
export function laneRefusalReason(lane: JobLane, runtimeType: string | null | undefined): string | null {
  if (laneAcceptsRuntime(lane, runtimeType)) return null
  return lane === 'local'
    ? 'This job runs on a local worker — it needs a machine with a working directory, not a platform runtime.'
    : 'This job runs on a platform runtime; a local worker cannot claim it.'
}
