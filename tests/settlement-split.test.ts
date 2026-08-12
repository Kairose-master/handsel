import { describe, expect, it } from 'vitest'
import { computeSplit, parseSplitSpec, type SplitSpec } from '@/lib/settlement-split'

/**
 * Increment 3's pure core (docs/physical-operatorship.md): who gets how
 * much of a settled bounty. The invariant every test circles: allocations
 * are floored to the cent and the worker keeps every remainder, so the
 * split can never pay out more than was settled.
 */

describe('parseSplitSpec — untrusted input, x402-facing', () => {
  const good = { recipients: [{ role: 'author', address: '0x' + 'a'.repeat(40), bps: 7000 }] }

  it('accepts a well-formed spec', () => {
    const r = parseSplitSpec(good)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.recipients[0].role).toBe('author')
  })

  it('accepts agentId recipients', () => {
    const r = parseSplitSpec({ recipients: [{ role: 'machine_owner', agentId: 'ag_1', bps: 2000 }] })
    expect(r.ok).toBe(true)
  })

  it('requires exactly one of agentId or address', () => {
    expect(parseSplitSpec({ recipients: [{ role: 'x', bps: 100 }] }).ok).toBe(false)
    expect(
      parseSplitSpec({ recipients: [{ role: 'x', agentId: 'a', address: '0x' + 'a'.repeat(40), bps: 100 }] }).ok,
    ).toBe(false)
  })

  it('refuses bad addresses, bad bps, and sums past 10000', () => {
    expect(parseSplitSpec({ recipients: [{ role: 'x', address: 'nope', bps: 100 }] }).ok).toBe(false)
    expect(parseSplitSpec({ recipients: [{ role: 'x', address: '0x' + 'a'.repeat(40), bps: 0 }] }).ok).toBe(false)
    expect(parseSplitSpec({ recipients: [{ role: 'x', address: '0x' + 'a'.repeat(40), bps: 1.5 }] }).ok).toBe(false)
    expect(
      parseSplitSpec({
        recipients: [
          { role: 'a', address: '0x' + 'a'.repeat(40), bps: 6000 },
          { role: 'b', address: '0x' + 'b'.repeat(40), bps: 5000 },
        ],
      }).ok,
    ).toBe(false)
  })

  it('bounds the list and the role length', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ role: `r${i}`, address: '0x' + 'a'.repeat(40), bps: 10 }))
    expect(parseSplitSpec({ recipients: many }).ok).toBe(false)
    expect(parseSplitSpec({ recipients: [{ role: 'r'.repeat(25), address: '0x' + 'a'.repeat(40), bps: 10 }] }).ok).toBe(false)
  })
})

describe('computeSplit — floor to the cent, worker keeps the remainder', () => {
  const spec: SplitSpec = {
    recipients: [
      { role: 'author', address: '0x' + 'a'.repeat(40), bps: 7000 },
      { role: 'location', address: '0x' + 'b'.repeat(40), bps: 500 },
    ],
  }

  it('splits a clean amount exactly', () => {
    const { allocations, workerKeepsUsd } = computeSplit(100, spec)
    expect(allocations.map((a) => [a.role, a.amountUsd])).toEqual([
      ['author', 70],
      ['location', 5],
    ])
    expect(workerKeepsUsd).toBe(25)
  })

  it('the sum invariant holds under awkward amounts', () => {
    for (const amount of [0.01, 0.03, 1.37, 24.99, 33.33]) {
      const { allocations, workerKeepsUsd } = computeSplit(amount, spec)
      const paid = allocations.reduce((s, a) => s + Math.round(a.amountUsd * 100), 0)
      expect(paid + Math.round(workerKeepsUsd * 100)).toBe(Math.floor(amount * 100))
    }
  })

  it('drops sub-cent allocations rather than sending zero-value transfers', () => {
    const { allocations, workerKeepsUsd } = computeSplit(0.01, spec) // author share = 0.7 cents
    expect(allocations).toEqual([])
    expect(workerKeepsUsd).toBe(0.01)
  })

  it('a null spec means the pre-split behavior: worker keeps everything', () => {
    const { allocations, workerKeepsUsd } = computeSplit(25, null)
    expect(allocations).toEqual([])
    expect(workerKeepsUsd).toBe(25)
  })
})
