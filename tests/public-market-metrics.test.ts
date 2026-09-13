import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/market-snapshot', () => ({ readMarketSnapshot: mocks.snapshot }))
vi.mock('@/lib/db', () => ({ db: { select: mocks.select } }))
import { computeLaborIndex } from '@/lib/platform-index'
import { computeMarketHealth } from '@/lib/market-health'

function database(completionEvents: { detail: unknown }[]) {
  const results = [[{ agentCount: 0 }], [], [], completionEvents]
  mocks.select.mockImplementation(() => {
    const rows = results.shift() ?? []
    return { from: () => Object.assign(Promise.resolve(rows), { where: () => Promise.resolve(rows) }) }
  })
}
const snapshot = { state: 'ok', chainId: 8453, contractAddress: '0xmarket', blockNumber: '123', observedAt: '2026-09-12T00:00:00Z' }

beforeEach(() => vi.resetAllMocks())

describe('issue #10: separate contract outcomes from recorded events', () => {
  it('counts 21 contract completions even when only 10 events are recorded', async () => {
    const jobs = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, status: i < 21 ? 'Completed' : i < 33 ? 'Expired' : 'Disputed', bounty: 2 }))
    mocks.snapshot.mockResolvedValue({ jobs, snapshot })
    database(Array.from({ length: 10 }, () => ({ detail: { bounty: 2 } })))
    const index = await computeLaborIndex()
    expect(index.quality).toMatchObject({ completedJobs: 21, recordedCompletionEvents: 10, completedBountyUsd: 42, recordedCompletionBountyUsd: 20, verifiedPayoutUsd: null })
    expect(index.quality.completedJobsLifetime).toBe(10) // compatibility, explicitly deprecated
    expect(index.quality.totalPaidOutUsd).toBe(20)
    expect(index.metricSemantics.deprecated.completedJobsLifetime.replacement).toBe('quality.completedJobs')
    expect(index.snapshot).toEqual(snapshot)

    database([])
    const health = await computeMarketHealth()
    expect(health.jobs.byStatus.Completed).toBe(index.quality.completedJobs)
    expect(health.jobs.total).toBe(35)
    expect(health.jobs.settlementRate).toBe(63.6)
    expect(health.snapshot).toEqual(index.snapshot)
  })

  it('keeps duplicate and missing-bounty events separate from unique jobs and verified payouts', async () => {
    mocks.snapshot.mockResolvedValue({ jobs: [{ id: 1, status: 'Completed', bounty: 4 }], snapshot })
    database([{ detail: { jobId: 1, bounty: 4 } }, { detail: { jobId: 1, bounty: 4 } }, { detail: null }, { detail: { bounty: '4' } }])
    const { quality } = await computeLaborIndex()
    expect(quality.completedJobs).toBe(1)
    expect(quality.recordedCompletionEvents).toBe(4)
    expect(quality.recordedCompletionBountyUsd).toBe(8)
    expect(quality.verifiedPayoutUsd).toBeNull()
  })

  it.each(['unreachable', 'unconfigured'])('does not publish zeroes for %s contract data', async (state) => {
    mocks.snapshot.mockResolvedValue({ jobs: null, snapshot: { ...snapshot, state, blockNumber: null, observedAt: null } })
    database([])
    const index = await computeLaborIndex()
    expect(index.quality.completedJobs).toBeNull()
    expect(index.quality.completedBountyUsd).toBeNull()
    expect(index.demand).toEqual({ openJobs: null, openBountyUsd: null })
    database([])
    const health = await computeMarketHealth()
    expect(health.jobs).toEqual({ byStatus: {}, total: null, escrowedUsd: null, settlementRate: null })
    expect(health.reach).toBeNull()
  })

  it('distinguishes a successfully read empty contract from unavailable data', async () => {
    mocks.snapshot.mockResolvedValue({ jobs: [], snapshot })
    database([])
    const index = await computeLaborIndex()
    expect(index.quality.completedJobs).toBe(0)
    expect(index.demand.openJobs).toBe(0)
    database([])
    const health = await computeMarketHealth()
    expect(health.jobs.total).toBe(0)
    expect(health.jobs.settlementRate).toBeNull()
  })
})
