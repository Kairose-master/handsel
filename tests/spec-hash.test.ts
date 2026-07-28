import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIEF_VERSION, briefMatchesHash, sealBrief, type Brief } from '@/lib/spec-hash'

/**
 * What the on-chain specHash commits to.
 *
 * It used to be `{ title, agent, nonce }` — the job's NAME. So the terms that
 * decide whether work passes, `acceptanceCriteria` and `testCode`, could be
 * rewritten after posting, after acceptance, even after submission, and the
 * commitment still verified. That is tolerable while a grader verdict only
 * advises and intolerable once a verdict can move escrow.
 */

const base: Brief = { title: 'translate the docs', agent: 'agt_1', nonce: 'n1' }

describe('the seal covers the terms that decide the outcome', () => {
  it.each([
    ['acceptanceCriteria', { acceptanceCriteria: 'must be idiomatic' }],
    ['testCode', { testCode: 'assert f(1) == 2' }],
    ['description', { description: 'the long version' }],
    ['deliverableKind', { deliverableKind: 'image' }],
    ['requiredCapabilities', { requiredCapabilities: ['vision'] }],
    ['testSuiteSlug', { testSuiteSlug: 'two-sum' }],
  ])('changing %s changes the hash', (_label, delta) => {
    // Each of these was editable after posting under the old preimage.
    expect(sealBrief({ ...base, ...delta })).not.toBe(sealBrief(base))
  })

  it('is stable for the same content', () => {
    expect(sealBrief({ ...base, acceptanceCriteria: 'x' })).toBe(sealBrief({ ...base, acceptanceCriteria: 'x' }))
  })

  it('does not depend on the order the fields were written', () => {
    // The old preimage stringified an object literal, so the hash depended on
    // the order somebody happened to type — a hash that breaks when a field
    // moves, for no reason anyone can explain later.
    const a = sealBrief({ title: 't', agent: 'a', nonce: 'n', testCode: 'c', description: 'd' })
    const b = sealBrief({ description: 'd', testCode: 'c', nonce: 'n', agent: 'a', title: 't' })
    expect(a).toBe(b)
  })

  it('distinguishes absent from empty', () => {
    // "no acceptance criteria" and "blank acceptance criteria" are different
    // postings. A hash that conflates them lets one be swapped for the other.
    expect(sealBrief({ ...base, acceptanceCriteria: null })).not.toBe(
      sealBrief({ ...base, acceptanceCriteria: '' }),
    )
  })

  it('cannot be forged by moving content across field boundaries', () => {
    // Naive concatenation lets `title="a" + criteria="bc"` collide with
    // `title="ab" + criteria="c"`. The field-tagged encoding must not.
    expect(sealBrief({ ...base, title: 'a', acceptanceCriteria: 'bc' })).not.toBe(
      sealBrief({ ...base, title: 'ab', acceptanceCriteria: 'c' }),
    )
  })

  it('is versioned inside the preimage', () => {
    expect(BRIEF_VERSION).toBeGreaterThanOrEqual(2)
  })
})

describe('verification is three-valued, and the third value is the point', () => {
  const row = {
    specHash: sealBrief({ ...base, acceptanceCriteria: 'must be idiomatic' }),
    briefNonce: 'n1',
    title: 'translate the docs',
    requesterAgentId: 'agt_1',
    acceptanceCriteria: 'must be idiomatic',
  }

  it('matches an untampered row', () => {
    expect(briefMatchesHash(row)).toBe('match')
  })

  it('catches criteria rewritten after posting', () => {
    expect(briefMatchesHash({ ...row, acceptanceCriteria: 'must rhyme' })).toBe('mismatch')
  })

  it('says UNVERIFIABLE for a legacy row, never mismatch', () => {
    // This is the one that would have cost real money. Every row written before
    // the sealed brief used the old preimage and stored no nonce, so it cannot
    // be recomputed. Calling that `mismatch` would mark every legacy job
    // substituted — and decideRefund REFUNDS on SUBSTITUTED, so shipping it
    // would have handed every legacy dispute back to the requester.
    expect(briefMatchesHash({ ...row, briefNonce: null })).toBe('unverifiable')
    expect(briefMatchesHash({ ...row, specHash: null })).toBe('unverifiable')
    expect(briefMatchesHash({ ...row, requesterAgentId: null })).toBe('unverifiable')
  })

  it('is case-insensitive about the hex, because callers are not consistent', () => {
    expect(briefMatchesHash({ ...row, specHash: row.specHash.toUpperCase() })).toBe('match')
  })
})

describe('one place computes a spec hash', () => {
  it('no producer builds the preimage by hand', () => {
    // Eleven call sites each wrote their own `keccak256(toHex(JSON.stringify(
    // { title, agent, nonce })))`. Eleven copies of a rule is eleven chances
    // for one of them to drift, and drift here means a job whose commitment
    // cannot be verified at all.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e)
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
      })

    const offenders = ['lib', 'app']
      .flatMap(walk)
      .filter((f) => f !== 'lib/spec-hash.ts')
      .filter((f) => /keccak256\(\s*toHex\(\s*JSON\.stringify\(\s*\{\s*title/.test(readFileSync(f, 'utf8')))

    expect(offenders, `these should call sealBrief(): ${offenders.join(', ')}`).toEqual([])
  })
})
