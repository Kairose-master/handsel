import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain, marketConfig } from './helpers/evm'

/**
 * A percentage cannot cover a fixed cost, and gas is a fixed cost.
 *
 * Every job consumes roughly the same number of sponsored UserOps whatever its
 * bounty — post, accept, submit, approve, and the withdrawals — so the
 * operator's expense per job is FLAT while a bps fee scales with the bounty.
 *
 * That is not a tuning problem, it is an arithmetic one. `MAX_FEE_BPS` is 500,
 * so on a $0.05 bounty the fee CANNOT exceed $0.0025 no matter what a deployment
 * chooses, against a gas envelope an order of magnitude larger. Raising the
 * percentage does not reach; the ceiling is a fraction of a number that is
 * itself tiny. And the same arithmetic breaks the bond on the other side: 5% of
 * $0.05 puts $0.0025 at risk, so `acceptJob` stays effectively free exactly
 * where the market is thinnest — and a free `acceptJob` is the one action an
 * attacker repeats at zero cost while the operator pays gas for each one.
 *
 * So both sides get a flat component. These tests are about the property that
 * motivated it: **the fee covers the job's gas envelope at ANY bounty size.**
 */

// Cent-scale, which is where the proportional-only model fails. 6-decimal USDC:
// 50_000 units = $0.05.
const TINY = 50_000n
const BIG = 100_000_000n // $100
const FLAT_FEE = 30_000n // $0.03 — a stand-in for the measured gas envelope
const FLAT_BOND = 30_000n
const FEE_BPS = 200
const BOND_BPS = 500
const DELIVERY_WINDOW = 3600
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)

type Ctx = { chain: Chain; usdc: `0x${string}`; market: `0x${string}` }
type Who = 'requester' | 'worker' | 'stranger' | 'arbiter' | 'lender'

let ctx: Ctx

async function deploy(overrides = {}): Promise<Ctx> {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [
    usdc,
    registry,
    ACCOUNTS.arbiter,
    marketConfig({ feeBps: FEE_BPS, flatFee: FLAT_FEE, bondBps: BOND_BPS, flatBond: FLAT_BOND, ...overrides }),
  ])
  for (const who of ['requester', 'worker'] as const) {
    await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS[who], BIG * 10n])
    await chain.send(who, usdc, 'TestUSDC', 'approve', [market, BIG * 10n])
  }
  return { chain, usdc, market }
}

beforeEach(async () => {
  ctx = await deploy()
})

const send = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.send(who, ctx.market, 'LaborMarketV2', m, a as never)
const read = <T>(m: string, a: unknown[] = []) =>
  ctx.chain.call<T>('stranger', ctx.market, 'LaborMarketV2', m, a as never)
const claimable = (who: string) => read<bigint>('withdrawable', [who])

async function post(bounty: bigint): Promise<bigint> {
  await send('requester', 'postJob', [bounty, 0n, SPEC, DELIVERY_WINDOW])
  return read<bigint>('jobCount')
}

describe('the fee covers the gas envelope at any bounty size', () => {
  it('collects at least the flat fee on a cent-scale job', async () => {
    // The whole point. 2% of $0.05 is $0.001; the envelope is $0.03. Without a
    // flat component the operator sponsors five UserOps and earns a tenth of
    // one of them.
    expect(await read<bigint>('feeOn', [TINY])).toBe(FLAT_FEE + (TINY * BigInt(FEE_BPS)) / 10_000n)
    expect(await read<bigint>('feeOn', [TINY])).toBeGreaterThanOrEqual(FLAT_FEE)

    await post(TINY)
    expect(await claimable(ACCOUNTS.house)).toBeGreaterThanOrEqual(FLAT_FEE)
  })

  it('still scales with value on a large job', async () => {
    // The flat part is a floor, not a replacement. A $100 job puts far more at
    // risk than a $0.05 one and pays proportionally more for it.
    const fee = await read<bigint>('feeOn', [BIG])
    expect(fee).toBe(FLAT_FEE + (BIG * BigInt(FEE_BPS)) / 10_000n)
    expect(fee).toBeGreaterThan(FLAT_FEE * 10n)
  })

  it('is what postCost charges, so a requester approving postCost never reverts', async () => {
    // The failure this prevents: an approval computed as bounty + bps that
    // comes up short by exactly the flat fee, on every single post.
    for (const bounty of [1n, TINY, BIG]) {
      expect(await read<bigint>('postCost', [bounty])).toBe(bounty + (await read<bigint>('feeOn', [bounty])))
    }
  })

  it('never refunds the fee, on any exit', async () => {
    // The gas was spent posting. A refundable toll is not a toll, and a
    // refundable gas reimbursement is a loan.
    const before = await claimable(ACCOUNTS.house)
    const id = await post(TINY)
    await send('requester', 'cancelJob', [id])
    expect(await claimable(ACCOUNTS.house)).toBe(before + FLAT_FEE + (TINY * BigInt(FEE_BPS)) / 10_000n)
    expect(await claimable(ACCOUNTS.requester)).toBe(TINY) // bounty only
  })
})

