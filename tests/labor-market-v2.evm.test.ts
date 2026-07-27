import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain } from './helpers/evm'

/**
 * LaborMarketV2 exercised in a real EVM.
 *
 * The claims made in that contract's comments — permissionless exits, an
 * irrevocable assignment, a late delivery that cannot double-settle — are
 * claims about executed bytecode, and a comment cannot establish any of them.
 * This is where they are either true or not.
 */

const BOUNTY = 1_000_000n // 1 USDC at 6 decimals
const WINDOW = 3600 // 1 hour delivery window
const REVIEW_WINDOW = 7 * 24 * 3600
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)

const Status = {
  Open: 0,
  Accepted: 1,
  Submitted: 2,
  Completed: 3,
  Cancelled: 4,
  Disputed: 5,
  Refunded: 6,
} as const

type Ctx = {
  chain: Chain
  usdc: `0x${string}`
  registry: `0x${string}`
  market: `0x${string}`
}

async function setup(): Promise<Ctx> {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter])
  await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS.requester, BOUNTY * 100n])
  await chain.send('requester', usdc, 'TestUSDC', 'approve', [market, BOUNTY * 100n])
  return { chain, usdc, registry, market }
}

async function post(ctx: Ctx, window = WINDOW): Promise<bigint> {
  await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, window])
  return ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
}

const job = (ctx: Ctx, id: bigint) =>
  ctx.chain.call<unknown[]>('requester', ctx.market, 'LaborMarketV2', 'jobs', [id])

const status = async (ctx: Ctx, id: bigint) => Number((await job(ctx, id))[4])
const payee = async (ctx: Ctx, id: bigint) => String((await job(ctx, id))[10]).toLowerCase()
const balance = (ctx: Ctx, who: `0x${string}`) =>
  ctx.chain.call<bigint>('requester', ctx.usdc, 'TestUSDC', 'balanceOf', [who])

let ctx: Ctx
beforeEach(async () => {
  ctx = await setup()
})

describe('the happy path still works', () => {
  it('escrows on post, releases to the worker on approve', async () => {
    const before = await balance(ctx, ACCOUNTS.requester)
    const id = await post(ctx)
    expect(await balance(ctx, ctx.market)).toBe(BOUNTY)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before - BOUNTY)

    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'approveJob', [id])

    expect(await status(ctx, id)).toBe(Status.Completed)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY)
    expect(await balance(ctx, ctx.market)).toBe(0n)
  })

  it('refuses a worker whose score is below the job threshold', async () => {
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'postJob', [BOUNTY, 700n, SPEC, WINDOW])
    const id = await ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
    expect(await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])).toBeTruthy()

    await ctx.chain.send('requester', ctx.registry, 'TestRegistry', 'setScore', [ACCOUNTS.worker, 700n])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(await status(ctx, id)).toBe(Status.Accepted)
  })

  it('will not let the requester work its own job', async () => {
    const id = await post(ctx)
    expect(await ctx.chain.revertReason('requester', ctx.market, 'LaborMarketV2', 'acceptJob', [id])).toBeTruthy()
  })
})

describe('reclaimJob — the exit from Accepted that v1 did not have', () => {
  it('refuses before the deadline', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW - 1)
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])).toContain('TooEarly')
    expect(await status(ctx, id)).toBe(Status.Accepted)
  })

  it('refunds the requester once the deadline passes', async () => {
    const before = await balance(ctx, ACCOUNTS.requester)
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)

    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    expect(await status(ctx, id)).toBe(Status.Refunded)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before)
    expect(await balance(ctx, ctx.market)).toBe(0n)
  })

  it('IS permissionless — a stranger with no relationship to the job can call it', async () => {
    // This is the property that stops the operator being a custodian. If it
    // ever regresses to "requester only", a user who cannot reach the operator
    // has no way to recover their own escrow.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    expect(await status(ctx, id)).toBe(Status.Refunded)
  })

  it('cannot be replayed for a second refund', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])).toBeTruthy()
    expect(await balance(ctx, ctx.market)).toBe(0n)
  })

  it('does not apply to an Open job — cancelJob is that path', async () => {
    const id = await post(ctx)
    ctx.chain.advance(WINDOW * 10)
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])).toBeTruthy()
  })

  it('reclaimable() agrees with what reclaimJob actually does', async () => {
    // The off-chain warner reads this instead of keeping its own clock; two
    // clocks disagreeing is how the original incident happened.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(await ctx.chain.call<boolean>('stranger', ctx.market, 'LaborMarketV2', 'reclaimable', [id])).toBe(false)
    ctx.chain.advance(WINDOW)
    expect(await ctx.chain.call<boolean>('stranger', ctx.market, 'LaborMarketV2', 'reclaimable', [id])).toBe(true)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    expect(await ctx.chain.call<boolean>('stranger', ctx.market, 'LaborMarketV2', 'reclaimable', [id])).toBe(false)
  })
})

