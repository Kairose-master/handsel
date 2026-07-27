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
  Expired: 7,
} as const

/** What a silent requester forfeits to the worker side: SILENCE_FORFEIT_BPS. */
const FORFEIT = BOUNTY / 10n

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

// Positions in the generated `jobs` getter. Named rather than inlined, because
// adding a struct field shifts every literal index after it — which is how a
// test starts reading the wrong word and goes on passing.
const FIELD = { status: 4, payee: 11 } as const

const status = async (ctx: Ctx, id: bigint) => Number((await job(ctx, id))[FIELD.status])
const payee = async (ctx: Ctx, id: bigint) => String((await job(ctx, id))[FIELD.payee]).toLowerCase()
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

  it('refunds MOST of it, and charges the requester a tenth for the silence', async () => {
    // Free is not neutral, it is dominant. The requester already holds the
    // deliverable; approving costs gas, disputing costs gas, and saying nothing
    // used to pay. Paying the full bounty out instead would make "submit
    // anything and wait" a way to extract escrow with no grader involved, so
    // neither extreme is right.
    const before = await balance(ctx, ACCOUNTS.requester)
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)

    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])
    expect(await status(ctx, id)).toBe(Status.Expired)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(FORFEIT)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(before - FORFEIT)
    expect(await balance(ctx, ctx.market)).toBe(0n) // the escrow is fully distributed
  })

  it('is its own state, not Refunded — the balances do not match a refund', async () => {
    // A reconciler reading `Refunded` would expect the whole bounty back and
    // find 90%, then have to decide whether that was a bug or a theft. And
    // nobody graded this work, so the credit engine must not score it as a
    // worker failure.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])

    expect(await status(ctx, id)).not.toBe(Status.Refunded)
    expect(await status(ctx, id)).not.toBe(Status.Completed)
  })

  it('prices the silence BEFORE it is levied, while there is time to act', async () => {
    // A charge a party cannot see coming is a penalty. This is not one.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    const split = await ctx.chain.call<unknown[]>('requester', ctx.market, 'LaborMarketV2', 'expirySplit', [id])
    expect(split[0]).toBe(BOUNTY - FORFEIT)
    expect(split[2]).toBe(FORFEIT)
  })

  it('pays the forfeit to the LENDER first when the worker pledged the job', async () => {
    // The advance ($400k of a $1M bounty) exceeds the forfeit, so the lender
    // takes all of it. Paying the borrower ahead of its own secured lender out
    // of the same collateral is what a lien exists to prevent — and it would
    // let a THIRD party's inaction strip the lender's security.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender, BOUNTY / 2n])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(FORFEIT)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })

  it('leaves the worker the remainder once a small lien is satisfied', async () => {
    const id = await post(ctx)
    const small = FORFEIT / 4n
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender, small])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(small)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(FORFEIT - small)
  })

  it('rounds the forfeit DOWN rather than reverting on a cent-scale bounty', async () => {
    // A settlement that cannot execute is worse than a forfeit that does not
    // apply, and the mainnet plan turns on very small bounties.
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'postJob', [1n, 0n, SPEC, WINDOW])
    const id = await ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [id])

    expect(await status(ctx, id)).toBe(Status.Expired)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
    expect(await balance(ctx, ctx.market)).toBe(0n)
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

