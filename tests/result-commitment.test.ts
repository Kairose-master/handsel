import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { commitmentFor, resultHashOf } from '@/lib/result-commitment'

const OUT = 'the finished deliverable'
const H = resultHashOf(OUT)

describe('the chain commitment is checked, not assumed', () => {
  it('matches when nothing was revised', () => {
    expect(commitmentFor({ onchainResultHash: H, acceptedOutput: OUT })).toMatchObject({ status: 'match', note: null })
  })

  it('reports a revision as diverged, with the reason', () => {
    // Observed live 2026-09-02 04:19Z: a revision's submitWork reverted, the
    // off-chain flow carried on, and the job settled with the chain still
    // committed to the pre-revision text.
    const c = commitmentFor({ onchainResultHash: H, acceptedOutput: 'the revised deliverable' })
    expect(c.status).toBe('diverged')
    expect(c.note).toMatch(/no second submitWork/)
    expect(c.note).toMatch(/FIRST submission/)
    expect(c.onchain).not.toBe(c.actual)
  })

  it('is case-insensitive about the hex, because callers are not consistent', () => {
    expect(commitmentFor({ onchainResultHash: H.toUpperCase(), acceptedOutput: OUT }).status).toBe('match')
  })
})

describe('absence is not a mismatch', () => {
  it('says unknown when nothing was committed on chain', () => {
    // Reporting this as divergence would accuse a worker of substituting work
    // on a job that never had a commitment in the first place.
    for (const h of [null, undefined, '', `0x${'0'.repeat(64)}`]) {
      expect(commitmentFor({ onchainResultHash: h, acceptedOutput: OUT }).status, String(h)).toBe('unknown')
    }
  })

  it('says unknown when nothing was stored off chain', () => {
    expect(commitmentFor({ onchainResultHash: H, acceptedOutput: null }).status).toBe('unknown')
    expect(commitmentFor({ onchainResultHash: H, acceptedOutput: '' }).status).toBe('unknown')
  })

  it('never emits a note for anything but a real divergence', () => {
    expect(commitmentFor({ onchainResultHash: H, acceptedOutput: OUT }).note).toBeNull()
    expect(commitmentFor({ onchainResultHash: null, acceptedOutput: OUT }).note).toBeNull()
  })
})

describe('it hashes the way the submitter hashes', () => {
  it('uses the same empty-output stand-in the callback commits', () => {
    // A different placeholder here would report every empty submission as
    // diverged — a false accusation produced by this file alone.
    expect(resultHashOf('')).toBe(resultHashOf('(empty output)'))
  })
})

describe('the release path records it', () => {
  const src = readFileSync('lib/delegation.ts', 'utf8')

  it('stamps the commitment on the subtask when peer review releases', () => {
    expect(src).toContain('commitmentFor({')
    expect(src).toContain('onchainResultHash: targetJob?.resultHash ?? null')
  })

  it('compares against the artifact that was actually paid for', () => {
    // Not submittedOutput and not the first draft — `target.output` is what
    // the delegation publishes, and the whole point is whether THAT is what
    // the chain holds.
    const at = src.indexOf('commitmentFor({')
    expect(src.slice(at, at + 200)).toContain('acceptedOutput: target.output')
  })

  it('records after the release, so it can never gate the money', () => {
    const branch = src.slice(src.indexOf("if (decision === 'release')"), src.indexOf("} else if (decision === 'revise')"))
    expect(branch.indexOf('approveJob(')).toBeLessThan(branch.indexOf('commitmentFor'))
  })
})
