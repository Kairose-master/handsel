import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  planSponsorship,
  LOCAL_GAS_TARGET_WEI,
  LOCAL_GAS_MAX_TOPUP_WEI,
  LOCAL_GAS_POOL_RESERVE_WEI,
  LOCAL_GAS_WINDOW_BUDGET_WEI,
} from '@/lib/local-paymaster'
import { AGENT_GAS_FLOOR } from '@/lib/onchain/account'

function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const RICH = LOCAL_GAS_POOL_RESERVE_WEI + LOCAL_GAS_WINDOW_BUDGET_WEI * 10n

describe('planSponsorship', () => {
  it('tops an empty agent up to a working balance', () => {
    const plan = planSponsorship({ heldWei: 0n, poolHeldWei: RICH, spentInWindowWei: 0n })
    expect(plan.sponsor).toBe(true)
    if (plan.sponsor) expect(plan.amountWei).toBe(LOCAL_GAS_TARGET_WEI)
  })

  it('does nothing for an agent already above the floor', () => {
    expect(planSponsorship({ heldWei: AGENT_GAS_FLOOR, poolHeldWei: RICH, spentInWindowWei: 0n })).toMatchObject({
      sponsor: false,
      why: 'already-funded',
    })
  })

  it('stops when the daily budget is spent', () => {
    // The budget is the guard that bond cover gets from the assignment gate.
    // Gas is needed for EVERY write, including work claimed from strangers, so
    // there is no per-job condition to hang this on — a runaway auto-miner has
    // to burn a bounded number instead of a wallet.
    expect(
      planSponsorship({ heldWei: 0n, poolHeldWei: RICH, spentInWindowWei: LOCAL_GAS_WINDOW_BUDGET_WEI }),
    ).toMatchObject({ sponsor: false, why: 'over-window-budget' })
  })

  it('leaves a reserve in the pool so it can still send', () => {
    // The top-up is itself a UserOperation paid out of the pool's balance. A
    // pool drained to zero cannot fund anything, including its own rescue.
    expect(
      planSponsorship({ heldWei: 0n, poolHeldWei: LOCAL_GAS_POOL_RESERVE_WEI, spentInWindowWei: 0n }),
    ).toMatchObject({ sponsor: false, why: 'pool-too-low' })
  })

  it('clamps to whichever ceiling binds first, rather than refusing', () => {
    // A partial top-up that clears the floor is still an agent that can work.
    // Refusing outright would make a nearly-exhausted budget behave like no
    // budget at all.
    const nearlySpent = LOCAL_GAS_WINDOW_BUDGET_WEI - AGENT_GAS_FLOOR * 2n
    const plan = planSponsorship({ heldWei: 0n, poolHeldWei: RICH, spentInWindowWei: nearlySpent })
    expect(plan.sponsor).toBe(true)
    if (plan.sponsor) expect(plan.amountWei).toBe(AGENT_GAS_FLOOR * 2n)
  })

  it('refuses a top-up too small to lift the agent over the floor', () => {
    // Below the floor the transfer buys nothing: the agent still cannot act,
    // and the gas spent sending it is wasted twice.
    const nearlySpent = LOCAL_GAS_WINDOW_BUDGET_WEI - (AGENT_GAS_FLOOR - 1n)
    expect(planSponsorship({ heldWei: 0n, poolHeldWei: RICH, spentInWindowWei: nearlySpent })).toMatchObject({
      sponsor: false,
      why: 'nothing-worth-sending',
    })
  })

  it('never sends more than the per-top-up cap', () => {
    const plan = planSponsorship({
      heldWei: 0n,
      poolHeldWei: RICH,
      spentInWindowWei: 0n,
      budgetWei: LOCAL_GAS_WINDOW_BUDGET_WEI * 1000n,
    })
    expect(plan.sponsor).toBe(true)
    if (plan.sponsor) expect(plan.amountWei).toBeLessThanOrEqual(LOCAL_GAS_MAX_TOPUP_WEI)
  })
})

