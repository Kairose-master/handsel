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

/**
 * The blockers fire on a realistic mainnet config — proven before deploying.
 *
 * Wiring the guard is worth nothing if the config assembled from a real
 * environment happens to satisfy every condition by accident. These use the pure
 * function directly with the values a Base-mainnet deployment would actually
 * have, so what refuses is known before anybody flips ONCHAIN_CHAIN.
 */
describe('what a Base mainnet deployment would be refused for', () => {
  const base = {
    isRealMoney: true,
    escrowTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    laborMarketAddress: '0xd9bcf1740d4721988ec2c579e2ec71d0eb904a09',
    paymasterMeteredAck: true,
    faucetEnabled: false,
    contractFeeBps: 200,
    offchainFeeBps: 0,
  }

  it('passes when everything the deploy checklist names is done', async () => {
    const { realMoneyBlockers } = await import('@/lib/onchain/mainnet-guard')
    expect(realMoneyBlockers(base)).toEqual([])
  })

  it('refuses the double fee an unset PLATFORM_FEE_BPS produces', async () => {
    // The single likeliest mainnet misconfiguration, because the variable
    // DEFAULTS to 200 — forgetting it is the failure, not mistyping it.
    const { realMoneyBlockers } = await import('@/lib/onchain/mainnet-guard')
    const codes = realMoneyBlockers({ ...base, offchainFeeBps: 200 }).map((b) => b.code)
    expect(codes).toContain('fee-charged-twice')
  })

  it('refuses a faucet that spends real money on practice work', async () => {
    const { realMoneyBlockers } = await import('@/lib/onchain/mainnet-guard')
    const codes = realMoneyBlockers({ ...base, faucetEnabled: true }).map((b) => b.code)
    expect(codes).toContain('faucet-enabled')
  })

  it('refuses an unacknowledged paymaster', async () => {
    const { realMoneyBlockers } = await import('@/lib/onchain/mainnet-guard')
    const codes = realMoneyBlockers({ ...base, paymasterMeteredAck: false }).map((b) => b.code)
    expect(codes).toContain('paymaster-unmetered')
  })

  it('refuses a token whose decimals are not six', async () => {
    // Not paranoia about USDC — paranoia about pointing at the wrong token. Every
    // bounty, cap and fee is scaled by a compile-time 6, so an 18-decimal token
    // escrows a $5 bounty as $5,000,000 and nothing errors until settlement.
    const { decimalsBlocker } = await import('@/lib/onchain/mainnet-guard')
    expect(decimalsBlocker(18, 6)?.code).toBe('token-decimals-mismatch')
    expect(decimalsBlocker(6, 6)).toBeNull()
    // A failed read is not a mismatch: an RPC blip must not stop a working market.
    expect(decimalsBlocker(null, 6)).toBeNull()
  })

  it('stays silent on every testnet, so nobody switches it off', async () => {
    const { realMoneyBlockers } = await import('@/lib/onchain/mainnet-guard')
    // Every blocker tripped at once, and still nothing — because it is a testnet.
    expect(
      realMoneyBlockers({
        isRealMoney: false,
        escrowTokenAddress: '',
        laborMarketAddress: '',
        paymasterMeteredAck: false,
        faucetEnabled: true,
        contractFeeBps: 200,
        offchainFeeBps: 200,
      }),
    ).toEqual([])
  })
})
