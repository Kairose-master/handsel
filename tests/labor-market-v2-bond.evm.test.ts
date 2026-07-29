import { beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain, marketConfig } from './helpers/evm'

/**
 * The worker bond: what makes accepting a job cost something.
 *
 * Accepting used to be free, and the posting fee turned that into a grief the
 * VICTIM paid for. A squatter accepted any `minScore == 0` job and never
 * delivered. `cancelJob` is Open-only, so the requester had no exit and waited
 * out the entire delivery window. `reclaimJob` then returned the bounty but not
 * the fee, and `Refunded` is terminal with no path back to `Open`, so reposting
 * cost the fee again. Five cycles at a 1_000_000 bounty and 200bps: requester
 * −100_000, house +100_000, and the squatter's token balance byte-identical
 * before and after. At `feeBps = 0` the same five cycles cost nothing, which
 * isolates the cause precisely — the fee converted a time-only grief into a
 * money grief that scales with the bounty while the attacker's cost stays one
 * transaction of gas.
 *
 * The bond makes the squatter pay rather than merely making the victim whole,
 * and it needed no new privileged party: `reclaimJob` was already a purely
 * mechanical trigger — a deadline passed with an empty `resultHash` — so there
 * is no judgement in the slash and nobody to appeal to.
 *
 * The rule, and every test below is one line of it:
 *
 *   the bond is returned to the worker on EVERY path out of Submitted or
 *   Disputed, and destroyed by reclaimJob alone.
 *
 * That asymmetry is the whole design. Losing a dispute means the work was judged
 * bad; only reclaimJob means it never arrived, and the bond answers the second
 * question. It lives inside `_payWorkerSide` — the single release path — for the
 * same reason the payee split does: a return written at each call site is one
 * that gets honoured on some routes and forgotten on others.
 *
 * DESTROYED, not paid to the requester, which is where round 3 moved it. The
 * requester chooses `deliveryWindow` at post time and the spec is off-chain, so
 * nothing on-chain relates the size of the work to the time allowed for it —
 * post at MIN_DELIVERY_WINDOW, wait, reclaim, and collect the bond of every
 * worker who could not have finished. That is this same squat with the parties
 * swapped, and it was profitable by construction because MAX_BOND_BPS exceeds
 * MAX_FEE_BPS. A slash paid to a party who can influence whether the slash
 * happens is an incentive to manufacture it.
 */

const BOUNTY = 1_000_000n
const BOND_BPS = 1000 // 10%
const BOND = 100_000n
const FEE_BPS = 200
const FEE = 20_000n
const DELIVERY_WINDOW = 3600
const REVIEW_WINDOW = 7 * 24 * 3600
const DISPUTE_WINDOW = 14 * 24 * 3600
const FORFEIT = BOUNTY / 10n
const SPEC = '0x' + '11'.repeat(32)
const RESULT = '0x' + '22'.repeat(32)

type Ctx = { chain: Chain; usdc: `0x${string}`; market: `0x${string}` }
type Who = 'requester' | 'worker' | 'stranger' | 'arbiter' | 'lender'

let ctx: Ctx

async function deployWith(bondBps: number): Promise<Ctx> {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [
    usdc,
    registry,
    ACCOUNTS.arbiter,
    marketConfig({ bondBps, feeBps: FEE_BPS }),
  ])
  for (const who of ['requester', 'worker'] as const) {
    await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS[who], BOUNTY * 100n])
    await chain.send(who, usdc, 'TestUSDC', 'approve', [market, BOUNTY * 100n])
  }
  return { chain, usdc, market }
}

beforeEach(async () => {
  ctx = await deployWith(BOND_BPS)
})

const send = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.send(who, ctx.market, 'LaborMarketV2', m, a as never)
const fails = (who: Who, m: string, a: unknown[] = []) =>
  ctx.chain.revertReason(who, ctx.market, 'LaborMarketV2', m, a as never)
const read = <T>(m: string, a: unknown[] = []) =>
  ctx.chain.call<T>('stranger', ctx.market, 'LaborMarketV2', m, a as never)
const claimable = (who: string) => read<bigint>('withdrawable', [who])
const wallet = (who: string) => ctx.chain.call<bigint>('stranger', ctx.usdc, 'TestUSDC', 'balanceOf', [who])
/** Wallet plus credited-but-uncollected — what a party has ended up with. */
const got = async (who: string) => (await wallet(who)) + (await claimable(who))

async function post(): Promise<bigint> {
  await send('requester', 'postJob', [BOUNTY, 0n, SPEC, DELIVERY_WINDOW])
  return read<bigint>('jobCount')
}
async function accepted(): Promise<bigint> {
  const id = await post()
  await send('worker', 'acceptJob', [id])
  return id
}
async function delivered(): Promise<bigint> {
  const id = await accepted()
  await send('worker', 'submitWork', [id, RESULT])
  return id
}

