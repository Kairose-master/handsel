import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain } from './helpers/evm'

/**
 * LaborMarketV2 against a token and a registry that misbehave.
 *
 * The main EVM suite exercises the state machine with a well-behaved ERC-20 and
 * a registry that always answers. Both assumptions are false on Base:
 *
 *   - **USDC is upgradeable by Circle and enforces a blocklist.** A frozen
 *     address can neither send nor receive, and nobody in the market gets a
 *     vote on it.
 *   - **`registry` is immutable and called from `acceptJob`.**
 *
 * These are the failures nobody in the market causes and nobody in the market
 * can undo, which is what makes them worth a file of their own.
 *
 * ## What this file caught
 *
 * Written first against the PUSH-payment design, where every settlement ended
 * in `require(usdc.transfer(...))`. Every case below passed as a demonstration
 * that settlement was blockable:
 *
 *   blocked worker    -> approveJob, resolveDispute(true), expireDispute revert
 *   blocked requester -> cancelJob, reclaimJob, expireReview revert — the last
 *                        one taking the WORKER's forfeit down with it
 *   blocked payee     -> every settlement route reverts
 *   blocked feeRecip. -> every postJob reverts; the market accepts no work
 *
 * That is residual risk R1 — frozen escrow, no exit — reintroduced through the
 * token, after the state machine had been built specifically to make it
 * impossible. Three permissionless timeouts are worth nothing if the timeout
 * itself cannot execute.
 *
 * The contract now CREDITS on settlement and pays on `withdraw`. Every test
 * below was inverted to assert the opposite of what it used to: the job
 * settles, the unblocked parties are paid, and the blocked one's balance waits
 * for it. They are kept in their original shape on purpose — a regression to
 * push payments turns this whole file red at once.
 */

const BOUNTY = 1_000_000n
const WINDOW = 3600
const REVIEW_WINDOW = 7 * 24 * 3600
const DISPUTE_WINDOW = 14 * 24 * 3600
const FEE_BPS = 200n
const FORFEIT = BOUNTY / 10n
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)
const ZERO = '0x0000000000000000000000000000000000000000'

type Ctx = {
  chain: Chain
  usdc: `0x${string}`
  registry: `0x${string}`
  market: `0x${string}`
}

type Who = 'requester' | 'worker' | 'stranger' | 'arbiter' | 'lender'

async function setup(registryKind = 'TestRegistry'): Promise<Ctx> {
  const chain = await Chain.create()
  const usdc = await chain.deploy('BlocklistUSDC')
  const registry = await chain.deploy(registryKind)
  const market = await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter, FEE_BPS, ACCOUNTS.house])
  await chain.send('requester', usdc, 'BlocklistUSDC', 'mint', [ACCOUNTS.requester, BOUNTY * 100n])
  await chain.send('requester', usdc, 'BlocklistUSDC', 'approve', [market, BOUNTY * 100n])
  return { chain, usdc, registry, market }
}

let ctx: Ctx
beforeEach(async () => {
  ctx = await setup()
})

const send = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.send(who, ctx.market, 'LaborMarketV2', m, a as never)
const fails = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', m, a as never)
const block = (who: string, value = true) =>
  ctx.chain.send('requester', ctx.usdc, 'BlocklistUSDC', 'setBlocked', [who, value])
const claimable = (who: string) =>
  ctx.chain.call<bigint>('stranger', ctx.market, 'LaborMarketV2', 'withdrawable', [who])
const wallet = (who: string) =>
  ctx.chain.call<bigint>('stranger', ctx.usdc, 'BlocklistUSDC', 'balanceOf', [who])
const solvency = () => ctx.chain.call<unknown[]>('stranger', ctx.market, 'LaborMarketV2', 'escrowSolvency')

async function post(): Promise<bigint> {
  await send('requester', 'postJob', [BOUNTY, 0n, SPEC, WINDOW])
  return ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
}
async function delivered(): Promise<bigint> {
  const id = await post()
  await send('worker', 'acceptJob', [id])
  await send('worker', 'submitWork', [id, RESULT])
  return id
}

describe('a blocklisted WORKER', () => {
  it('does not stop the job settling', async () => {
    const id = await delivered()
    await block(ACCOUNTS.worker)

    await send('requester', 'approveJob', [id]) // used to revert
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY)
  })

  it('does not stop the arbiter, or the deadline backstop', async () => {
    const id = await delivered()
    await block(ACCOUNTS.worker)
    await send('requester', 'raiseDispute', [id])
    ctx.chain.advance(DISPUTE_WINDOW)
    await send('stranger', 'expireDispute', [id]) // used to revert
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY)
  })

  it('can still be paid, by naming an address the token has not frozen', async () => {
    // USDC checks the sender and the recipient of a transfer. The sender here
    // is the contract, so a frozen party that names an unfrozen one is paid —
    // otherwise crediting would only have moved the trap from the job to the
    // balance.
    const id = await delivered()
    await block(ACCOUNTS.worker)
    await send('requester', 'approveJob', [id])

    expect(await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'withdraw')).toBeTruthy()
    await send('worker', 'withdrawTo', [ACCOUNTS.otherWorker])
    expect(await wallet(ACCOUNTS.otherWorker)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.worker)).toBe(0n)
  })
})

