import { describe, expect, it } from 'vitest'
import { ACCOUNTS, Chain, marketConfig, type MarketConfig } from './helpers/evm'

/**
 * Round 3: the surface the audit never read.
 *
 * The round-2 audit was performed against `17d7df3`. The bond, `flatFee` and
 * `flatBond` all landed after it, so the newest money-moving code in this
 * contract is also the only code in it nobody has attacked. These tests attack
 * it — and the two things they find are both of the same shape, which is the
 * shape this whole rewrite keeps producing: a rule was applied to the cases
 * somebody was thinking about, and the cases beside them were left alone.
 *
 * 1. THE BOND POINTS ONE WAY. It makes accepting cost the worker something, and
 *    `reclaimJob` hands that something to the requester. But the requester picks
 *    the delivery window, so it also picks whether the worker can possibly earn
 *    it back.
 *
 * 2. THE DEPLOY BOUNDS COVER EVERY FIELD WHOSE TYPE IS SMALL. `feeBps`,
 *    `bondBps`, `silenceForfeitBps` and all five windows are checked against a
 *    named ceiling. The three token-denominated `uint256` fields are not checked
 *    against anything, and every value in this contract is immutable.
 */

const BOUNTY = 1_000_000n // 1 USDC at six decimals
const SPEC = ('0x' + '11'.repeat(32)) as `0x${string}`
const MIN_WINDOW = 10 * 60

type Deployed = { chain: Chain; usdc: `0x${string}`; market: `0x${string}` }

async function deploy(cfg: Partial<MarketConfig> = {}): Promise<Deployed> {
  const chain = await Chain.create()
  const usdc = await chain.deploy('TestUSDC')
  const registry = await chain.deploy('TestRegistry')
  const market = await chain.deploy('LaborMarketV2', [usdc, registry, ACCOUNTS.arbiter, marketConfig(cfg)])
  for (const who of ['requester', 'worker', 'otherWorker'] as const) {
    await chain.send('requester', usdc, 'TestUSDC', 'mint', [ACCOUNTS[who], BOUNTY * 1000n])
    await chain.send(who, usdc, 'TestUSDC', 'approve', [market, BOUNTY * 1000n])
  }
  return { chain, usdc, market }
}

/** Wallet plus credited-but-uncollected — what a party has actually ended up
 *  with. Settlement credits rather than transfers, so a wallet balance alone
 *  reads every settled job as if it had paid nobody. */
async function got(d: Deployed, who: string): Promise<bigint> {
  const wallet = await d.chain.call<bigint>('stranger', d.usdc, 'TestUSDC', 'balanceOf', [who])
  const claimable = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'withdrawable', [who])
  return wallet + claimable
}

// ---------------------------------------------------------------------------
// 1. The requester picks the deadline the worker's bond is slashed against
// ---------------------------------------------------------------------------