describe('accepting a job now costs the worker something', () => {
  it('pulls the bond and counts it as escrow', async () => {
    expect(await read<bigint>('bondFor', [BOUNTY])).toBe(BOND)
    const before = await wallet(ACCOUNTS.worker)
    const id = await accepted()

    expect(await wallet(ACCOUNTS.worker)).toBe(before - BOND)
    // Both the bounty and the bond are escrow now, and the solvency invariant
    // has to see both or the contract looks over-collateralised.
    expect(await read<bigint>('totalEscrowed')).toBe(BOUNTY + BOND)
    void id
  })

  it('refuses a worker who has not staked it', async () => {
    // The friction is the point, and it is also the cost: a worker needs
    // capital to accept work now. On a market short of supply that is a real
    // price, which is why bondBps = 0 is the first-deployment default.
    const id = await post()
    await ctx.chain.send('worker', ctx.usdc, 'TestUSDC', 'approve', [ctx.market, 0n])
    expect(await fails('worker', 'acceptJob', [id])).toBeTruthy()
  })

  it('keeps the escrow books exact — bond in, bond out', async () => {
    const id = await delivered()
    await send('requester', 'approveJob', [id])
    expect(await read<bigint>('totalEscrowed')).toBe(0n)

    const [owed, held, surplus] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(owed).toBe(BOUNTY + BOND + FEE) // the uncollected fee is a liability too
    expect(held).toBe(owed)
    expect(surplus).toBe(0n)
  })
})

describe('the bond comes back on every path where the work arrived', () => {
  it('on approval', async () => {
    const id = await delivered()
    await send('requester', 'approveJob', [id])
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY + BOND)
  })

  it('on a silent requester — the forfeit and the bond are different money', async () => {
    const id = await delivered()
    ctx.chain.advance(REVIEW_WINDOW)
    await send('stranger', 'expireReview', [id])

    expect(await claimable(ACCOUNTS.worker)).toBe(FORFEIT + BOND)
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY - FORFEIT)
  })

  it('on an arbiter who never ruled', async () => {
    const id = await delivered()
    await send('requester', 'raiseDispute', [id])
    ctx.chain.advance(DISPUTE_WINDOW)
    await send('stranger', 'expireDispute', [id])

    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY + BOND)
  })

  it('on a dispute the worker WINS', async () => {
    const id = await delivered()
    await send('requester', 'raiseDispute', [id])
    await send('arbiter', 'resolveDispute', [id, true])

    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY + BOND)
  })

  it('and on a dispute the worker LOSES — which is the whole asymmetry', async () => {
    // Delivering badly is not the same as not delivering. The bond answers the
    // second question only, so a worker who loses an argument about quality
    // still gets its own capital back. Confiscating it here would punish bad
    // work with the instrument built to punish absence.
    const id = await delivered()
    await send('requester', 'raiseDispute', [id])
    await send('arbiter', 'resolveDispute', [id, false])

    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.worker)).toBe(BOND)
    expect(await read<bigint>('totalEscrowed')).toBe(0n)
  })
})

