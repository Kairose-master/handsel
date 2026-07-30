import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Zero means zero.
 *
 * The faucet's bounds were read as `Number(process.env.X ?? d) || d`. `Number('0')`
 * is `0`, which is FALSY, so `|| d` fires and the explicit zero becomes the
 * default: `FAUCET_MAX_PER_DAY=0` — the documented way to switch the faucet off —
 * produced FIFTEEN jobs a day.
 *
 * On a testnet that is clutter. On a real chain the faucet posts practice work
 * with real bounties, and `realMoneyBlockers` carries a `faucet-enabled` blocker
 * whose entire premise is that this switch works. An operator who turned it off,
 * checked, and was told it was off would still have been paying.
 */
const src = readFileSync('lib/job-faucet.ts', 'utf8')

describe('faucet bounds respect an explicit zero', () => {
  it('no longer uses the falsy-or idiom for a numeric bound', () => {
    // The exact shape of the bug, in both places it appeared.
    expect(src).not.toMatch(/Number\(process\.env\.FAUCET_MAX_PER_DAY[^)]*\)\s*\|\|/)
    expect(src).not.toMatch(/Number\(process\.env\.FAUCET_TARGET_OPEN[^)]*\)\s*\|\|/)
  })

  it('parses through a helper that distinguishes absent from zero', () => {
    expect(src).toMatch(/function faucetBound/)
    // Absent and blank fall back; anything non-finite falls back; 0 does not.
    expect(src).toMatch(/raw === undefined \|\| raw\.trim\(\) === ''/)
    expect(src).toMatch(/if \(!Number\.isFinite\(n\)\) return fallback/)
  })

  it('gives MAX_PER_DAY a floor of zero and TARGET_OPEN a floor of one', () => {
    // The floors carry the meaning: a daily maximum of zero is a valid
    // instruction, a target of zero open jobs is not what the caller means.
    expect(src).toMatch(/faucetBound\('FAUCET_MAX_PER_DAY', 15, 0\)/)
    expect(src).toMatch(/faucetBound\('FAUCET_TARGET_OPEN', 3, 1\)/)
  })

  it('reproduces the old arithmetic to show what it did', () => {
    // Kept as arithmetic rather than prose so the claim is checkable: this is
    // why FAUCET_MAX_PER_DAY=0 meant 15.
    const old = (raw: string, d: number) => Math.max(0, Number(raw ?? d) || d)
    expect(old('0', 15)).toBe(15)
    const fixed = (raw: string, d: number, floor: number) => {
      if (raw === undefined || raw.trim() === '') return d
      const n = Number(raw)
      return Number.isFinite(n) ? Math.max(floor, n) : d
    }
    expect(fixed('0', 15, 0)).toBe(0)
    expect(fixed('', 15, 0)).toBe(15)
    expect(fixed('abc', 15, 0)).toBe(15)
    expect(fixed('7', 15, 0)).toBe(7)
  })
})
