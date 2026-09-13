import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ configured: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/onchain/config', () => ({ isLaborMarketConfigured: mocks.configured }))
vi.mock('@/lib/onchain/labor', () => ({ readJobsSnapshot: mocks.read }))
vi.mock('@/lib/feed-meta', () => ({ feedMeta: () => ({ chainId: 8453, contractAddress: '0xmarket' }) }))
import { readMarketSnapshot } from '@/lib/market-snapshot'

beforeEach(() => { vi.resetAllMocks(); mocks.configured.mockReturnValue(true) })
describe('market snapshot availability and provenance', () => {
  it('retains the observation time of cached data, without leaking job details into metadata', async () => {
    mocks.read.mockResolvedValue({ jobs: [{ id: 1 }], blockNumber: '99', observedAt: '2026-09-12T00:00:00Z' })
    const result = await readMarketSnapshot()
    expect(result.snapshot).toMatchObject({ state: 'ok', blockNumber: '99', observedAt: '2026-09-12T00:00:00Z', chainId: 8453, contractAddress: '0xmarket', coverage: 'all_contract_jobs' })
    expect(result.snapshot).not.toHaveProperty('jobs')
  })
  it('rejects an unreadable/partial read as unknown rather than an empty or partial market', async () => {
    mocks.read.mockRejectedValue(new Error('job read failed'))
    const result = await readMarketSnapshot()
    expect(result.jobs).toBeNull()
    expect(result.snapshot).toMatchObject({ state: 'unreachable', blockNumber: null, observedAt: null, coverage: 'unavailable' })
  })
  it('does not call RPC for an unconfigured market', async () => {
    mocks.configured.mockReturnValue(false)
    expect((await readMarketSnapshot()).snapshot.state).toBe('unconfigured')
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