describe('the late delivery race — the question put to Olas in mech#470', () => {
  it('a submission that lands first makes the reclaim revert', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)

    // Worker submits at exactly the deadline; reclaim was also eligible.
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])).toBeTruthy()
    expect(await status(ctx, id)).toBe(Status.Submitted)
  })

  it('a reclaim that lands first makes the submission revert', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)

    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    expect(await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])).toBeTruthy()
    expect(await status(ctx, id)).toBe(Status.Refunded)
  })

  it('never settles twice, whichever order they arrive in', async () => {
    // The failure this prevents is two deliveries paid for one request, which
    // is the shape the Olas take-over question was about.
    const before = await balance(ctx, ACCOUNTS.requester)
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    ctx.chain.advance(WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])
    await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])

    expect(await balance(ctx, ctx.market)).toBe(0n)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })
})

describe('expireReview — the mirror stall, when the requester goes silent', () => {
  it('refuses before the review window closes', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW - 1)
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])).toContain('TooEarly')
  })

  it('refunds — deliberately, not fairly', async () => {
    // Paying out on silence would make "submit anything and wait" a way to
    // extract escrow with no grader ever passing the work.
    const before = await balance(ctx, ACCOUNTS.requester)
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)

    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])
    expect(await status(ctx, id)).toBe(Status.Refunded)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })

  it('does not reach a disputed job — that belongs to the arbiter', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    ctx.chain.advance(REVIEW_WINDOW * 10)
    expect(await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])).toBeTruthy()
    expect(await status(ctx, id)).toBe(Status.Disputed)
  })
})

describe('assignPayee — the lien', () => {
  it('pays the lender instead of the worker on approve', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'approveJob', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(BOUNTY)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })

  it('is honoured on the dispute route too, not only on approve', async () => {
    // v1 released in two places with duplicated logic. A lien honoured on one
    // settlement path and forgotten on the other is not a lien.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    await ctx.chain.send('arbiter', ctx.market, 'LaborMarketV2', 'resolveDispute', [id, true])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(BOUNTY)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })

  it('IS irrevocable — the worker cannot reassign it', async () => {
    // A revocable assignment is a promise, and the borrower already had one.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.otherWorker]),
    ).toContain('PayeeAlreadySet')
    expect(await payee(ctx, id)).toBe(ACCOUNTS.lender.toLowerCase())
  })

  it('cannot be set by anyone but the worker', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    for (const who of ['requester', 'stranger', 'arbiter'] as const) {
      expect(
        await ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.stranger]),
      ).toContain('NotWorker')
    }
  })

  it('cannot be set after submission — security has to exist when the money is advanced', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender]),
    ).toBeTruthy()
  })

  it('rejects the zero address, which would burn the release', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [
        id,
        '0x0000000000000000000000000000000000000000',
      ]),
    ).toContain('ZeroPayee')
  })

  it('does NOT protect the lender from a refund — the risk the LTV prices', async () => {
    // Stated in the contract comment; asserted here so it stays true.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender])
    ctx.chain.advance(WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(0n)
    expect(await status(ctx, id)).toBe(Status.Refunded)
  })
})

describe('the delivery window is bounded by the contract, not by the requester', () => {
  it('rejects a window below the floor — a trap that allows instant reclaim', async () => {
    expect(
      await ctx.chain.revertReason('requester', ctx.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, 1]),
    ).toContain('BadWindow')
  })

  it('rejects a window above the ceiling — frozen escrow wearing a number', async () => {
    expect(
      await ctx.chain.revertReason('requester', ctx.market, 'LaborMarketV2', 'postJob', [
        BOUNTY,
        0n,
        SPEC,
        31 * 24 * 3600,
      ]),
    ).toContain('BadWindow')
  })

  it('does not escrow anything when the window is rejected', async () => {
    const before = await balance(ctx, ACCOUNTS.requester)
    await ctx.chain.revertReason('requester', ctx.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, 1])
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before)
    expect(await balance(ctx, ctx.market)).toBe(0n)
  })
})

describe('what v2 deliberately did not change', () => {
  it('only the arbiter can resolve a dispute', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    for (const who of ['requester', 'worker', 'stranger'] as const) {
      expect(
        await ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', 'resolveDispute', [id, true]),
      ).toContain('NotArbiter')
    }
    await ctx.chain.send('arbiter', ctx.market, 'LaborMarketV2', 'resolveDispute', [id, false])
    expect(await status(ctx, id)).toBe(Status.Refunded)
  })

  it('no timeout can release money to a worker — only a person can', async () => {
    // Both exits refund. If a future change ever makes a deadline PAY, the
    // grader stops being the thing that decides whether work was worth buying.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })
})