describe('reclaimJob is the only path that takes it, and it gives it to nobody', () => {
  it('makes the requester exactly whole and destroys the bond', async () => {
    const id = await accepted()
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])

    // EXACTLY whole — the bounty and not a unit more. Paying the bond to the
    // requester made the mirror grief profitable: the requester picks
    // `deliveryWindow`, so it picks whether the work could have arrived at all.
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.worker)).toBe(0n)
    // Nobody holds it, and it is out of escrow — leaving `totalEscrowed` up
    // would report a permanent liability against money nobody can claim.
    expect(await read<bigint>('totalEscrowed')).toBe(0n)
    expect(await read<bigint>('totalWithdrawable')).toBe(BOUNTY + FEE)
  })

  it('leaves the burned bond in the contract as surplus nobody can reach', async () => {
    const id = await accepted()
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])

    const [owed, held, surplus] = await read<[bigint, bigint, bigint]>('escrowSolvency')
    expect(owed).toBe(BOUNTY + FEE)
    expect(held).toBe(BOUNTY + FEE + BOND)
    // The burn IS the surplus. There is deliberately no sweep, which is what
    // makes it a burn rather than a transfer to the operator — an operator who
    // could sweep this would be a party that profits from a slash.
    expect(surplus).toBe(BOND)
  })

  it('announces the burn, because no Credited leg describes it', async () => {
    const id = await accepted()
    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])

    const burned = ctx.chain.events<{ from: string; amount: bigint }>('LaborMarketV2', 'BondBurned')
    expect(burned).toHaveLength(1)
    expect(burned[0].amount).toBe(BOND)
    // Named with the address it was taken from: the credit engine has to score
    // the squat, and JobReclaimed alone does not say how much was at stake.
    expect(burned[0].from.toLowerCase()).toBe(ACCOUNTS.worker)
    // And it is the one money movement with no Credited leg beside it, so an
    // indexer summing credits would silently lose it.
    const credits = ctx.chain.events<{ to: string; amount: bigint }>('LaborMarketV2', 'Credited')
    expect(credits.map((c) => c.amount)).toEqual([BOUNTY])
  })

  it('prices the squat without paying anyone to arrange one', async () => {
    // The measured attack, run five times. Before the bond the requester was
    // down one fee per cycle and the squatter's balance never moved.
    const requesterStart = await got(ACCOUNTS.requester)
    const squatterStart = await got(ACCOUNTS.worker)

    for (let i = 0; i < 5; i++) {
      const id = await accepted()
      ctx.chain.advance(DELIVERY_WINDOW)
      await send('stranger', 'reclaimJob', [id])
    }

    // The squatter is down real money per attempt — which was the goal, and it
    // still holds.
    expect(await got(ACCOUNTS.worker)).toBe(squatterStart - 5n * BOND)
    // The requester is still down one fee per cycle, exactly as before the bond
    // existed. It is NOT made better off by being squatted, and that is the
    // property: a requester that profits from a squat is a requester with a
    // reason to arrange one.
    expect(await got(ACCOUNTS.requester)).toBe(requesterStart - 5n * FEE)
  })

  it('does not let a lender reach the bond — it is not part of the bounty', async () => {
    // A lien attaches to the bounty. The bond is the worker's own capital, so a
    // lender with a claim over the entire bounty still has none over the stake.
    const id = await accepted()
    await send('worker', 'assignPayee', [id, ACCOUNTS.lender, BOUNTY])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])

    expect(await claimable(ACCOUNTS.lender)).toBe(BOUNTY)
    expect(await claimable(ACCOUNTS.worker)).toBe(BOND)
  })
})

describe('bondBps = 0', () => {
  it('is the whole mechanism off, and behaviour identical to before it existed', async () => {
    ctx = await deployWith(0)
    expect(await read<bigint>('bondFor', [BOUNTY])).toBe(0n)

    const before = await wallet(ACCOUNTS.worker)
    const id = await accepted()
    expect(await wallet(ACCOUNTS.worker)).toBe(before) // nothing pulled
    expect(await read<bigint>('totalEscrowed')).toBe(BOUNTY)

    ctx.chain.advance(DELIVERY_WINDOW)
    await send('stranger', 'reclaimJob', [id])
    expect(await claimable(ACCOUNTS.requester)).toBe(BOUNTY) // nothing to slash
    expect(await read<bigint>('totalEscrowed')).toBe(0n)
  })

  it('lets a worker with no capital at all accept work', async () => {
    // The cold-start rule: a new agent starts at score 0 with nothing. A market
    // that requires capital to earn has no supply side on day one.
    ctx = await deployWith(0)
    const id = await post()
    await ctx.chain.send('worker', ctx.usdc, 'TestUSDC', 'approve', [ctx.market, 0n])
    await send('worker', 'acceptJob', [id])
    await send('worker', 'submitWork', [id, RESULT])
    await send('requester', 'approveJob', [id])
    expect(await claimable(ACCOUNTS.worker)).toBe(BOUNTY)
  })
})

describe('a deployment that cannot work is refused at construction', () => {
  const deploy = async (o: Parameters<typeof marketConfig>[0]) => {
    const chain = await Chain.create()
    const usdc = await chain.deploy('TestUSDC')
    const registry = await chain.deploy('TestRegistry')
    try {
      await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter, marketConfig(o)])
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  it('rejects a bond above the ceiling', async () => {
    expect(await deploy({ bondBps: 2001 })).toBeTruthy()
    expect(await deploy({ bondBps: 2000 })).toBeNull()
  })

  it('rejects a forfeit above the ceiling', async () => {
    expect(await deploy({ silenceForfeitBps: 2001 })).toBeTruthy()
  })

  it('rejects any window outside the global bounds', async () => {
    expect(await deploy({ reviewWindow: 1 })).toBeTruthy()
    expect(await deploy({ disputeWindow: 91 * 24 * 3600 })).toBeTruthy()
    expect(await deploy({ maxOpenWindow: 0 })).toBeTruthy()
  })

  it('rejects a delivery pair that would reject every window', async () => {
    // Deployable and dead: postJob checks `w < min || w > max`, so a max below
    // the min refuses every possible value and the market accepts no work.
    expect(await deploy({ minDeliveryWindow: 30 * 24 * 3600, maxDeliveryWindow: 10 * 60 })).toBeTruthy()
  })

  it('rejects a zero minimum bounty — free completions are free reputation', async () => {
    expect(await deploy({ minBounty: 0n })).toBeTruthy()
  })
})
