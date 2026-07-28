import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain } from './helpers/evm'

/**
 * The deadline lattice — a deadline is only worth what the guard on it is worth.
 *
 * Round 1 added five deadlines and four permissionless exits, and gave exactly
 * one of them a matching upper-bound guard: `submitWork` reverts `TooLate` past
 * `deliveryDeadline`. Every other privileged action survives its deadline
 * forever.
 *
 * That is deliberate and correct wherever the party keeping the power past the
 * deadline is the deadline's OWN PRINCIPAL. A requester who disputes on day
 * eight is not a silent requester; an arbiter who rules on day fifteen is not a
 * missing arbiter. Adding a `TooLate` there would manufacture a strictly worse
 * state — a job past both windows, settleable only by a stranger's altruism.
 * Those places were checked and deliberately left alone.
 *
 * It is not correct in the two cases below, and the useful thing about both is
 * that neither is a defect in any single round-1 fix. Each is a COMPOSITION of
 * two of them:
 *
 *   assignPayee  ×  submitWork's new TooLate
 *       Before the TooLate gate, an `Accepted` job past its delivery deadline
 *       was a race — the worker MIGHT still deliver. After it, that job is
 *       provably dead: the only transition left is reclaimJob → 100% requester.
 *       The gate is what turned "probably worthless collateral" into
 *       "collateral that is unreachable with certainty" — and `releaseSplit`,
 *       the function that exists so a lender never has to reimplement the
 *       split, went on quoting a number for it.
 *
 *   acceptJob  ×  expireOpen
 *       expireOpen did not close `Open`; it only added a door out of it. So
 *       `acceptJob` still works at day 61, and taking the job slams that door —
 *       and the requester's own cancelJob with it. `openExpirable()` is a free
 *       public view that names precisely the requesters who have not looked at
 *       this contract in sixty days, which is the same population for whom both
 *       stated mitigations of the silence forfeit are void.
 *
 * Written against the contract BEFORE these guards existed, where each one
 * failed by performing the attack: the lien was perfected on a dead job and the
 * lender withdrew 0, and a stranger banked the 10% forfeit on a job whose
 * requester was entitled to 100% of it back.
 */

const BOUNTY = 1_000_000n
const FEE_BPS = 200n
const FEE = (BOUNTY * FEE_BPS) / 10_000n
const DELIVERY_WINDOW = 3600
const MAX_OPEN_WINDOW = 60 * 24 * 3600
const REVIEW_WINDOW = 7 * 24 * 3600
const ADVANCE = 400_000n
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)
const ZERO = '0x0000000000000000000000000000000000000000'

type Ctx = { chain: Chain; usdc: `0x${string}`; market: `0x${string}` }
type Who = 'requester' | 'worker' | 'stranger' | 'arbiter' | 'lender'

let ctx: Ctx
beforeEach(async () => {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter, FEE_BPS, ACCOUNTS.house])
  await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS.requester, BOUNTY * 100n])
  await chain.send('requester', usdc, 'TestUSDC', 'approve', [market, BOUNTY * 100n])
  ctx = { chain, usdc, market }
})

const send = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.send(who, ctx.market, 'LaborMarketV2', m, a as never)
const fails = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', m, a as never)
const read = <T>(m: string, a: unknown[] = []) =>
  ctx.chain.call<T>('stranger', ctx.market, 'LaborMarketV2', m, a as never)
const claimable = (who: string) => read<bigint>('withdrawable', [who])
const credits = () => ctx.chain.events<{ jobId: bigint; to: string; amount: bigint }>('LaborMarketV2', 'Credited')

async function post(): Promise<bigint> {
  await send('requester', 'postJob', [BOUNTY, 0n, SPEC, DELIVERY_WINDOW])
  return read<bigint>('jobCount')
}
async function accepted(): Promise<bigint> {
  const id = await post()
  await send('worker', 'acceptJob', [id])
  return id
}

describe('a lien perfected on a job that can no longer pay it', () => {
  it('assignPayee is refused once the job can no longer be delivered', async () => {
    const id = await accepted()
    ctx.chain.advance(DELIVERY_WINDOW)

    // The job is dead, not merely late: submitWork is closed, and the one
    // remaining transition pays the requester everything.
    expect(await fails('worker', 'submitWork', [id, RESULT])).toContain('TooLate')
    expect(await fails('worker', 'assignPayee', [id, ACCOUNTS.lender, ADVANCE])).toContain('TooLate')
  })

  it('releaseSplit stops quoting a claim that no release path can honour', async () => {
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, ADVANCE])
    expect(await read<unknown[]>('releaseSplit', [id])).toEqual([ACCOUNTS.lender, ADVANCE, BOUNTY - ADVANCE])

    ctx.chain.advance(DELIVERY_WINDOW)
    // Same job, same lien, one second later — and now nothing can reach it.
    expect(await read<unknown[]>('releaseSplit', [id])).toEqual([ZERO, 0n, 0n])
  })

  it('leaves reclaimJob exactly as it was — the guard adds no new stall', async () => {
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, ADVANCE])
    ctx.chain.advance(DELIVERY_WINDOW)

    await send('stranger', 'reclaimJob', [id])
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.lender)).toBe(0n)
  })

  it('still lets a lender take the risk it was told it was taking', async () => {
    // Pre-deadline the collateral is reachable with some probability and the
    // lender prices that — assignPayee's own NatSpec says so. The guard draws
    // the line at reachable-with-probability-zero, not at risky.
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, ADVANCE])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await claimable(ACCOUNTS.lender)).toBe(ADVANCE)
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY - ADVANCE)
  })
})

