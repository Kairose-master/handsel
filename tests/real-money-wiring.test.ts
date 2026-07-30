import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isRealMoney } from '@/lib/onchain/real-money'

/**
 * The guard is CALLED. That is the whole point of this file.
 *
 * `tests/mainnet-guard.test.ts` already proves the conditions are right. It
 * passed, continuously, while `realMoneyBlockers`, `decimalsBlocker` and
 * `formatBlockers` had zero callers anywhere in the app — only `mintBlocker` was
 * wired. Eight blockers, fully written, fully tested, documented in
 * docs/mainnet-deploy.md as something that **refuses**, and on
 * `ONCHAIN_CHAIN=base` they would have refused nothing.
 *
 * So this tests the wiring, not the rules. It is the distinction that ran through
 * every defect in this codebase's recent history: `withdraw()` with no callers,
 * the four permissionless exits with no callers, `agentAccountMode` in no
 * endpoint, CLAUDE.md's "traffic driven" sweeps with no traffic trigger. In every
 * case the logic was correct and unreachable, and no test of the logic could
 * have noticed.
 *
 * Source assertions, because the call sites read `process.env` and the chain at
 * module load. What can be checked without an environment is checked as code.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('the money path calls the guard', () => {
  it('gates postJobAction, the first place escrow locks', () => {
    const src = code('app/actions/labor.ts')
    expect(src).toContain("assertRealMoneyReady('Posting a job')")
    // Before the insert, so a refusal leaves no orphan row behind — the same
    // ordering mistake that left orphan job_specs rows when postJob reverted.
    const guardAt = src.indexOf('assertRealMoneyReady')
    const insertAt = src.indexOf('insert(jobSpec)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(insertAt)
  })

  it('reaches every unwired export of the pure guard', () => {
    // The three that had no caller. If a future edit drops one of these calls,
    // that blocker silently stops applying — which is the exact failure this
    // whole file exists to prevent, so it is named per function rather than
    // assumed from "the module is imported".
    const src = code('lib/onchain/real-money.ts')
    expect(src).toContain('realMoneyBlockers(')
    expect(src).toContain('decimalsBlocker(')
    expect(src).toContain('formatBlockers(')
  })

  it('is visible from outside before anyone flips the chain', () => {
    // One curl instead of a refused posting.
    const route = code('app/api/capabilities/route.ts')
    expect(route).toContain('realMoneyStatus')
    expect(route).toContain('isRealMoney')
    expect(route).toContain('blockers')
  })

  it('publishes codes and details, never values', () => {
    // The endpoint is public. Every detail string in mainnet-guard.ts names env
    // variables rather than their contents, which is what makes this safe — and
    // the route must not add addresses of its own.
    const guard = readFileSync('lib/onchain/mainnet-guard.ts', 'utf8')
    expect(guard).not.toMatch(/\$\{config\.escrowTokenAddress\}/)
    expect(guard).not.toMatch(/\$\{config\.laborMarketAddress\}/)
    const route = code('app/api/capabilities/route.ts')
    expect(route).not.toMatch(/usdcAddress|laborMarketAddress/)
  })
})

describe('what counts as real money', () => {
  it('treats the configured testnet as not real', () => {
    // This deployment is on Base Sepolia right now, so the guard must be inert.
    // Asserted rather than assumed, because a guard that fires on a testnet would
    // be switched off by the first person it inconveniences.
    expect(isRealMoney()).toBe(false)
  })

  it('allowlists testnets rather than listing mainnets', () => {
    // So an unrecognised chain counts as REAL. Being wrong that way costs two
    // minutes of confusion; being wrong the other way costs somebody's funds.
    const src = code('lib/onchain/real-money.ts')
    expect(src).toContain('TESTNET_CHAIN_IDS')
    expect(src).toMatch(/return !TESTNET_CHAIN_IDS\.has\(CHAIN\.id\)/)
    for (const id of ['11155111', '84532', '91342']) expect(src).toContain(id)
    // Base mainnet must NOT be in the set.
    expect(src).not.toMatch(/8453,/)
  })
})

describe('the fee trap this exists to catch', () => {
  it('knows that an unset PLATFORM_FEE_BPS is 2%, not zero', () => {
    // The reason the wiring is load-bearing rather than tidy. An operator who
    // never sets PLATFORM_FEE_BPS gets a 2% off-chain fee on top of the
    // contract's own, and every requester pays twice.
    const fee = readFileSync('lib/platform-fee.ts', 'utf8')
    expect(fee).toMatch(/DEFAULT_FEE_BPS = 200/)
    expect(fee).toMatch(/if \(raw === undefined \|\| raw\.trim\(\) === ''\) return DEFAULT_FEE_BPS/)
  })

  it('reports the fee blockers as unevaluated when the chain read fails', () => {
    // Passing would hide a double charge; blocking would let an RPC blip stop a
    // working market. Naming them is the only answer honest in both directions.
    const src = code('lib/onchain/real-money.ts')
    expect(src).toContain('unevaluated')
    expect(src).toMatch(/FEE_CODES = \['fee-charged-twice', 'no-fee-anywhere'\]/)
    expect(src).toMatch(/kept = feeKnown \? blockers : blockers\.filter/)
  })

  it('caches the immutable reads instead of re-asking', () => {
    // feeBps and decimals cannot change for a given address, so one successful
    // read is permanently true and the cache cannot go stale.
    const src = code('lib/onchain/real-money.ts')
    expect(src).toContain('feeBpsCache')
    expect(src).toContain('decimalsCache')
  })
})
