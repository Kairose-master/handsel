/**
 * The benchmark loop's planner — a loop that spends unattended must be
 * impossible to enable by accident (the lineage mandate's posture), and its
 * refusals must NAME themselves, because a quiet loop and a disabled loop
 * look identical from outside.
 */
import { describe, it, expect } from 'vitest'
import {
  planBenchmarkSweep,
  benchmarkSpecFor,
  BENCHMARK_STALE_MS,
  BENCHMARK_BOUNTY_USD,
  BENCHMARK_MAX_PER_SWEEP,
  BENCHMARK_TITLE_PREFIX,
  type BenchmarkPlanInput,
} from '@/lib/benchmark-loop'

const NOW = 1_756_000_000_000
const STALE = NOW - BENCHMARK_STALE_MS - 1
const FRESH = NOW - 60_000

function input(overrides: Partial<BenchmarkPlanInput> = {}): BenchmarkPlanInput {
  return {
    now: NOW,
    enabled: true,
    realMoney: false,
    allowRealMoney: false,
    dailyBudgetUsd: 2,
    spentTodayUsd: 0,
    candidates: [{ toolId: 'mcp:exa', lastGradedAt: STALE }],
    ...overrides,
  }
}

describe('planBenchmarkSweep', () => {
  it('is OFF by default and says so', () => {
    const plan = planBenchmarkSweep(input({ enabled: false }))
    expect(plan.post).toEqual([])
    expect(plan.skipped).toContain('BENCHMARK_LOOP')
  })

  it('refuses real money without its own explicit opt-in', () => {
    const plan = planBenchmarkSweep(input({ realMoney: true }))
    expect(plan.post).toEqual([])
    expect(plan.skipped).toContain('BENCHMARK_ALLOW_REAL_MONEY')
    // The opt-in genuinely opts in.
    expect(planBenchmarkSweep(input({ realMoney: true, allowRealMoney: true })).post.length).toBe(1)
  })

  it('posts only at stale records, stalest first', () => {
    const plan = planBenchmarkSweep(
      input({
        candidates: [
          { toolId: 'fresh', lastGradedAt: FRESH },
          { toolId: 'stale-new', lastGradedAt: STALE },
          { toolId: 'stale-old', lastGradedAt: STALE - 1_000_000 },
        ],
      }),
    )
    expect(plan.post.map((p) => p.toolId)).toEqual(['stale-old', 'stale-new'])
  })

  it('caps per sweep and per daily budget, and names a spent budget', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ toolId: `t${i}`, lastGradedAt: STALE - i }))
    expect(planBenchmarkSweep(input({ candidates: many })).post.length).toBe(BENCHMARK_MAX_PER_SWEEP)
    expect(
      planBenchmarkSweep(input({ candidates: many, dailyBudgetUsd: BENCHMARK_BOUNTY_USD })).post.length,
    ).toBe(1)
    const spent = planBenchmarkSweep(input({ candidates: many, spentTodayUsd: 2 }))
    expect(spent.post).toEqual([])
    expect(spent.skipped).toContain('budget')
  })

  it('reports "no stale tool records" as its own reason', () => {
    const plan = planBenchmarkSweep(input({ candidates: [{ toolId: 'fresh', lastGradedAt: FRESH }] }))
    expect(plan.skipped).toContain('no stale')
  })
})

describe('benchmarkSpecFor', () => {
  it('carries the marker the spend counter and the UI key off', () => {
    const spec = benchmarkSpecFor(NOW)
    expect(spec.title.startsWith(BENCHMARK_TITLE_PREFIX)).toBe(true)
    expect(spec.deliverableKind).toBe('text')
    expect(spec.acceptanceCriteria.length).toBeGreaterThan(10)
  })

  it('rotates the prompt by day, deterministically', () => {
    const day = 24 * 60 * 60_000
    expect(benchmarkSpecFor(NOW)).toEqual(benchmarkSpecFor(NOW + 60_000))
    expect(benchmarkSpecFor(NOW).title).not.toEqual(benchmarkSpecFor(NOW + day).title)
  })
})

describe('ops-cycle wiring', () => {
  it('benchmarks runs on the FULL cycle only — it escrows money', async () => {
    const { OPS_STEPS } = await import('@/lib/ops-cycle')
    const step = OPS_STEPS.find((s) => s.name === 'benchmarks')
    expect(step).toBeDefined()
    expect(step!.fast).toBeUndefined()
  })
})