describe('a stranger pre-empting the permissionless exit', () => {
  it('cannot take a job the requester has already abandoned', async () => {
    const id = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW)

    expect(await read<boolean>('openExpirable', [id])).toBe(true)
    expect(await fails('stranger', 'acceptJob', [id])).toContain('TooLate')
  })

  it('so the abandoned requester keeps the whole bounty, not ninety percent of it', async () => {
    const id = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW)
    await send('stranger', 'expireOpen', [id])

    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.stranger)).toBe(0n)
  })

  it('is the whole attack, priced: submit junk, wait out a requester who is absent by construction', async () => {
    // The sequence the guard exists to refuse. It is not hypothetical: against
    // the pre-fix bytecode every step below succeeded and the stranger's real
    // token balance went 0n -> 100_000n — SILENCE_FORFEIT_BPS of a 1_000_000
    // bounty — for the cost of gas, with nothing staked.
    const id = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW)

    expect(await fails('stranger', 'acceptJob', [id])).toContain('TooLate')
    // ...and because that first step is refused, none of the rest is reachable.
    expect(await fails('stranger', 'submitWork', [id, RESULT])).toContain('WrongStatus')
    ctx.chain.advance(REVIEW_WINDOW)
    expect(await fails('stranger', 'expireReview', [id])).toContain('WrongStatus')
    expect(await claimable(ACCOUNTS.stranger)).toBe(0n)
  })

  it('cannot strand escrow, because both doors out of Open stay open', async () => {
    // The only way to make a guard like this dangerous is to close the last
    // exit with it. Past openDeadline there are two, and neither is affected.
    const a = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW + 1)
    await send('stranger', 'expireOpen', [a])
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)

    const b = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW + 1)
    await send('requester', 'cancelJob', [b])
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY * 2n)
  })

  it('does not shorten the acceptance window by even a second', async () => {
    const id = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW - 1)
    await send('worker', 'acceptJob', [id]) // the last legal moment
    await send('worker', 'submitWork', [id, RESULT])
  })
})

describe('jobs that were never posted', () => {
  it('cannot be expired into a terminal record', async () => {
    // An unwritten mapping slot decodes as Status.Open (enum 0) with
    // openDeadline 0, so both of expireOpen's guards pass on a job nobody ever
    // created. No money moves — _credit early-returns on zero — but anyone can
    // mint terminal-state records at arbitrary ids, in a product whose claim is
    // a credit score derived from on-chain behaviour.
    expect(await fails('stranger', 'acceptJob', [424242n])).toContain('NoSuchJob')
    expect(await fails('stranger', 'expireOpen', [424242n])).toContain('NoSuchJob')
  })

  it('do not appear expirable to anyone reading the views', async () => {
    expect(await read<boolean>('openExpirable', [424242n])).toBe(false)
  })
})

describe('withdrawTo', () => {
  it('refuses the one destination that would destroy the balance', async () => {
    // withdrawTo exists for smart accounts passing an address programmatically.
    // The contract's own address is the single value that silently burns the
    // caller's whole credit into surplus nobody can sweep. It already rejects
    // address(0); this is the same class and the guard is free.
    const id = await accepted()
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await fails('worker', 'withdrawTo', [ctx.market])).toBeTruthy()
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY)
  })
})

describe('what settlement tells the outside world', () => {
  it('names the address credited and the amount, on the ordinary path', async () => {
    const id = await accepted()
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(credits()).toEqual([{ jobId: id, to: ACCOUNTS.worker, amount: BOUNTY }])
  })

  it('emits one leg per creditor when a lien splits the bounty', async () => {
    // Without this an indexer must reimplement _payWorkerSide's min() waterfall
    // off-chain — the exact mistake releaseSplit was added to spare lenders.
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, ADVANCE])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(credits()).toEqual([
      { jobId: id, to: ACCOUNTS.lender, amount: ADVANCE },
      { jobId: id, to: ACCOUNTS.worker, amount: BOUNTY - ADVANCE },
    ])
  })

  it('names the creditor on the paths whose own events never did', async () => {
    // JobCancelled and OpenExpired carry neither address nor amount, and
    // JobReclaimed names the former worker while crediting the requester.
    const a = await post()
    await send('requester', 'cancelJob', [a])
    expect(credits()).toEqual([{ jobId: a, to: ACCOUNTS.requester, amount: BOUNTY }])

    const b = await accepted()
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [b])
    expect(credits()).toEqual([{ jobId: b, to: ACCOUNTS.requester, amount: BOUNTY }])

    const c = await post()
    ctx.chain.advance(MAX_OPEN_WINDOW)
    await send('stranger', 'expireOpen', [c])
    expect(credits()).toEqual([{ jobId: c, to: ACCOUNTS.requester, amount: BOUNTY }])
  })

  it('accounts for the fee separately — it is never credited to anyone', async () => {
    const id = await post()
    await send('requester', 'cancelJob', [id])
    const [owed] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(owed).toBe(BOUNTY + FEE) // the uncollected fee is a liability too
  })
})