describe('the bond bites at cent scale too', () => {
  it('puts real money at risk on a job where 5% is nothing', async () => {
    expect(await read<bigint>('bondFor', [TINY])).toBe(FLAT_BOND + (TINY * BigInt(BOND_BPS)) / 10_000n)
    expect(await read<bigint>('bondFor', [TINY])).toBeGreaterThanOrEqual(FLAT_BOND)
  })

  it('and a squatter loses it, so accepting is never free', async () => {
    // The attack the flat component exists to price: accept, never deliver.
    // Proportionally it cost $0.0025; now it costs the flat bond.
    const id = await post(TINY)
    const bond = await read<bigint>('bondFor', [TINY])
    await send('worker', 'acceptJob', [id])
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])

    expect(await claimable(ACCOUNTS.requester)).toBe(TINY + bond)
    expect(await claimable(ACCOUNTS.worker)).toBe(0n)
  })

  it('and an honest worker gets every unit of it back', async () => {
    const id = await post(TINY)
    const bond = await read<bigint>('bondFor', [TINY])
    await send('worker', 'acceptJob', [id])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await claimable(ACCOUNTS.worker)).toBe(TINY + bond)
  })
})

describe('the books still balance with both flat components live', () => {
  it('holds exactly what it owes through a full lifecycle', async () => {
    const id = await post(TINY)
    await send('worker', 'acceptJob', [id])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    const [owed, held, surplus] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(held).toBe(owed)
    expect(surplus).toBe(0n)
    expect(await read<bigint>('totalEscrowed')).toBe(0n)
  })

  it('holds exactly what it owes when the squatter is slashed', async () => {
    const id = await post(TINY)
    await send('worker', 'acceptJob', [id])
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])

    const [owed, held, surplus] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(held).toBe(owed)
    expect(surplus).toBe(0n)
  })

  it('works at MIN_BOUNTY, where the fee dwarfs the bounty', async () => {
    // Honest pricing rather than a broken state: a job worth one unit costs the
    // operator the same gas as any other, so it pays the same floor. The
    // contract must not fall over there — it must just be expensive.
    const id = await post(1n)
    await send('worker', 'acceptJob', [id])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await claimable(ACCOUNTS.worker)).toBe(1n + (await read<bigint>('bondFor', [1n])))
    const [owed, held] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(held).toBe(owed)
  })
})

describe('deployments that would take a fee nowhere', () => {
  it('refuses a flat fee with no recipient', async () => {
    // The bps check already existed; a flat fee reaches the same address and
    // needed the same guard. Without it every posting fee burns to address(0),
    // permanently, unnoticed until someone reconciles revenue that never came.
    await expect(deploy({ feeBps: 0, flatFee: FLAT_FEE, feeRecipient: '0x' + '00'.repeat(20) })).rejects.toThrow()
  })

  it('allows a zero-fee deployment with no recipient', async () => {
    await expect(
      deploy({ feeBps: 0, flatFee: 0n, feeRecipient: '0x' + '00'.repeat(20) }),
    ).resolves.toBeTruthy()
  })
})
