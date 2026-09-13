import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ jobs: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/app/actions/guest', () => ({ publicJobsResult: mocks.jobs }))
vi.mock('@/lib/onchain/solana/config', () => ({ isSolanaConfigured: () => false }))
import { GET } from '@/app/api/tasks/route'

beforeEach(() => vi.clearAllMocks())
it('retains provenance and describes the returned subset instead of claiming lifetime coverage', async () => {
  const snapshot = { state: 'ok', blockNumber: '123' }
  mocks.jobs.mockResolvedValue({ state: 'ok', jobs: [{ id: 1, status: 'Completed', bounty: 2 }], snapshot })
  const response = await GET(new Request('https://example.test/api/tasks?status=all&limit=50'))
  const body = await response.json()
  expect(body.snapshot).toEqual(snapshot)
  expect(body.count).toBe(1)
  expect(body.coverage).toMatchObject({ evmCandidateLimit: 150, limitPerChain: 50, statusFilter: 'all' })
  expect(body.coverage.countMeaning).toContain('not lifetime')
})
it('exposes unavailable provenance on the existing 503 response', async () => {
  mocks.jobs.mockResolvedValue({ state: 'unreachable', jobs: [], snapshot: { state: 'unreachable', blockNumber: null } })
  const response = await GET(new Request('https://example.test/api/tasks'))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ count: null, snapshot: { state: 'unreachable', blockNumber: null } })
})
