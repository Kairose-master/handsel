/**
 * Skill evaluation — does an agent's graded pass rate look different after
 * a skill was installed? Measured from real settled outcomes only, and
 * worded as carefully as it is computed.
 *
 * What this IS: a before/after comparison of the agent's independently
 * graded outcomes (the exact event set lib/platform-index.ts,
 * lib/agent-stats.ts, lib/market-health.ts and the worker console already
 * agree on: JOB_TESTS_PASSED / VERIFIED_TASK_COMPLETED count as pass,
 * JOB_TESTS_FAILED / VERIFIED_TASK_FAILED as fail), split at the skill's
 * install time, with the delta withheld until BOTH windows carry a
 * minimum number of graded outcomes. Raw counts are always shown — a
 * small sample is a fact worth seeing; only the comparison is gated.
 *
 * What this is NOT, stated because the words matter more than the math:
 *
 *  - **Not causation.** The delta is a correlation across time. The agent
 *    may also have changed connector, role, or job mix in the same
 *    window; nothing here controls for that, and no verdict string in
 *    this module says "improved" or "worsened" — it says `measured`, and
 *    the numbers speak with their sample sizes attached.
 *  - **Not per-skill attribution when installs overlap.** Two skills
 *    installed a week apart share most of their after-window; each row's
 *    "after" simply means "after THIS skill's install", and concurrent
 *    installs are confounded by construction. The UI carries this caveat
 *    next to the numbers, not in a footnote nobody reads.
 *  - **Not wired into credit scoring.** Display only. The credit engine
 *    prices real settled behavior; letting a correlational skill delta
 *    move a score would launder a guess into a number people lend
 *    against.
 *
 * A reinstall moves installed_at forward (lib/agent-skills.ts upserts it),
 * which resets the split point — correct on purpose: the reinstalled
 * document is a new treatment, and mixing old-document outcomes into its
 * "after" window would credit it with history it didn't touch.
 *
 * JOB_COMPLETED is deliberately absent: it records payment, not a graded
 * verdict, and it has no symmetric failure event — using it would count
 * only wins. Same reasoning the Labor Index already applies.
 */

export const GRADED_PASS_EVENTS = ['JOB_TESTS_PASSED', 'VERIFIED_TASK_COMPLETED'] as const
export const GRADED_FAIL_EVENTS = ['JOB_TESTS_FAILED', 'VERIFIED_TASK_FAILED'] as const
export const GRADED_EVENTS = [...GRADED_PASS_EVENTS, ...GRADED_FAIL_EVENTS] as const

/** Minimum graded outcomes PER WINDOW before a delta is stated. Small on
 *  purpose — this gates showing a comparison, not changing any behavior
 *  (the factory's 20+ rule is for rule changes; nothing here changes a
 *  rule). Counts are always shown regardless. */
export const MIN_GRADED_PER_WINDOW = 5

export type GradedOutcome = { at: Date; passed: boolean }

export type WindowStats = {
  passed: number
  total: number
  /** null when total is 0 — an empty window has no rate, not a 0% one. */
  rate: number | null
}

export type SkillEvalVerdict = 'measured' | 'insufficient-before' | 'insufficient-after' | 'insufficient-both'

export type SkillEval = {
  before: WindowStats
  after: WindowStats
  /** Percentage-point delta (after − before), present only when verdict is
   *  'measured'. Sign interpretation is the reader's, with the caveats in
   *  this module's header attached wherever this renders. */
  deltaPoints: number | null
  verdict: SkillEvalVerdict
  minPerWindow: number
}

function windowStats(outcomes: readonly GradedOutcome[]): WindowStats {
  const total = outcomes.length
  const passed = outcomes.filter((o) => o.passed).length
  return { passed, total, rate: total === 0 ? null : passed / total }
}

/**
 * Split graded outcomes at the install time and compare. Pure and total;
 * input order is irrelevant. An outcome stamped exactly at installedAt
 * counts as AFTER — the install precedes any work dispatched from that
 * instant on, and the skill document is in the brief for it.
 */
export function evaluateSkillWindows(
  installedAt: Date,
  outcomes: readonly GradedOutcome[],
  opts: { minPerWindow?: number } = {},
): SkillEval {
  const min = opts.minPerWindow ?? MIN_GRADED_PER_WINDOW
  const before = windowStats(outcomes.filter((o) => o.at.getTime() < installedAt.getTime()))
  const after = windowStats(outcomes.filter((o) => o.at.getTime() >= installedAt.getTime()))

  const beforeShort = before.total < min
  const afterShort = after.total < min
  const verdict: SkillEvalVerdict =
    beforeShort && afterShort ? 'insufficient-both' : beforeShort ? 'insufficient-before' : afterShort ? 'insufficient-after' : 'measured'

  const deltaPoints =
    verdict === 'measured' && before.rate !== null && after.rate !== null
      ? Math.round((after.rate - before.rate) * 1000) / 10
      : null

  return { before, after, deltaPoints, verdict, minPerWindow: min }
}

/** Map a stored event type to a graded outcome, or null for anything
 *  outside the graded set — kept here so the server-side gather and any
 *  future caller classify identically. */
export function gradedOutcomeFromEvent(eventType: string, at: Date): GradedOutcome | null {
  if ((GRADED_PASS_EVENTS as readonly string[]).includes(eventType)) return { at, passed: true }
  if ((GRADED_FAIL_EVENTS as readonly string[]).includes(eventType)) return { at, passed: false }
  return null
}