describe('assignPayee — the lien, and the size of it', () => {
  /** A lender advancing 40% of the bounty — the shape the LTV actually takes. */
  const ADVANCE = (BOUNTY * 40n) / 100n
  const assign = (id: bigint, amount = ADVANCE, to: string = ACCOUNTS.lender) =>
    ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, to, amount])

  it('pays the lender its advance and the WORKER the rest, in one release', async () => {
    // The property that makes this security rather than a transfer of risk.
    // Sole-payee assignment would send the lender the full bounty and leave it
    // owing the worker the remainder — off-chain, unsecured, in the opposite
    // direction. The worker would have swapped funding risk for counterparty
    // risk on its own lender.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'approveJob', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(ADVANCE)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY - ADVANCE)
  })

  it('never pays out more than the job escrowed', async () => {
    // The invariant that keeps one job's release from reaching another job's
    // money. Two jobs live, one settles: the contract must still hold the other.
    const first = await post(ctx)
    const second = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [first])
    await assign(first, BOUNTY)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [first, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'approveJob', [first])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(BOUNTY)
    expect(await balance(ctx, ctx.market)).toBe(BOUNTY) // the second job, untouched
    expect(await status(ctx, second)).toBe(Status.Open)
  })

  it('tells the lender what it is owed, so the lender never recomputes the split', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    const split = await ctx.chain.call<unknown[]>('lender', ctx.market, 'LaborMarketV2', 'releaseSplit', [id])
    expect(String(split[0]).toLowerCase()).toBe(ACCOUNTS.lender.toLowerCase())
    expect(split[1]).toBe(ADVANCE)
    expect(split[2]).toBe(BOUNTY - ADVANCE)
  })

  it('reports the whole bounty to the worker when nothing is assigned', async () => {
    const id = await post(ctx)
    const split = await ctx.chain.call<unknown[]>('worker', ctx.market, 'LaborMarketV2', 'releaseSplit', [id])
    expect(split[1]).toBe(0n)
    expect(split[2]).toBe(BOUNTY)
  })

  it('is honoured on the dispute route too, not only on approve', async () => {
    // v1 released in two places with duplicated logic. A lien honoured on one
    // settlement path and forgotten on the other is not a lien.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    await ctx.chain.send('arbiter', ctx.market, 'LaborMarketV2', 'resolveDispute', [id, true])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(ADVANCE)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY - ADVANCE)
  })

  it('IS irrevocable — the worker cannot reassign it', async () => {
    // A revocable assignment is a promise, and the borrower already had one.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [
        id,
        ACCOUNTS.otherWorker,
        1n,
      ]),
    ).toContain('PayeeAlreadySet')
    expect(await payee(ctx, id)).toBe(ACCOUNTS.lender.toLowerCase())
  })

  it('cannot be resized either — a shrinkable claim is not a claim', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender, 1n]),
    ).toContain('PayeeAlreadySet')
  })

  it('cannot be set by anyone but the worker', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    for (const who of ['requester', 'stranger', 'arbiter'] as const) {
      expect(
        await ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', 'assignPayee', [
          id,
          ACCOUNTS.stranger,
          ADVANCE,
        ]),
      ).toContain('NotWorker')
    }
  })

  it('cannot be set after submission — security has to exist when the money is advanced', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [
        id,
        ACCOUNTS.lender,
        ADVANCE,
      ]),
    ).toBeTruthy()
  })

  it('rejects the zero address, which would burn the release', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [
        id,
        '0x0000000000000000000000000000000000000000',
        ADVANCE,
      ]),
    ).toContain('ZeroPayee')
  })

  it('rejects a claim the escrow cannot honour, at assignment rather than at release', async () => {
    // Discovering an over-assignment at release time is discovering it after
    // the lender has already advanced against it.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [
        id,
        ACCOUNTS.lender,
        BOUNTY + 1n,
      ]),
    ).toContain('BadPayeeAmount')
  })

  it('rejects a zero advance, which would consume the one slot and secure nothing', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender, 0n]),
    ).toContain('BadPayeeAmount')
  })

  it('does NOT protect the lender from a refund — the risk the LTV prices', async () => {
    // Stated in the contract comment; asserted here so it stays true.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await assign(id)
    ctx.chain.advance(WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'reclaimJob', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(0n)
    expect(await status(ctx, id)).toBe(Status.Refunded)
  })
})

