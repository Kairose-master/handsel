import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dueWithdrawals, MAX_WITHDRAWALS_PER_PASS, MIN_WITHDRAW_USD } from '@/lib/withdraw-sweep'

/**
 * The other half of pull payments.
 *
 * V2 settlement CREDITS rather than transfers, because pushing meant one
 * blocklisted recipient could revert an entire settlement — R1 reintroduced
 * through the token. The price of that is a second transaction, and until this
 * sweep existed nothing in the product made it: `withdraw()` had been sitting in
 * lib/onchain/labor-v2.ts with zero callers, the same shape the four
 * permissionless exits had before lib/deadline-sweep.ts.
 *
 * A worker on that deployment finishes jobs, reads a dashboard that says it
 * earned, and holds no tokens.
 */

const bal = (agentId: string, amountUsd: number) => ({ agentId, address: `0x${agentId}`, amountUsd })

describe('which balances are worth a sponsored UserOp', () => {
  it('collects a balance at or above the floor', () => {
    expect(dueWithdrawals([bal('a', MIN_WITHDRAW_USD)]).map((w) => w.agentId)).toEqual(['a'])
  })

  it('leaves dust alone', () => {
    // A sponsored withdrawal costs the operator roughly USER_OP_COST_USD
    // whatever it moves. Collecting a fraction of a cent burns more than it
    // delivers, and it does so repeatedly, because a balance below the floor
    // never climbs above it on its own.
    expect(dueWithdrawals([bal('a', MIN_WITHDRAW_USD - 0.001)])).toEqual([])
  })

  it('ignores a zero balance rather than sending a no-op transaction', () => {
    // `withdraw()` reverts NothingToWithdraw at zero, so this would be a
    // sponsored UserOp whose only outcome is a revert — paid for, every pass,
    // for every agent that has never earned anything.
    expect(dueWithdrawals([bal('a', 0)])).toEqual([])
  })

  it('takes the largest first', () => {
    // Not oldest-first, which is what the deadline sweep does. A deadline has a
    // clock to be late against; a withdrawal does not — the money is safe where
    // it is. So the ordering that matters is money moved per sponsored UserOp.
    const out = dueWithdrawals([bal('small', 1), bal('big', 100), bal('mid', 10)])
    expect(out.map((w) => w.agentId)).toEqual(['big', 'mid', 'small'])
  })

  it('does not mutate its input', () => {
    // It sorts, and a sort in place would reorder the caller's array — which in
    // the sweep is the list every subsequent balance lookup is keyed against.
    const input = [bal('a', 1), bal('b', 2)]
    dueWithdrawals(input)
    expect(input.map((w) => w.agentId)).toEqual(['a', 'b'])
  })

  it('is bounded tighter than the backstop it must not crowd out', () => {
    // The exits free money whose counterparty is GONE. A withdrawal moves money
    // that is already safely credited. If a pass can only afford a few
    // sponsored calls, the exits have to win.
    expect(MAX_WITHDRAWALS_PER_PASS).toBeLessThan(3)
  })
})

describe('the wiring, asserted at the source', () => {
  // A unit test cannot show that anything CALLS this. Same shape as the
  // dispute-policy and gas-budget greps, and for the same reason: this whole
  // file exists because a correct, tested, unreachable `withdraw()` shipped once
  // already.
  const code = (p: string) =>
    readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('runs inside the ops cycle', () => {
    expect(code('lib/ops-cycle.ts')).toContain('sweepWithdrawals')
  })

  it('takes its own lease, so it cannot stall the deadline sweep', () => {
    const src = code('lib/withdraw-sweep.ts')
    expect(src).toContain("acquireOpsLease('withdrawals'")
    expect(src).not.toContain("acquireOpsLease('deadlines'")
  })

  it('no-ops entirely against a V1 market', () => {
    // V1 pays by transfer and has no `withdrawable` at all, so calling this
    // there is not merely useless — it would read a function that does not
    // exist on that contract.
    expect(code('lib/withdraw-sweep.ts')).toMatch(/isV2Market[\s\S]{0,120}not a v2 market/)
  })

  it('catches each withdrawal individually', () => {
    // These are independent creditors. One that reverts — a token blocklist, a
    // broken account — must not stop the others, and since the batch is sorted
    // largest-first and capped, an uncaught throw would permanently starve
    // everyone behind the failing entry.
    const src = code('lib/withdraw-sweep.ts')
    expect(src).toMatch(/for \(const w of batch\)[\s\S]{0,200}try \{[\s\S]{0,120}catch/)
  })
})
