import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain, marketConfig } from './helpers/evm'
import { quoteAdvance, type AdvanceCollateral } from '@/lib/advance'
import { orchestrationRecord, type OrchestrationEvent } from '@/lib/orchestration-risk'
import { V2_JOB_STATUS } from '@/lib/deadlines'

/**
 * The advance, walked against the real contract.
 *
 * `tests/advance.test.ts` proves the arithmetic is internally consistent. It
 * cannot prove the number it produces is one `assignPayee` will accept, and
 * that is the join where this feature would actually break: the quote is
 * computed in dollars with two decimals, the contract holds six-decimal USDC
 * and reverts `BadPayeeAmount` on a pledge one unit over the bounty. A pure
 * test passes either way.
 *
 * So this drives the whole sequence — post, accept, quote off the chain's own
 * numbers, pledge the quoted amount, release — and checks the money landed
 * where the quote said it would. The last test is the one the thesis is honest
 * about and this file has to be too: a refund pays the lender nothing.
 */

const USDC = 1_000_000n // 6dp
const BOUNTY = 100n * USDC
const DELIVERY_WINDOW = 4 * 3600
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)

type Ctx = { chain: Chain; usdc: `0x${string}`; market: `0x${string}` }
type Who = 'requester' | 'worker' | 'stranger' | 'arbiter' | 'lender'

let ctx: Ctx

beforeEach(async () => {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [
    usdc,
    registry,
    ACCOUNTS.arbiter,
    marketConfig({ bondBps: 0, feeBps: 0 }),
  ])
  for (const who of ['requester', 'worker'] as const) {
    await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS[who], BOUNTY * 100n])
    await chain.send(who, usdc, 'TestUSDC', 'approve', [market, BOUNTY * 100n])
  }
  ctx = { chain, usdc, market }
})

const send = (who: Who, m: string, a: unknown[] = []) => ctx.chain.send(who, ctx.market, 'LaborMarketV2', m, a as never)
const read = <T>(m: string, a: unknown[] = []) => ctx.chain.call<T>('stranger', ctx.market, 'LaborMarketV2', m, a as never)
const fails = (who: Who, m: string, a: unknown[] = []) => ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', m, a as never)
const claimable = (who: string) => read<bigint>('withdrawable', [who])

async function accepted(bounty = BOUNTY): Promise<bigint> {
  await send('requester', 'postJob', [bounty, 0n, SPEC, DELIVERY_WINDOW])
  const id = await read<bigint>('jobCount')
  await send('worker', 'acceptJob', [id])
  return id
}

/** Exactly what `lib/onchain/advance-chain.ts` builds, from the same fields. */
async function collateralOf(jobId: bigint): Promise<AdvanceCollateral> {
  const job = await read<readonly unknown[]>('jobs', [jobId])
  return {
    jobId: Number(jobId),
    contract: ctx.market,
    bountyUsd: Number(job[2] as bigint) / 1e6,
    status: V2_JOB_STATUS[Number(job[4])],
    deliveryDeadlineMs: Number(job[8] as bigint) * 1000,
    existingPayee: job[12] as string,
  }
}

const toUnits = (usd: number) => BigInt(Math.round(usd * 1e6))

const proven = (n: number, budgetUsd: number): OrchestrationEvent[] =>
  Array.from({ length: n }, () => ({
    eventType: 'DELEGATION_COMPLETED',
    delivered: 2,
    total: 2,
    budgetUsd,
    createdAt: new Date(),
  }))