describe('expireDispute — the third stall, the one the first draft missed', () => {
  const DISPUTE_WINDOW = 14 * 24 * 3600

  const contested = async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    return id
  }

  it('frees an escrow whose arbiter never ruled', async () => {
    // Before this existed, Disputed had exactly one door and it needed an
    // immutable arbiter with no setter. A lost key froze every contested
    // escrow forever — which is R1, in the contract written to fix R1.
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id])
    expect(await status(ctx, id)).toBe(Status.Expired)
  })

  it('does NOT call it Completed — the arbiter vanished, nobody judged the work', async () => {
    // Completed is what a grader's approval produces. Reaching it by timeout
    // would tell the credit engine a verdict exists when what happened is that
    // nobody showed up.
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id])
    expect(await status(ctx, id)).not.toBe(Status.Completed)
  })

  it('releases to the WORKER, because a failed escalation must not pay the escalator', async () => {
    // Only the requester can dispute. If silence refunded them, raiseDispute
    // would be a free refund button on a two-week delay — strictly better for
    // a dishonest requester than waiting out expireReview, and every honest
    // worker's escrow would be revocable at will.
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id])

    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY)
    expect(await balance(ctx, ACCOUNTS.requester)).toBe(BOUNTY * 99n)
  })

  it('honours a lien on this route too', async () => {
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'assignPayee', [id, ACCOUNTS.lender, BOUNTY / 4n])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [id])
    ctx.chain.advance(DISPUTE_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id])

    expect(await balance(ctx, ACCOUNTS.lender)).toBe(BOUNTY / 4n)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY - BOUNTY / 4n)
  })

  it('does not fire one second early — the arbiter gets its full window', async () => {
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW - 1)
    expect(
      await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id]),
    ).toContain('TooEarly')
    expect(await status(ctx, id)).toBe(Status.Disputed)
  })

  it('leaves the arbiter in charge while the window is open', async () => {
    // The backstop must not become the ordinary path.
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW / 2)
    await ctx.chain.send('arbiter', ctx.market, 'LaborMarketV2', 'resolveDispute', [id, false])
    expect(await status(ctx, id)).toBe(Status.Refunded)
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(0n)
  })

  it('cannot be replayed to drain a second settlement', async () => {
    const id = await contested()
    ctx.chain.advance(DISPUTE_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id])
    expect(
      await ctx.chain.revertReason('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [id]),
    ).toContain('WrongStatus')
    expect(await balance(ctx, ACCOUNTS.worker)).toBe(BOUNTY)
  })

  it('is readable before it is callable, so the sweep keeps no clock of its own', async () => {
    const id = await contested()
    const expirable = () => ctx.chain.call<boolean>('stranger', ctx.market, 'LaborMarketV2', 'disputeExpirable', [id])
    expect(await expirable()).toBe(false)
    ctx.chain.advance(DISPUTE_WINDOW)
    expect(await expirable()).toBe(true)
  })

  it('is permissionless — no operator, no arbiter, nobody to be unavailable', async () => {
    // The missing party in this stall IS the arbiter, so requiring any named
    // caller would reintroduce exactly the dependency being removed.
    for (const who of ['worker', 'requester', 'stranger', 'lender'] as const) {
      const id = await contested()
      ctx.chain.advance(DISPUTE_WINDOW)
      await ctx.chain.send(who, ctx.market, 'LaborMarketV2', 'expireDispute', [id])
      expect(await status(ctx, id)).toBe(Status.Expired)
    }
  })
})