describe('a requester cannot farm worker bonds with a window nobody could meet', () => {
  /**
   * The bond exists because accepting used to be free, which made squatting a
   * grief the victim paid for. It fixes that. What it ALSO did, while the slash
   * went to the requester, was make the mirror-image grief profitable — where
   * before the bond it cost the attacker a posting fee and earned nothing.
   *
   * The requester chooses `deliveryWindow` at post time, within
   * [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW]. The job SPEC is off-chain. So
   * nothing on-chain relates the size of the work to the time allowed for it,
   * and a requester could post a three-hour job with a ten-minute window, wait,
   * and call `reclaimJob` — which returned its whole bounty AND the worker's
   * bond, mechanically, with no judgement and nobody to appeal to. The bounty
   * was never at risk, because the job was designed never to complete.
   *
   * Measured on the paying-the-requester contract, five cycles at a 10% bond and
   * a 2% fee: requester +5x(bond − fee) and strictly positive, worker −5x bond.
   *
   * The bond is now BURNED. The test below is the same attack, inverted.
   */
  it('leaves the attacker down one fee per cycle, with the bond destroyed', async () => {
    const d = await deploy({ bondBps: 1000, feeBps: 200 }) // 10% bond, 2% fee
    const bond = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'bondFor', [BOUNTY])
    const fee = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'feeOn', [BOUNTY])

    const requesterBefore = await got(d, ACCOUNTS.requester)
    const workerBefore = await got(d, ACCOUNTS.worker)
    const heldBefore = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'usdcBalance')

    const CYCLES = 5
    for (let i = 0; i < CYCLES; i++) {
      // The shortest window the deployment permits. Legal, and visible.
      await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
      const id = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')
      await d.chain.send('worker', d.market, 'LaborMarketV2', 'acceptJob', [id])
      // The work does not arrive, because it could not have.
      d.chain.advance(MIN_WINDOW + 1)
      await d.chain.send('requester', d.market, 'LaborMarketV2', 'reclaimJob', [id])
    }

    const requesterNet = (await got(d, ACCOUNTS.requester)) - requesterBefore
    const workerNet = (await got(d, ACCOUNTS.worker)) - workerBefore

    // The attacker pays to run the attack and collects nothing. Exactly the
    // position it was in before the bond existed.
    expect(requesterNet).toBe(-BigInt(CYCLES) * fee)
    expect(requesterNet).toBeLessThan(0n)
    // The squatter still loses its stake — the deterrent is unchanged.
    expect(workerNet).toBe(-BigInt(CYCLES) * bond)

    // And the bonds are in the contract, owed to nobody, reachable by nobody.
    const [owed, held, surplus] = await d.chain.call<[bigint, bigint, bigint]>(
      'stranger',
      d.market,
      'LaborMarketV2',
      'escrowSolvency',
    )
    // Everything ever pulled is still here: settlement credits rather than
    // transfers, so the refunded bounties and the house fees sit in the contract
    // until someone withdraws.
    expect(held - heldBefore).toBe(BigInt(CYCLES) * (BOUNTY + fee + bond))
    expect(owed).toBe(BigInt(CYCLES) * (BOUNTY + fee))
    // The difference is exactly the burned bonds — owed to nobody.
    expect(surplus).toBe(BigInt(CYCLES) * bond)
  })

  it('holds at the ceilings, where the attack used to be most profitable', async () => {
    // MAX_FEE_BPS is 500 and MAX_BOND_BPS is 2000, so on the old contract the
    // take was at least 4x the cost BY CONSTRUCTION — the two ceilings could not
    // be chosen to make it unprofitable, which is why the answer had to be about
    // where the bond goes rather than about how big it is.
    const d = await deploy({ bondBps: 2000, feeBps: 500 })
    const maxFee = await d.chain.call<number>('stranger', d.market, 'LaborMarketV2', 'MAX_FEE_BPS')
    const maxBond = await d.chain.call<number>('stranger', d.market, 'LaborMarketV2', 'MAX_BOND_BPS')
    expect(maxBond).toBeGreaterThan(maxFee)

    const before = await got(d, ACCOUNTS.requester)
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
    const id = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')
    await d.chain.send('worker', d.market, 'LaborMarketV2', 'acceptJob', [id])
    d.chain.advance(MIN_WINDOW + 1)
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'reclaimJob', [id])

    // Still negative at the most extreme legal configuration.
    expect((await got(d, ACCOUNTS.requester)) - before).toBeLessThan(0n)
  })

  it('does not hand the bond to the operator either', async () => {
    // Routing the slash to `feeRecipient` would close this for every
    // third-party requester and leave it open for the operator, who is also a
    // requester while the market bootstraps. The house collects its fee and
    // nothing else.
    const d = await deploy({ bondBps: 1000, feeBps: 200 })
    const fee = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'feeOn', [BOUNTY])
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
    const id = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')
    await d.chain.send('worker', d.market, 'LaborMarketV2', 'acceptJob', [id])
    d.chain.advance(MIN_WINDOW + 1)
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'reclaimJob', [id])

    expect(await got(d, ACCOUNTS.house)).toBe(fee)
  })

  it('is not a race the worker can win: the deadline is fixed at accept and submitWork closes on it', async () => {
    // Worth stating explicitly, because "the worker should just deliver faster"
    // is the reflex answer. `deliveryDeadline` is written once in `acceptJob`
    // and never rewritten, and `submitWork` reverts TooLate at it — so past the
    // deadline the worker has no move at all, not even a late one.
    const d = await deploy({ bondBps: 1000 })
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
    const id = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')
    await d.chain.send('worker', d.market, 'LaborMarketV2', 'acceptJob', [id])
    d.chain.advance(MIN_WINDOW + 1)

    const late = await d.chain.revertReason('worker', d.market, 'LaborMarketV2', 'submitWork', [id, SPEC])
    expect(late).toContain('TooLate')
    // And nothing lets the worker walk away with its own stake either.
    expect(await d.chain.revertReason('worker', d.market, 'LaborMarketV2', 'cancelJob', [id])).toBeTruthy()
  })

  it('leaves no on-chain link between the window and the size of the work', async () => {
    // The spec is a hash. Two jobs with wildly different briefs and the same
    // window are indistinguishable on-chain, which is why the contract cannot
    // tell an aggressive deadline from a fraudulent one — and why the answer,
    // if there is one, is about where the slashed bond GOES rather than about
    // detecting the abuse.
    const d = await deploy({ bondBps: 1000 })
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
    const id = await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')
    const job = await d.chain.call<unknown[]>('stranger', d.market, 'LaborMarketV2', 'jobs', [id])
    expect(job[5]).toBe(SPEC) // specHash — an opaque 32 bytes
    expect(Number(job[11])).toBe(MIN_WINDOW) // deliveryWindow — a number beside it
  })
})

// ---------------------------------------------------------------------------
// 2. The three deploy parameters with no ceiling
// ---------------------------------------------------------------------------