describe('the bounds are coherent with each other', () => {
  it('targets a working balance, not the bare floor', () => {
    expect(LOCAL_GAS_TARGET_WEI).toBeGreaterThan(AGENT_GAS_FLOOR)
  })

  it('caps a single top-up at or above what one top-up needs', () => {
    // A cap below the target would silently make every sponsorship partial.
    expect(LOCAL_GAS_MAX_TOPUP_WEI).toBeGreaterThanOrEqual(LOCAL_GAS_TARGET_WEI)
  })

  it('gives the daily budget room for several agents', () => {
    // A budget that funds one agent a day is a budget that reads as broken.
    expect(LOCAL_GAS_WINDOW_BUDGET_WEI).toBeGreaterThanOrEqual(LOCAL_GAS_TARGET_WEI * 5n)
  })

  it('bounds an env-supplied budget rather than trusting it', () => {
    // An unparseable or absurd env var must not become an unbounded spend of
    // someone's ether.
    const src = readFileSync('lib/local-paymaster.ts', 'utf8')
    expect(src).toContain('Math.min(parsed, 0.1)')
    expect(LOCAL_GAS_WINDOW_BUDGET_WEI).toBeLessThanOrEqual(BigInt(1e17))
  })
})

describe('what sponsorship is gated on', () => {
  const src = codeOnly(readFileSync('lib/local-paymaster.ts', 'utf8'))
  const body = src.slice(src.indexOf('export async function sponsorAgentGas'))

  it('sponsors nothing until the owner names a pool', () => {
    // Opt-in is the first bound. Never "helpfully" drained from whichever
    // wallet happened to have money in it.
    expect(body).toContain("why: 'no-pool'")
    expect(body).toContain('poolRow.enabled')
  })

  it('re-checks that the pool still belongs to the same owner', () => {
    // A designation outlives the agent it names, and an agent can change hands.
    expect(body).toContain('source.userId !== me.userId')
  })

  it('refuses to fund the pool out of itself', () => {
    expect(body).toContain("poolRow.sourceAgentId === agentId")
  })

  it('guards against recursing through its own transfer', () => {
    // The top-up is a transfer FROM the pool, which goes through the very send
    // path that asks for sponsorship. Without the guard one empty agent
    // recurses until the stack gives out.
    expect(body).toContain('inFlight.add(agentId)')
    expect(body).toContain('inFlight.add(poolRow.sourceAgentId)')
    expect(body).toContain('finally')
  })

  it('records the spend before sending it', () => {
    // A top-up that lands and is not recorded is one the budget hands out
    // again — the same discipline as every other spend in this codebase.
    const insertAt = body.indexOf('INSERT INTO account_gas_sponsorship')
    const sendAt = body.indexOf('transferEth(')
    expect(insertAt).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(insertAt)
  })

  it('never throws into its caller', () => {
    expect(body).not.toMatch(/\bthrow\b/)
  })
})

describe('where it is called from', () => {
  const account = readFileSync('lib/onchain/account.ts', 'utf8')
  const mine = codeOnly(readFileSync('lib/auto-mine.ts', 'utf8'))

  it('sits in the kernel path, where self-pay would otherwise fail', () => {
    // ensureAgentGas is the EOA-mode equivalent and spends the OPERATOR's
    // ether, which is why it is budget-gated and would refuse exactly here.
    // This spends the account's own, so that budget has no claim on it.
    const selfPay = account.slice(account.indexOf('if (!sponsored) {'))
    expect(selfPay).toContain('sponsorAgentGas')
  })

  it('re-reads the balance instead of assuming the top-up landed', () => {
    const selfPay = account.slice(account.indexOf('if (!sponsored) {'))
    const after = selfPay.slice(selfPay.indexOf('sponsorAgentGas'))
    expect(after).toContain('getBalance')
  })

  it('still throws when sponsorship did not happen', () => {
    const selfPay = account.slice(account.indexOf('if (!sponsored) {'))
    expect(selfPay).toContain('throw new Error')
  })

  it('runs in the miner preflight, not only at send time', () => {
    // The preflight exists to answer the gas question once instead of once per
    // candidate job. An agent sponsored on its first accept would otherwise be
    // skipped for the whole tick that could have funded it.
    expect(mine).toContain('sponsorAgentGas')
    const pre = mine.slice(mine.indexOf('agentGasReadiness'))
    expect(pre.indexOf('sponsorAgentGas')).toBeLessThan(pre.indexOf('skipping its sweep'))
  })
})
