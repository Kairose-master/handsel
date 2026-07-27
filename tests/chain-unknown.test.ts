import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { countOpenBy, readOrUnknown } from '@/lib/onchain/labor-read'

const job = (id: number, status: string, requester: string) => ({
  id,
  status,
  requester,
  worker: '0x0',
  bounty: 5,
  minScore: 0,
  specHash: `0x${id}`,
}) as never

describe('readOrUnknown', () => {
  it('a successful empty read is empty — the market really has no jobs', async () => {
    expect(await readOrUnknown(async () => [], 'test')).toEqual([])
  })

  it('a failed read is unknown, never empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = async () => {
      throw new Error('HTTP request failed: 429')
    }
    expect(await readOrUnknown(boom, 'test')).toBeNull()
  })

  it('passes through real data untouched', async () => {
    const jobs = [job(1, 'Open', '0xaa')]
    expect(await readOrUnknown(async () => jobs, 'test')).toBe(jobs)
  })
})

describe('countOpenBy', () => {
  const jobs = [job(1, 'Open', '0xAA'), job(2, 'Completed', '0xAA'), job(3, 'Open', '0xbb')]

  it('counts Open jobs across the market', () => {
    expect(countOpenBy(jobs)).toBe(2)
  })

  it('counts one requester’s Open jobs, case-insensitively', () => {
    expect(countOpenBy(jobs, '0xaa')).toBe(1)
    expect(countOpenBy(jobs, '0xBB')).toBe(1)
  })

  it('returns null for unknown — a spender must not read it as zero', () => {
    expect(countOpenBy(null)).toBeNull()
    expect(countOpenBy(null, '0xaa')).toBeNull()
    // The distinction that matters: zero is a number, unknown is not.
    expect(countOpenBy([])).toBe(0)
  })
})

/**
 * Wiring guard. Each of these paths SPENDS when it sees no Open jobs, so a
 * swallowed RPC error inverts the decision: a chain hiccup reads as a drained
 * board and mints escrowed jobs nobody asked for.
 *
 * `lib/board-stock.ts` was the third entry and the worst of them — it sat on
 * the five-minute traffic tick, so an outage would have billed once per tick
 * for as long as it lasted. It is gone: its only supply was translation work
 * the house posted to itself.
 */
describe('paths that spend on absence refuse unknown chain state', () => {
  const ROOT = join(import.meta.dirname, '..')
  const cases = [
    'lib/job-faucet.ts',
    'app/api/github/webhook/route.ts',
  ]

  for (const file of cases) {
    it(`${file} does not swallow readJobs into an empty market`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(src).toContain('readJobsOrUnknown')
      expect(src).not.toMatch(/readJobs\([^)]*\)\s*\.catch\(\(\)\s*=>\s*\[\]\)/)
    })
  }
})