describe('every token-denominated deploy parameter has a ceiling', () => {
  /**
   * Every `uint16` and `uint32` in `Config` was already checked against a named
   * constant: MAX_FEE_BPS, MAX_BOND_BPS, MAX_SILENCE_FORFEIT_BPS,
   * MIN_WINDOW/MAX_WINDOW. The three `uint256` fields — flatFee, flatBond,
   * minBounty — were checked for nothing except `minBounty != 0`.
   *
   * That was not an oversight about importance; it was an oversight about UNITS.
   * The bounded fields are dimensionless, so a ceiling was easy to name and one
   * got written. The unbounded three are amounts of a token whose decimals this
   * contract deliberately never learns, so there was no obvious number, and
   * nothing got written.
   *
   * These tests were written against the UNBOUNDED contract first and all three
   * passed — as descriptions of the defect. What they measured then:
   *
   *   flatFee  = 1e18  deploys clean; every postJob reverts TransferFailed,
   *                    for every requester, forever.
   *   flatBond = 1e18  deploys clean, and is WORSE: posting still works, so
   *                    requesters go on escrowing into jobs no worker can
   *                    accept.
   *   minBounty= 1e18  deploys clean; every postJob reverts BountyTooLow.
   *
   * They are inverted below. Running them in that order is the whole point: a
   * guard asserted only after it exists is a guard nobody has watched fail.
   */
  const ETH_DECIMALS_TYPO = 10n ** 18n // meant 1e6 — one whole USDC

  const rejects = async (cfg: Partial<MarketConfig>): Promise<string | null> => {
    try {
      await deploy(cfg)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  it('rejects a flatFee typed with eighteen decimals', async () => {
    expect(await rejects({ flatFee: ETH_DECIMALS_TYPO })).toBeTruthy()
  })

  it('rejects a flatBond typed with eighteen decimals', async () => {
    expect(await rejects({ flatBond: ETH_DECIMALS_TYPO })).toBeTruthy()
  })

  it('rejects a minBounty typed with eighteen decimals', async () => {
    expect(await rejects({ minBounty: ETH_DECIMALS_TYPO })).toBeTruthy()
  })

  it('still accepts every value the design actually contemplates', async () => {
    // The bound must be a typo bound and not a policy. Three cents of flat fee,
    // three cents of flat bond, a one-unit floor — the configuration
    // docs/mainnet-deploy.md describes — has to sail through, or the ceiling has
    // quietly become the thing that decides what a deployment may charge.
    const d = await deploy({ flatFee: 30_000n, flatBond: 30_000n, minBounty: 1n })
    expect(await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'flatFee')).toBe(30_000n)
    // And a job posts and settles at that configuration.
    await d.chain.send('requester', d.market, 'LaborMarketV2', 'postJob', [BOUNTY, 0n, SPEC, MIN_WINDOW])
    expect(await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'jobCount')).toBe(1n)
  })

  it('sits exactly on the ceiling rather than near it', async () => {
    const max = 1_000_000_000n
    const d = await deploy({ flatFee: max })
    expect(await d.chain.call<bigint>('stranger', d.market, 'LaborMarketV2', 'MAX_TOKEN_PARAM')).toBe(max)
    expect(await rejects({ flatFee: max + 1n })).toBeTruthy()
    expect(await rejects({ flatBond: max + 1n })).toBeTruthy()
    expect(await rejects({ minBounty: max + 1n })).toBeTruthy()
  })

  it('names the ceiling failure separately from the floor', async () => {
    // `minBounty` is the one parameter with a bound at both ends, and reusing
    // BountyTooLow for the ceiling would send whoever reads the revert in the
    // wrong direction — on a deploy that happens once, under time pressure.
    expect(await rejects({ minBounty: ETH_DECIMALS_TYPO })).toContain('MinBountyTooHigh')
    expect(await rejects({ minBounty: 0n })).toContain('BountyTooLow')
  })

  it('bounds the dimensionless fields too — the control', async () => {
    // Named, not merely truthy: twelve fields funnel into five errors, and a
    // constructor that reverts for the wrong reason is a deploy debugged in the
    // wrong direction.
    expect(await rejects({ feeBps: 501 })).toContain('FeeTooHigh')
    expect(await rejects({ bondBps: 2001 })).toContain('BondTooHigh')
    expect(await rejects({ silenceForfeitBps: 2001 })).toContain('ForfeitTooHigh')
    expect(await rejects({ reviewWindow: 91 * 24 * 3600 })).toContain('BadWindow')
  })

  it('routes each flat component to the error that names its own side', async () => {
    expect(await rejects({ flatFee: ETH_DECIMALS_TYPO })).toContain('FeeTooHigh')
    expect(await rejects({ flatBond: ETH_DECIMALS_TYPO })).toContain('BondTooHigh')
  })
})