describe('a job that was never posted is not a job', () => {
  it('cannot be accepted, even though its status reads Open', async () => {
    // Status.Open is enum value ZERO, so every unwritten slot in the mapping
    // decodes as an open job. Nothing can be stolen — the escrow is zero — but
    // acceptJob would emit JobAccepted for it, and the credit engine scores
    // events. That is a reputation record minted out of nothing.
    expect(await status(ctx, 999_999n)).toBe(Status.Open)
    expect(
      await ctx.chain.revertReason('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [999_999n]),
    ).toContain('NoSuchJob')
  })

  it('seals the only door — every other transition needs a status a phantom cannot reach', async () => {
    const phantom = 424_242n
    for (const [who, method, args] of [
      ['worker', 'submitWork', [phantom, RESULT]],
      ['worker', 'assignPayee', [phantom, ACCOUNTS.lender, 1n]],
      ['requester', 'approveJob', [phantom]],
      ['requester', 'raiseDispute', [phantom]],
      ['requester', 'cancelJob', [phantom]],
      ['stranger', 'reclaimJob', [phantom]],
      ['stranger', 'expireReview', [phantom]],
      ['stranger', 'expireDispute', [phantom]],
      ['arbiter', 'resolveDispute', [phantom, true]],
    ] as const) {
      const reason = await ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', method, args as never)
      expect(reason, `${method} let a phantom job through`).toBeTruthy()
    }
  })
})

describe('a bounty of zero is free reputation', () => {
  it('is refused at post time', async () => {
    // A zero-bounty job escrows nothing and still emits JobAccepted and
    // JobCompleted — the raw material the credit engine scores.
    expect(
      await ctx.chain.revertReason('requester', ctx.market, 'LaborMarketV2', 'postJob', [0n, 0n, SPEC, WINDOW]),
    ).toContain('BountyTooLow')
  })

  it('leaves cent-scale bounties alone — the floor is one unit, not one dollar', async () => {
    // The mainnet plan turns on $0.01 bounties. A floor that prices out the
    // product would be a worse bug than the one it prevents.
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'postJob', [1n, 0n, SPEC, WINDOW])
    const id = await ctx.chain.call<bigint>('requester', ctx.market, 'LaborMarketV2', 'jobCount')
    expect(await status(ctx, id)).toBe(Status.Open)
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

  it('never lets a timeout claim the work was GOOD', async () => {
    // This test used to assert that no timeout can pay a worker at all, and
    // the forfeit broke it. The assertion was a proxy for the invariant, and
    // the proxy was the part that was wrong: two timeouts now move money to
    // the worker side, and neither is a verdict. What must stay true is that a
    // deadline can never mint the state a grader's approval produces.
    //
    //   Completed — someone decided the work was good
    //   Refunded  — someone decided it was not, or it never arrived
    //   Expired   — settled by a deadline; no verdict exists
    //
    // A credit engine that cannot tell "approved" from "nobody showed up" is
    // buying reputation with an absence.
    const submitted = async () => {
      const id = await post(ctx)
      await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
      await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
      return id
    }

    const silent = await submitted()
    ctx.chain.advance(REVIEW_WINDOW)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireReview', [silent])
    expect(await status(ctx, silent)).toBe(Status.Expired)

    const abandoned = await submitted()
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'raiseDispute', [abandoned])
    ctx.chain.advance(14 * 24 * 3600)
    await ctx.chain.send('stranger', ctx.market, 'LaborMarketV2', 'expireDispute', [abandoned])
    expect(await status(ctx, abandoned)).toBe(Status.Expired)

    // Only a person reaches Completed.
    const approved = await submitted()
    await ctx.chain.send('requester', ctx.market, 'LaborMarketV2', 'approveJob', [approved])
    expect(await status(ctx, approved)).toBe(Status.Completed)
  })

  it('still needs a person for every payment that means the work was accepted', async () => {
    // approveJob and resolveDispute(true) are the only two, and both name a
    // caller the contract checks.
    const id = await post(ctx)
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'acceptJob', [id])
    await ctx.chain.send('worker', ctx.market, 'LaborMarketV2', 'submitWork', [id, RESULT])
    for (const who of ['worker', 'stranger', 'arbiter', 'lender'] as const) {
      expect(
        await ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', 'approveJob', [id]),
      ).toContain('NotRequester')
    }
    expect(await status(ctx, id)).toBe(Status.Submitted)
  })
})
