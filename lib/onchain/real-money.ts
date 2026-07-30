/**
 * The mainnet guard, wired to the environment and to the money paths.
 *
 * `lib/onchain/mainnet-guard.ts` is pure by design: it takes a config and returns
 * blockers, so its conditions can be exercised without a chain. Its docstring
 * says the point is that "the same conditions live here as a function the money
 * paths call."
 *
 * They did not. `realMoneyBlockers`, `decimalsBlocker` and `formatBlockers` had
 * ZERO callers — only `mintBlocker` was wired. So the guard was fully written,
 * fully unit-tested, documented in docs/mainnet-deploy.md as something that
 * **refuses**, and connected to nothing: on `ONCHAIN_CHAIN=base` it would have
 * blocked exactly none of the eight things it knows about.
 *
 * This file is the missing half. It reads the environment, asks the chain the one
 * question it cannot answer locally, and calls the pure function.
 *
 * Why it matters concretely, not in principle: `platformFeeBps()` DEFAULTS TO 200.
 * An operator who never sets `PLATFORM_FEE_BPS` gets a 2% off-chain fee on top of
 * the contract's own 2%, and every requester pays twice. Unset is not off. That is
 * the `fee-charged-twice` blocker, and it was unreachable.
 */
import { CHAIN, USDC_DECIMALS, onchainEnv, USDC_ABI } from './config'
import { publicClient } from './clients'
import { LABOR_MARKET_V2_ABI } from './labor-v2-artifact'
import { platformFeeBps } from '@/lib/platform-fee'
import { decimalsBlocker, formatBlockers, realMoneyBlockers, type Blocker } from './mainnet-guard'
import type { Address } from 'viem'

/**
 * Chains where losing funds does not mean losing funds.
 *
 * An allowlist of TESTNETS rather than a list of mainnets, so an unrecognised
 * chain counts as real money. Being wrong that way costs an operator two minutes
 * of confusion; being wrong the other way costs somebody's funds.
 */
const TESTNET_CHAIN_IDS = new Set([
  11155111, // sepolia
  84532, // base-sepolia
  91342, // giwa-sepolia
])

export function isRealMoney(): boolean {
  return !TESTNET_CHAIN_IDS.has(CHAIN.id)
}

/**
 * The contract's own fee, read once and remembered.
 *
 * `feeBps` is `immutable`, so one successful read is permanently true for this
 * address and the cache cannot go stale. That matters because the alternative —
 * reading it on every check — would make an RPC blip either block the market or
 * silently skip the fee comparison.
 */
const feeBpsCache = new Map<string, number>()
async function contractFeeBps(): Promise<number | null> {
  const address = onchainEnv.laborMarketAddress
  if (!address) return null
  const cached = feeBpsCache.get(address)
  if (cached !== undefined) return cached
  try {
    const bps = Number(
      await publicClient().readContract({
        address: address as Address,
        abi: LABOR_MARKET_V2_ABI,
        functionName: 'feeBps',
      }),
    )
    feeBpsCache.set(address, bps)
    return bps
  } catch {
    return null
  }
}

/** The token's own decimals, cached for the same reason: it cannot change. */
const decimalsCache = new Map<string, number>()
async function tokenDecimals(): Promise<number | null> {
  const address = onchainEnv.usdcAddress
  if (!address) return null
  const cached = decimalsCache.get(address)
  if (cached !== undefined) return cached
  try {
    const d = Number(
      await publicClient().readContract({
        address: address as Address,
        abi: USDC_ABI,
        functionName: 'decimals',
      }),
    )
    decimalsCache.set(address, d)
    return d
  } catch {
    return null
  }
}

export type RealMoneyStatus = {
  isRealMoney: boolean
  chainId: number
  chainName: string
  blockers: Blocker[]
  /** Codes that could not be evaluated because a chain read failed. */
  unevaluated: string[]
  summary: string
}

/**
 * Every blocker that applies right now.
 *
 * On a testnet this is empty by construction — `realMoneyBlockers` returns `[]`
 * when `isRealMoney` is false, so none of this costs anything until it matters.
 *
 * When the contract's fee cannot be read, the two fee blockers are reported as
 * UNEVALUATED rather than silently passing or blocking. Passing would hide a
 * double charge; blocking would let an RPC blip stop a working market. Naming
 * them is the only option that is honest in both directions.
 */
export async function realMoneyStatus(): Promise<RealMoneyStatus> {
  const real = isRealMoney()
  const [fee, decimals] = await Promise.all([contractFeeBps(), tokenDecimals()])
  const feeKnown = fee !== null

  const blockers = realMoneyBlockers({
    isRealMoney: real,
    escrowTokenAddress: onchainEnv.usdcAddress,
    laborMarketAddress: onchainEnv.laborMarketAddress,
    paymasterMeteredAck: onchainEnv.paymasterMeteredAck,
    // FAUCET_MAX_PER_DAY=0 is the off switch. It only became one today — the
    // parse used `Number(x) || 15`, so an explicit zero fell through to 15.
    faucetEnabled: faucetMaxPerDay() > 0,
    // -1 would satisfy neither `> 0` nor `=== 0`, but relying on that would make
    // this depend on the exact shape of two predicates in another file. Pass 0
    // and drop the fee codes below instead.
    contractFeeBps: feeKnown ? fee : 0,
    offchainFeeBps: platformFeeBps(),
  })

  const FEE_CODES = ['fee-charged-twice', 'no-fee-anywhere']
  const unevaluated = feeKnown ? [] : FEE_CODES
  const kept = feeKnown ? blockers : blockers.filter((b) => !FEE_CODES.includes(b.code))

  const mismatch = real ? decimalsBlocker(decimals, USDC_DECIMALS) : null
  if (mismatch) kept.push(mismatch)

  return {
    isRealMoney: real,
    chainId: CHAIN.id,
    chainName: CHAIN.name,
    blockers: kept,
    unevaluated,
    summary: formatBlockers(kept),
  }
}

/** Same parse as lib/job-faucet.ts, which is the authority on its own bound. */
function faucetMaxPerDay(): number {
  const raw = process.env.FAUCET_MAX_PER_DAY
  if (raw === undefined || raw.trim() === '') return 15
  const n = Number(raw)
  if (!Number.isFinite(n)) return 15
  return Math.max(0, n)
}

/**
 * Refuse the operation if this deployment is not ready for real money.
 *
 * Refuses rather than warns, for the reason the guard's own docstring gives: a
 * warning on a money path is a warning that gets scrolled past. The message
 * carries every blocker's detail, because the operator reading it is mid-action
 * and the next thing they will do is look for what to change.
 */
export async function assertRealMoneyReady(context: string): Promise<void> {
  const status = await realMoneyStatus()
  if (status.blockers.length === 0) return
  const details = status.blockers.map((b) => `  • ${b.code}: ${b.detail}`).join('\n')
  throw new Error(
    `${context} refused on ${status.chainName} (chain ${status.chainId}), where losing funds means ` +
      `losing funds:\n${details}`,
  )
}