describe('a blocklisted REQUESTER', () => {
  it('does not stop its own refund from being settled', async () => {
    const id = await post()
    await block(ACCOUNTS.requester)
    await send('requester', 'cancelJob', [id]) // used to revert
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
  })

  it('does not stop a permissionless reclaim', async () => {
    const id = await post()
    await send('worker', 'acceptJob', [id])
    await block(ACCOUNTS.requester)
    ctx.chain.advance(WINDOW)
    await send('stranger', 'reclaimJob', [id]) // used to revert
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
  })

  it('no longer takes the WORKER’s forfeit down with it', async () => {
    // The worst of the old bricks: expireReview pays the worker side AND
    // refunds the requester in one transaction, so a frozen requester denied
    // the worker a forfeit it was owed and had no part in.
    const id = await delivered()
    await block(ACCOUNTS.requester)
    ctx.chain.advance(REVIEW_WINDOW)
    await send('stranger', 'expireReview', [id]) // used to revert

    expect(await claimable(ACCOUNTS.worker)).toBe(FORFEIT)
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY - FORFEIT)
    await send('worker', 'withdraw') // and the worker is paid immediately
    expect(await wallet(ACCOUNTS.worker)).toBe(FORFEIT)
  })
})

describe('a blocklisted LENDER', () => {
  it('no longer bricks every settlement route', async () => {
    const id = await post()
    await send('worker', 'acceptJob', [id])
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, BOUNTY / 2n])
    await send('worker', 'submitWork', [id, RESULT])
    await block(ACCOUNTS.lender)

    await send('requester', 'approveJob', [id]) // used to revert
    expect(await claimable(ACCOUNTS.lender)).toBe(BOUNTY / 2n)
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY / 2n)

    // The worker is not made to wait for its lender's problem.
    await send('worker', 'withdraw')
    expect(await wallet(ACCOUNTS.worker)).toBe(BOUNTY / 2n)
  })
})

describe('a blocklisted FEE RECIPIENT', () => {
  it('no longer stops the market from accepting work', async () => {
    // The fee used to be transferred inside postJob, putting a third party
    // nobody chose on the critical path of every single posting.
    await block(ACCOUNTS.house)
    const id = await post() // used to revert
    expect(id).toBe(1n)
    expect(await claimable(ACCOUNTS.house)).toBe((BOUNTY * FEE_BPS) / 10_000n)
  })
})

describe('a registry that refuses to answer', () => {
  beforeEach(async () => {
    ctx = await setup('RevertingRegistry')
  })

  it('no longer stops ungated jobs being accepted', async () => {
    // minScore 0: the gate was never going to reject anyone, so an unreadable
    // score changes nothing and the market keeps working.
    const id = await post()
    await send('worker', 'acceptJob', [id]) // used to revert
    expect(Number((await ctx.chain.call<unknown[]>('stranger', ctx.market, 'LaborMarketV2', 'jobs', [id]))[4])).toBe(1)
  })

  it('refuses a GATED job rather than guessing, and says which', async () => {
    // The requester asked for a guarantee that cannot be checked. Refusing is
    // "never act on missing evidence"; the distinct error matters because
    // ScoreTooLow(0, n) would blame the worker for the registry being down.
    await send('requester', 'postJob', [BOUNTY, 700n, SPEC, WINDOW])
    const id = await ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
    expect(await fails('worker', 'acceptJob', [id])).toContain('RegistryUnavailable')
  })

  it('never freezes escrow — an Open job still refunds', async () => {
    // The market stopping is survivable. The market stopping WITH the money
    // inside is R1. Pinned so the distinction cannot quietly erode.
    const id = await post()
    await send('requester', 'cancelJob', [id])
    await send('requester', 'withdraw')
    expect(await claimable(ACCOUNTS.requester)).toBe(0n)
  })
})