describe('the quoted pledge is one the contract accepts', () => {
  it('takes the maximum advance a cold-start prime is offered', async () => {
    const id = await accepted()
    const c = await collateralOf(id)
    // The chain's own clock, not the test runner's — a deadline read in
    // seconds and compared against Date.now() is the mistake this guards.
    const q = quoteAdvance({ collateral: c, record: orchestrationRecord([]), now: c.deliveryDeadlineMs - DELIVERY_WINDOW * 1000 })
    expect(q.ok).toBe(true)
    if (!q.ok) return

    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, toUnits(q.pledgeUsd)])
    const [payee, toPayee, toWorker] = await read<readonly [string, bigint, bigint]>('releaseSplit', [id])
    expect(payee.toLowerCase()).toBe(ACCOUNTS.lender.toLowerCase())
    expect(toPayee).toBe(toUnits(q.pledgeUsd))
    expect(toWorker).toBe(toUnits(q.residualUsd))
  })

  it('takes the maximum a proven prime is offered — the ceiling case', async () => {
    // The pledge closest to the bounty the system can construct. If the LTV
    // ceiling and the fee floor ever multiply past 1, this is where it shows
    // up as BadPayeeAmount rather than as a failing unit test.
    const id = await accepted()
    const c = await collateralOf(id)
    const q = quoteAdvance({
      collateral: c,
      record: orchestrationRecord(proven(8, 10_000)),
      now: c.deliveryDeadlineMs - DELIVERY_WINDOW * 1000,
    })
    expect(q.ok).toBe(true)
    if (!q.ok) return
    expect(q.pledgeUsd).toBeGreaterThan(90) // genuinely near the $100 bounty
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, toUnits(q.pledgeUsd)])
    expect(await read<readonly [string, bigint, bigint]>('releaseSplit', [id])).toBeTruthy()
  })

  it('lands the money exactly where the quote said, on release', async () => {
    const id = await accepted()
    const c = await collateralOf(id)
    const q = quoteAdvance({ collateral: c, record: orchestrationRecord([]), now: c.deliveryDeadlineMs - DELIVERY_WINDOW * 1000 })
    if (!q.ok) throw new Error('expected a quote')

    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, toUnits(q.pledgeUsd)])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await claimable(ACCOUNTS.lender)).toBe(toUnits(q.pledgeUsd))
    expect(await claimable(ACCOUNTS.worker)).toBe(toUnits(q.residualUsd))
    // And the two together are the whole bounty — no dust stranded in escrow
    // by the rounding the quote does in dollars.
    expect((await claimable(ACCOUNTS.lender)) + (await claimable(ACCOUNTS.worker))).toBe(BOUNTY)
  })
})

describe('what the lien does not survive', () => {
  it('pays the lender nothing when the job is reclaimed — the residual the thesis names', async () => {
    // docs/product-thesis.md is explicit that a refund leaves the lender
    // unsecured, and that this is execution risk the LTV prices rather than a
    // hole to plug. A test that only ever walked the happy path would let that
    // sentence quietly stop being true.
    const id = await accepted()
    const c = await collateralOf(id)
    const q = quoteAdvance({ collateral: c, record: orchestrationRecord([]), now: c.deliveryDeadlineMs - DELIVERY_WINDOW * 1000 })
    if (!q.ok) throw new Error('expected a quote')
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, toUnits(q.pledgeUsd)])

    ctx.chain.advance(DELIVERY_WINDOW + 1)
    await send('stranger', 'reclaimJob', [id])

    expect(await claimable(ACCOUNTS.lender)).toBe(0n)
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
  })

  it('refuses a second lender, so a quote built on a stale read cannot double-pledge', async () => {
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, 10n * USDC])
    expect(await fails('worker', 'assignPayee', [id, ACCOUNTS.stranger, 10n * USDC])).toBeTruthy()
    // And the quote refuses it one layer up, so the borrower is told why
    // instead of reading a revert selector.
    const c = await collateralOf(id)
    expect(quoteAdvance({ collateral: c, record: orchestrationRecord([]), now: c.deliveryDeadlineMs - DELIVERY_WINDOW * 1000 })).toMatchObject({
      ok: false,
      reason: 'already-pledged',
    })
  })

  it('refuses a pledge once the delivery deadline is gone, and so does the quote', async () => {
    const id = await accepted()
    const c = await collateralOf(id)
    ctx.chain.advance(DELIVERY_WINDOW + 1)
    expect(await fails('worker', 'assignPayee', [id, ACCOUNTS.lender, 10n * USDC])).toBeTruthy()
    expect(quoteAdvance({ collateral: c, record: orchestrationRecord([]), now: c.deliveryDeadlineMs + 1 })).toMatchObject({
      ok: false,
      reason: 'expired',
    })
  })
})
