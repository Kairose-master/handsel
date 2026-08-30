/**
 * A tool's track record on real, paid, independently graded work.
 *
 * This is the column no other MCP registry can print. Smithery, mcp.so and
 * the rest rank by stars and install count — popularity, which says nothing
 * about whether the tool does the job. Every completed job here has already
 * produced a verdict from a grader that is not the worker, a settlement that
 * either happened or did not, and a bond the worker lost if it failed. All
 * that was missing was grouping it by tool instead of by agent
 * (docs/positioning.md §5).
 *
 * ── The honesty rules, which are the product ─────────────────────────────
 *
 * A leaderboard that overclaims destroys the one asset it exists to build.
 * Three rules, enforced here rather than left to whoever writes the page:
 *
 * 1. **N is never hidden.** A pass rate without its sample size is a
 *    decoration. `passRate` is null below MIN_RATED_JOBS — not rounded, not
 *    estimated, absent — so a caller cannot print a number that isn't one.
 *
 * 2. **Say how many accounts it came from.** Right now most jobs on this
 *    market are posted by one account. "78% over 41 jobs" where all 41 came
 *    from a single customer is a fact about that customer's setup, not
 *    independent evidence about the tool, and presenting it as the latter is
 *    exactly the overclaim that would make the whole record worthless.
 *    `accounts` rides along with every row and single-source rows are not
 *    ranked.
 *
 * 3. **Aggregate only.** Nothing here carries an account id, an agent id, a
 *    job title or a bounty from one job. Publishing per-tool numbers means
 *    publishing about somebody else's product; it must never also publish
 *    about somebody else's customer.
 */

export type GradedJob = {
  toolId: string
  toolLabel: string
  toolKind: string
  passed: boolean
  /** Null when the chain could not be read. Absent, never 0 — a $0.00 median
   *  is a claim about price, and an unavailable RPC is not evidence of one. */
  bountyUsd: number | null
  /** Claim → graded, seconds. Null when either timestamp is missing. */
  seconds: number | null
  gradedAt: number
  /** Which account posted the job. Used ONLY to count distinct sources; it
   *  never leaves this module. */
  requesterAccountId: string
}

export type ToolRecord = {
  toolId: string
  label: string
  kind: string
  jobs: number
  passed: number
  /** Null below MIN_RATED_JOBS — see rule 1. */
  passRate: number | null
  /** How many distinct accounts hired this tool — see rule 2. */
  accounts: number
  medianBountyUsd: number | null
  medianSeconds: number | null
  lastGradedAt: number
  /** False when the record is too small or comes from a single account. Such
   *  rows are still SHOWN — hiding them would be its own kind of dishonesty,
   *  since a tool with three jobs is not a tool with none — but they sort
   *  below every ranked row and carry no rate. */
  ranked: boolean
  /** Why it is not ranked, for the reader rather than the developer. */
  caveat: string | null
}

/** Below this many graded jobs a pass rate is noise. Four failures out of
 *  five is not a 20% pass rate, it is five jobs. */
export const MIN_RATED_JOBS = 5

/** Below this many distinct hiring accounts the record describes one
 *  customer's setup as much as it describes the tool. */
export const MIN_SOURCES = 2

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function summarizeTool(jobs: readonly GradedJob[]): ToolRecord | null {
  if (jobs.length === 0) return null
  const first = jobs[0]
  const passed = jobs.filter((j) => j.passed).length
  const accounts = new Set(jobs.map((j) => j.requesterAccountId)).size
  const enough = jobs.length >= MIN_RATED_JOBS
  const independent = accounts >= MIN_SOURCES
  return {
    toolId: first.toolId,
    label: first.toolLabel,
    kind: first.toolKind,
    jobs: jobs.length,
    passed,
    passRate: enough ? passed / jobs.length : null,
    accounts,
    medianBountyUsd: median(jobs.map((j) => j.bountyUsd).filter((b): b is number => b !== null)),
    medianSeconds: median(jobs.map((j) => j.seconds).filter((s): s is number => s !== null)),
    lastGradedAt: Math.max(...jobs.map((j) => j.gradedAt)),
    ranked: enough && independent,
    caveat: !enough
      ? `only ${jobs.length} graded ${jobs.length === 1 ? 'job' : 'jobs'} — too few to rate`
      : !independent
        ? 'all jobs came from one account — a record of that setup, not independent evidence'
        : null,
  }
}

export function groupByTool(jobs: readonly GradedJob[]): ToolRecord[] {
  const byTool = new Map<string, GradedJob[]>()
  for (const j of jobs) {
    const list = byTool.get(j.toolId) ?? []
    list.push(j)
    byTool.set(j.toolId, list)
  }
  return [...byTool.values()].map(summarizeTool).filter((r): r is ToolRecord => r !== null)
}

/**
 * Ranked rows first, best pass rate first; everything else after, most
 * evidence first.
 *
 * Unranked rows are not hidden. A tool with three graded jobs is not a tool
 * with none, and burying it entirely would make the list look more settled
 * than the evidence is.
 */
export function rankTools(records: readonly ToolRecord[]): ToolRecord[] {
  return [...records].sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1
    if (a.ranked && b.ranked) {
      const rate = (b.passRate ?? 0) - (a.passRate ?? 0)
      if (Math.abs(rate) > 1e-9) return rate
      return b.jobs - a.jobs
    }
    if (a.jobs !== b.jobs) return b.jobs - a.jobs
    return b.lastGradedAt - a.lastGradedAt
  })
}

/** One line for a tool list. Deliberately leads with the sample, because the
 *  sample is what makes the rate mean anything. */
export function describeRecord(r: ToolRecord): string {
  const sample = `${r.jobs} graded · ${r.accounts} ${r.accounts === 1 ? 'account' : 'accounts'}`
  const rate = r.passRate === null ? 'not rated' : `${Math.round(r.passRate * 100)}% passed`
  const time = r.medianSeconds === null ? '' : ` · median ${formatSeconds(r.medianSeconds)}`
  const money = r.medianBountyUsd === null ? '' : ` · median $${r.medianBountyUsd.toFixed(2)}`
  return `${rate} (${sample})${money}${time}${r.caveat ? ` — ${r.caveat}` : ''}`
}

export function formatSeconds(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  return `${Math.round((sec / 3600) * 10) / 10}h`
}