describe('the credit ledger itself', () => {
  it('refuses an empty withdrawal instead of emitting a no-op', async () => {
    expect(await fails('stranger', 'withdraw')).toContain('NothingToWithdraw')
  })

  it('refuses to withdraw to the zero address', async () => {
    const id = await delivered()
    await send('requester', 'approveJob', [id])
    expect(await fails('worker', 'withdrawTo', [ZERO])).toContain('ZeroPayee')
  })

  it('cannot be drained twice', async () => {
    const id = await delivered()
    await send('requester', 'approveJob', [id])
    await send('worker', 'withdraw')
    expect(await fails('worker', 'withdraw')).toContain('NothingToWithdraw')
    expect(await wallet(ACCOUNTS.worker)).toBe(BOUNTY)
  })

  it('accumulates across jobs, so one withdrawal collects many settlements', async () => {
    // The answer to "pull payments cost an extra transaction": they cost one
    // per COLLECTION, not one per job, which is cheaper than a transfer per
    // settlement once a worker does more than one job.
    for (let i = 0; i < 3; i++) {
      const id = await delivered()
      await send('requester', 'approveJob', [id])
    }
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY * 3n)
    await send('worker', 'withdraw')
    expect(await wallet(ACCOUNTS.worker)).toBe(BOUNTY * 3n)
  })

  it('counts credited-but-unclaimed money as owed, not as surplus', async () => {
    // A contract holding settled money it has not yet handed over is not
    // over-collateralised, and a solvency number that flatters is worse than
    // none.
    const id = await delivered()
    await send('requester', 'approveJob', [id])

    const fee = (BOUNTY * FEE_BPS) / 10_000n
    const [owed, held, surplus] = await solvency()
    // The worker's bounty AND the house's uncollected fee. Both are money the
    // contract holds and owes; neither is surplus.
    expect(owed).toBe(BOUNTY + fee)
    expect(held).toBe(BOUNTY + fee)
    expect(surplus).toBe(0n)

    await send('worker', 'withdraw')
    const [owedAfter, heldAfter] = await solvency()
    expect(owedAfter).toBe(fee)
    expect(heldAfter).toBe(fee)

    await ctx.chain.send('house', ctx.market, 'LaborMarketV2', 'withdraw')
    expect((await solvency())[0]).toBe(0n)
  })

  it('keeps the fee as a liability until the house collects it', async () => {
    await post()
    const fee = (BOUNTY * FEE_BPS) / 10_000n
    const [owed, held] = await solvency()
    expect(owed).toBe(BOUNTY + fee)
    expect(held).toBe(BOUNTY + fee)
  })
})

describe('the documented approval is the approval that works', () => {
  /**
   * The bug this pins was invisible to every other test in the repo, because
   * the shared harness grants one blanket `approve(market, BOUNTY * 100n)` and
   * then never thinks about allowance again. Over-provisioning in a fixture
   * hides exactly the class of defect where the contract asks for more than it
   * told you it would.
   *
   * So these approve the EXACT figure a reader would compute, and nothing more.
   */
  let chain: Chain
  let usdc: `0x${string}`
  let market: `0x${string}`

  beforeEach(async () => {
    chain = await Chain.create()
    usdc = await chain.deploy('BlocklistUSDC')
    const registry = await chain.deploy('TestRegistry')
    market = await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter, FEE_BPS, ACCOUNTS.house])
    await chain.send('requester', usdc, 'BlocklistUSDC', 'mint', [ACCOUNTS.requester, BOUNTY * 10n])
  })

  const approveExactly = (amount: bigint) =>
    chain.send('requester', usdc, 'BlocklistUSDC', 'approve', [market, amount])
  const tryPost = () =>
    chain.revertReason('requester', market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, WINDOW])

  it('reverts when the caller approves only the bounty', async () => {
    // The NatSpec used to say to approve exactly this. On a deployment with a
    // non-zero fee that instruction fails on the first attempt and every one
    // after — and the contract cannot be upgraded to correct itself.
    await approveExactly(BOUNTY)
    expect(await tryPost()).toBeTruthy()
  })

  it('succeeds on postCost(bounty), which is what the NatSpec now says', async () => {
    const cost = await chain.call<bigint>('requester', market, 'LaborMarketV2', 'postCost', [BOUNTY])
    expect(cost).toBe(BOUNTY + (BOUNTY * FEE_BPS) / 10_000n)
    await approveExactly(cost)
    await chain.send('requester', market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, WINDOW])
    expect(await chain.call<bigint>('requester', market, 'LaborMarketV2', 'jobCount')).toBe(1n)
  })

  it('is just the bounty on a zero-fee deployment, so testnets read the same way', async () => {
    const free = await chain.deploy('LaborMarketV2', [usdc, await chain.deploy('TestRegistry'), ACCOUNTS.arbiter, 0n, ZERO])
    expect(await chain.call<bigint>('requester', free, 'LaborMarketV2', 'postCost', [BOUNTY])).toBe(BOUNTY)
  })
})
