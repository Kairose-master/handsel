import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ block: vi.fn(), read: vi.fn(), multi: vi.fn() }))
vi.mock('@/lib/onchain/clients', () => ({ publicClient: () => ({ getBlockNumber: mocks.block, readContract: mocks.read, multicall: mocks.multi }), oracleWallet: vi.fn() }))
vi.mock('@/lib/onchain/account', () => ({ sendAgentCall: vi.fn(), sendAgentCalls: vi.fn() }))
vi.mock('@/lib/onchain/config', async (original) => {
  const actual = await original<typeof import('@/lib/onchain/config')>()
  return { ...actual, onchainEnv: { ...actual.onchainEnv, laborMarketAddress: '0x1111111111111111111111111111111111111111' } }
})

const address = '0x1111111111111111111111111111111111111111'
const hash = `0x${'00'.repeat(32)}`
// Field order follows the contract jobs getter (requester, worker, bounty, minScore, status, ...).
const tuple = [address, address, 2_000_000n, 0n, 4, hash, hash, 1n, 2n, 3n, 4n, 5n, address, 0n]

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.block.mockResolvedValue(123n)
  mocks.read.mockImplementation(({ functionName }: { functionName: string }) => Promise.resolve(functionName === 'jobCount' ? 1n : 100n))
  mocks.multi.mockResolvedValue([{ status: 'success', result: tuple }])
})

describe('block-pinned complete contract reads', () => {
  it('pins jobCount and job getters and keeps cached provenance', async () => {
    const { readJobsSnapshot, readJobs } = await import('@/lib/onchain/labor')
    const first = await readJobsSnapshot()
    expect(first.jobs).toHaveLength(1)
    expect(first.blockNumber).toBe('123')
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'jobCount', blockNumber: 123n }))
    expect(mocks.multi).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }))
    expect(await readJobsSnapshot()).toBe(first)
    expect(await readJobs()).toBe(first.jobs)
    expect(mocks.block).toHaveBeenCalledTimes(1)
    mocks.block.mockResolvedValue(124n)
    expect((await readJobsSnapshot({ maxAgeMs: 0 })).blockNumber).toBe('124')
  })

  it('fails the aggregate on a failed V2 row, then permits a successful retry', async () => {
    mocks.multi.mockResolvedValue([{ status: 'failure', error: new Error('RPC error') }])
    const { readJobsSnapshot } = await import('@/lib/onchain/labor')
    await expect(readJobsSnapshot()).rejects.toThrow('Incomplete market snapshot')
    mocks.multi.mockResolvedValue([{ status: 'success', result: tuple }])
    expect((await readJobsSnapshot()).jobs).toHaveLength(1)
    expect(mocks.multi).toHaveBeenCalledTimes(2)
  })

  it('pins V1 reads too', async () => {
    mocks.read.mockImplementation(({ functionName }: { functionName: string }) => functionName === 'MAX_OPEN_WINDOW' ? Promise.reject(new Error('V1: no selector')) : Promise.resolve(1n))
    mocks.multi.mockResolvedValue([tuple.slice(0, 7)])
    const { readJobsSnapshot } = await import('@/lib/onchain/labor')
    expect((await readJobsSnapshot()).jobs).toHaveLength(1)
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'jobCount', blockNumber: 123n }))
    expect(mocks.multi).toHaveBeenCalledWith(expect.objectContaining({ allowFailure: false, blockNumber: 123n }))
  })
})
