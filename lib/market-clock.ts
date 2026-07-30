/**
 * How fast this market must move, in one place.
 *
 * The contract measures time in windows. The sweeps that act when a window
 * closes run on a schedule. Nothing connected the two, so the numbers were
 * chosen independently and were free to disagree — and they did, by 8-10x:
 *
 *   smallest window on the live contract   600s   (10 minutes)
 *   backstop that calls the exits        ~6000s   (80-100 minutes, measured)
 *
 * The consequence is not "settlement is slow". It is that a job can sit in a
 * money-holding state for an entire multiple of its own window with nothing
 * coming to settle it. Observed: job #1's open window closed and its 0.13 USDC
 * stayed locked for 112 minutes, until a request happened to arrive. That is
 * squarely inside the band above.
 *
 * The fix is not to pick better numbers. It is to state the relationship the
 * numbers have to satisfy, and let a test enforce it — so that changing a window
 * tells you what else must change. `tests/market-clock.test.ts` applies this to
 * the repo's own constants and to the deploy script's defaults.
 */

/**
 * What actually calls the permissionless exits, and how often, worst case.
 *
 * Three things drive the sweeps, and only the slowest one is a guarantee:
 *
 *   traffic tick       300s   `maybeRunTrafficTick` from /api/tasks — but it
 *                             requires a visitor, so an idle market gets none.
 *   GitHub heartbeat  ~6000s  settle-heartbeat.yml requests every 5 min (300s).
 *                             GitHub treats `schedule:` as best-effort and
 *                             delivers it every 80-100 minutes in practice; the
 *                             workflow's own comments say so.
 *   Vercel cron       86400s  vercel.json, once a day. The true floor.
 *
 * `BACKSTOP_INTERVAL_S` is the heartbeat, not the traffic tick and not the cron:
 * the traffic tick cannot be relied on (no visitor, no upkeep) and the daily cron
 * is the thing the heartbeat exists to improve on. Using the traffic tick here
 * would be assuming the market is busy in order to prove it settles — which is
 * exactly backwards, since staleness only matters when nobody is looking.
 */
export const BACKSTOP_INTERVAL_S = 100 * 60

/**
 * How many backstop passes must fit inside a window.
 *
 * Two, not one. At one, a window and a sweep interval of the same length means
 * the sweep is expected to land in the instant the window closes, and any
 * jitter — which GitHub's scheduler has in abundance — pushes settlement into
 * the next pass. Two gives a missed pass room to be caught by the next one.
 */
export const PASSES_PER_WINDOW = 2

/** The shortest a window may be, given who is coming to settle it. */
export function minimumWindowS(backstopS: number = BACKSTOP_INTERVAL_S): number {
  return backstopS * PASSES_PER_WINDOW
}

export type WindowCheck = {
  name: string
  seconds: number
  ok: boolean
  /** What it would have to be, when it is too short. */
  requiredS: number
}

/**
 * Check every window a job can WAIT in against the backstop.
 *
 * Only waiting windows belong here. A bound like `maxDeliveryWindow` is a
 * ceiling on what a requester may ask for, not a duration anything waits
 * through, so it is not subject to this rule — but the DEFAULT a caller sends
 * when it does not choose IS, because that is the value real jobs get.
 */
export function checkWindows(windows: Record<string, number>): WindowCheck[] {
  const required = minimumWindowS()
  return Object.entries(windows).map(([name, seconds]) => ({
    name,
    seconds,
    ok: seconds >= required,
    requiredS: required,
  }))
}

/** The ones that violate it, for a message worth reading. */
export function tooShort(checks: WindowCheck[]): WindowCheck[] {
  return checks.filter((c) => !c.ok)
}

/**
 * A sentence an operator can act on.
 *
 * Deliberately names both sides. "delivery window too short" invites someone to
 * raise the window; the real choice is between raising the window and making the
 * backstop faster, and a message that hides one of them makes the decision for
 * the reader.
 */
export function explain(checks: WindowCheck[]): string {
  const bad = tooShort(checks)
  if (bad.length === 0) return 'all windows outlast the backstop'
  const lines = bad.map(
    (c) =>
      `  ${c.name}: ${c.seconds}s — needs >= ${c.requiredS}s ` +
      `(${PASSES_PER_WINDOW} passes of a ${BACKSTOP_INTERVAL_S}s backstop)`,
  )
  return (
    `${bad.length} window(s) can close before anything comes to settle them:\n` +
    `${lines.join('\n')}\n` +
    `Either raise these windows, or make the backstop faster than ` +
    `${Math.floor(Math.min(...bad.map((c) => c.seconds)) / PASSES_PER_WINDOW)}s ` +
    `(a Vercel cron at minute granularity, or an external pinger — GitHub's ` +
    `scheduler will not hold a tighter cadence than ${BACKSTOP_INTERVAL_S}s).`
  )
}
