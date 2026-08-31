/**
 * The benchmark loop — keeping the tool record's receipts fresh, on purpose.
 *
 * `docs/positioning.md`'s wedge is that `/directory` is the one registry
 * with receipts: per-TOOL outcomes from jobs that were independently graded
 * with money at stake. A receipt ages. A tool whose last graded job is a
 * month old is a stale claim, and nothing refreshed it unless a human
 * happened to post work. This loop posts a small, graded, house-funded job
 * at tools whose record has gone stale — every benchmark job pays for
 * itself twice, once as work and once as evidence.
 *
 * Honesty constraints, each already enforced elsewhere and relied on here:
 *
 *  - House-posted benchmarks are SAME-SOURCE by definition. That does not
 *    corrupt the record because `lib/tool-record.ts` counts distinct hiring
 *    accounts and refuses to RANK a single-source tool — a benchmark can
 *    keep `lastGradedAt` and the sample honest, it cannot manufacture
 *    independence. That property is load-bearing; do not weaken it there.
 *  - This file is PURE planning: given the record and the budget, which
 *    tools get a job this sweep. The posting (money) lives in
 *    `lib/benchmark-loop-server.ts`, mirrored from the job faucet's path.
 *  - OFF by default (`BENCHMARK_LOOP=true` to enable), budget-capped per
 *    day, and REFUSED on a real-money deployment without its own explicit
 *    opt-in — the same posture as the lineage mandate, for the same reason:
 *    a loop that spends unattended must be impossible to enable by accident.
 */

export const BENCHMARK_TITLE_PREFIX = '[benchmark] '

/** A tool's record goes stale after a week without a graded job. */
export const BENCHMARK_STALE_MS = 7 * 24 * 60 * 60_000

/** Small on purpose: the point is a fresh graded outcome, not income. */
export const BENCHMARK_BOUNTY_USD = 0.5

export const BENCHMARK_DEFAULT_DAILY_BUDGET_USD = 2
export const BENCHMARK_MAX_PER_SWEEP = 2

export type BenchmarkCandidate = {
  toolId: string
  /** ms epoch of the tool's newest graded job. */
  lastGradedAt: number
}

export type BenchmarkPlanInput = {
  now: number
  /** BENCHMARK_LOOP === 'true' */
  enabled: boolean
  realMoney: boolean
  /** BENCHMARK_ALLOW_REAL_MONEY === 'true' */
  allowRealMoney: boolean
  dailyBudgetUsd: number
  /** What benchmark posts already spent today (counted, not cached). */
  spentTodayUsd: number
  candidates: BenchmarkCandidate[]
}

export type BenchmarkPlan = {
  post: { toolId: string; bountyUsd: number }[]
  /** Set when nothing is posted, naming the reason — a quiet loop must be
   *  distinguishable from a disabled one. */
  skipped: string | null
}

export function planBenchmarkSweep(input: BenchmarkPlanInput): BenchmarkPlan {
  if (!input.enabled) return { post: [], skipped: 'off — set BENCHMARK_LOOP=true to enable' }
  if (input.realMoney && !input.allowRealMoney) {
    return {
      post: [],
      skipped:
        'refused: this deployment moves real money and BENCHMARK_ALLOW_REAL_MONEY is not set — run it on the rehearsal, or opt in explicitly',
    }
  }

  const stale = input.candidates
    .filter((c) => input.now - c.lastGradedAt > BENCHMARK_STALE_MS)
    .sort((a, b) => a.lastGradedAt - b.lastGradedAt) // stalest first

  if (stale.length === 0) return { post: [], skipped: 'no stale tool records' }

  const post: BenchmarkPlan['post'] = []
  let spent = input.spentTodayUsd
  for (const c of stale) {
    if (post.length >= BENCHMARK_MAX_PER_SWEEP) break
    if (spent + BENCHMARK_BOUNTY_USD > input.dailyBudgetUsd) break
    post.push({ toolId: c.toolId, bountyUsd: BENCHMARK_BOUNTY_USD })
    spent += BENCHMARK_BOUNTY_USD
  }

  if (post.length === 0) return { post: [], skipped: 'daily benchmark budget spent' }
  return { post, skipped: null }
}

/**
 * The brief a benchmark job carries. Deliberately research-shaped and
 * answerable by any text-capable worker — search connector, harness, or
 * chat model — because the record groups by tool, and a brief only one tool
 * kind can pass would bias the comparison it exists to keep honest. Rotated
 * daily so a worker cannot pattern-match yesterday's answer.
 */
const BENCHMARK_PROMPTS: readonly { subject: string; criteria: string }[] = [
  {
    subject: 'What is the current default context window of the latest generally-available Claude model, per Anthropic’s own documentation?',
    criteria: 'Names a specific figure, names the model it applies to, and cites where the figure came from (URL or document name). A documented "could not verify" with the sources checked also passes.',
  },
  {
    subject: 'What is the maximum execution timeout of an AWS Lambda function, per AWS’s current documentation?',
    criteria: 'States the documented limit with its unit, names the page or document it came from, and does not confuse it with API Gateway’s timeout.',
  },
  {
    subject: 'What HTTP status code does the x402 payment-required flow use, and which spec or writeup defines it?',
    criteria: 'Names the status code and at least one concrete source (spec, RFC, or vendor writeup) it is defined or described in.',
  },
]

export function benchmarkSpecFor(now: number): {
  title: string
  description: string
  acceptanceCriteria: string
  deliverableKind: 'text'
} {
  const day = Math.floor(now / (24 * 60 * 60_000))
  const p = BENCHMARK_PROMPTS[day % BENCHMARK_PROMPTS.length]
  return {
    title: `${BENCHMARK_TITLE_PREFIX}${p.subject.slice(0, 80)}`,
    description:
      `${p.subject}\n\nThis is a routine benchmark job: it is graded exactly like any other job, ` +
      'and the outcome joins the public per-tool record on /directory.',
    acceptanceCriteria: p.criteria,
    deliverableKind: 'text',
  }
}
