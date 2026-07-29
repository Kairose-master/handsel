/**
 * LaborMarketV2's off-chain surface — the parts V1 never had.
 *
 * `lib/onchain/labor.ts` targets the V1 contract and stays that way: its ABI has
 * `postJob(bounty, minScore, specHash)`, a seven-field `jobs` getter and no
 * timeout functions at all. Its seven-entry `JOB_STATUS` is CORRECT for that
 * contract. Nothing here changes it.
 *
 * What this file adds is everything V2 grew and nothing yet called: four
 * permissionless exits, a `jobs` getter with fourteen fields, an eighth status,
 * and pull payments. Kept separate rather than merged so that pointing at V2 is
 * a deliberate switch and not a silent reinterpretation of V1's data — a
 * fourteen-field decoder run against a seven-field contract does not fail
 * cleanly, it produces numbers.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'
import { LABOR_MARKET_V2_ABI } from './labor-v2-artifact'
import { publicClient } from './clients'
import { onchainEnv, USDC_ABI, USDC_DECIMALS } from './config'
import { sendAgentCall, sendAgentCalls } from './account'
import { V2_JOB_STATUS, type DeadlineJob, type ExitFn, type V2JobStatus } from '@/lib/deadlines'

const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS
const toUnits = (usd: number) => parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS)

const market = () => ({ address: onchainEnv.laborMarketAddress as Address, abi: LABOR_MARKET_V2_ABI }) as const

/**
 * Whether the configured market is a V2.
 *
 * Detected from the deployed code rather than from an env flag, because the
 * thing that actually matters is which bytecode is at that address — an env var
 * says what someone believed when they set it. `MAX_OPEN_WINDOW` exists only on
 * V2; on V1 the call reverts and this returns false.
 *
 * Cached per address: it cannot change for a given address, since both contracts
 * are immutable.
 */
const v2Cache = new Map<string, boolean>()
export async function isV2Market(): Promise<boolean> {
  const address = onchainEnv.laborMarketAddress
  if (!address) return false
  const cached = v2Cache.get(address)
  if (cached !== undefined) return cached
  let is = false
  try {
    await publicClient().readContract({
      address: address as Address,
      abi: LABOR_MARKET_V2_ABI,
      functionName: 'MAX_OPEN_WINDOW',
    })
    is = true
  } catch {
    is = false
  }
  v2Cache.set(address, is)
  return is
}

export type V2Job = DeadlineJob & {
  requester: Address
  worker: Address
  bounty: number
  payee: Address
  payeeAmount: number
}

/** Decode one `jobs()` tuple. Field ORDER is the contract's struct order and a
 *  change there silently reinterprets every field after it — which has happened
 *  once already, in the tests, where `payee` became `deliveryWindow`. */
function decodeJob(id: number, raw: readonly unknown[]): V2Job {
  const statusIndex = Number(raw[4])
  const status = V2_JOB_STATUS[statusIndex]
  if (!status) {
    // Never silently fall back to 'Open'. That is precisely the V1 decoder's
    // `?? 'Open'`, which would put every timeout-settled job back on the board
    // as available work.
    throw new Error(`job ${id}: unknown status index ${statusIndex} — the Status enum grew`)
  }
  return {
    id,
    requester: raw[0] as Address,
    worker: raw[1] as Address,
    bounty: fromUnits(raw[2] as bigint),
    status: status as V2JobStatus,
    openDeadline: Number(raw[7]),
    deliveryDeadline: Number(raw[8]),
    reviewDeadline: Number(raw[9]),
    disputeDeadline: Number(raw[10]),
    payee: raw[12] as Address,
    payeeAmount: fromUnits(raw[13] as bigint),
  }
}

/** Every job, decoded. Same shape of read as V1's `readJobs`. */
export async function readJobsV2(): Promise<V2Job[]> {
  const address = onchainEnv.laborMarketAddress
  if (!address) return []
  const client = publicClient()
  const count = await client.readContract({
    address: address as Address,
    abi: LABOR_MARKET_V2_ABI,
    functionName: 'jobCount',
  })
  const ids = Array.from({ length: Number(count) }, (_, i) => i + 1)
  const results = await client.multicall({
    contracts: ids.map((id) => ({
      address: address as Address,
      abi: LABOR_MARKET_V2_ABI,
      functionName: 'jobs' as const,
      args: [BigInt(id)] as const,
    })),
  })
  const jobs: V2Job[] = []
  results.forEach((r, i) => {
    if (r.status !== 'success') return
    jobs.push(decodeJob(ids[i], r.result as readonly unknown[]))
  })
  return jobs
}

/**
 * Call one of the permissionless exits.
 *
 * Sent through an agent's sponsored smart account rather than the oracle EOA.
 * These are the calls that free money when a counterparty is gone; routing them
 * through the one key that also satisfies `msg.sender == arbiter` would put the
 * operator's most privileged credential on the most routine path in the system.
 * Anyone may call these — that is the whole point — so they get the least
 * privileged sender available.
 */
export async function callExit(agentId: string, fn: ExitFn, jobId: number): Promise<Hex> {
  return sendAgentCall(
    agentId,
    {
      to: onchainEnv.laborMarketAddress as Address,
      data: encodeFunctionData({ abi: LABOR_MARKET_V2_ABI, functionName: fn, args: [BigInt(jobId)] }),
    },
    // KEEPER lane. These free somebody else's escrow, so they must not be
    // starved by a user who spent the user lane — that would turn a gas attack
    // into a way to freeze the market's money.
    { lane: 'keeper', label: fn },
  )
}

/**
 * How long a worker gets, when the caller did not say.
 *
 * V2's `postJob` takes a fourth argument V1 never had, so every existing call
 * site reaches this. The contract bounds it to [MIN_DELIVERY_WINDOW,
 * MAX_DELIVERY_WINDOW] and reverts `BadWindow` outside them — and those bounds
 * are now deployment-chosen, so a constant compiled in here would be a value
 * that is correct against one deployment and reverts against the next. Read
 * them, clamp into them.
 *
 * The default is deliberately near the FLOOR rather than the middle. A delivery
 * window is the requester's exposure: escrow is locked for its whole length and
 * `cancelJob` is Open-only, so a generous default spends somebody else's money
 * on patience they did not ask for. Callers that know the work is long pass a
 * number.
 */
export const DEFAULT_DELIVERY_WINDOW_S = 60 * 60

let windowBounds: { min: number; max: number } | null = null
async function clampDeliveryWindow(requested?: number): Promise<number> {
  if (!windowBounds) {
    const [min, max] = await Promise.all([
      publicClient().readContract({ ...market(), functionName: 'MIN_DELIVERY_WINDOW' }),
      publicClient().readContract({ ...market(), functionName: 'MAX_DELIVERY_WINDOW' }),
    ])
    windowBounds = { min: Number(min), max: Number(max) }
  }
  const want = requested ?? DEFAULT_DELIVERY_WINDOW_S
  return Math.min(Math.max(want, windowBounds.min), windowBounds.max)
}

/**
 * Post a job on V2: approve `postCost(bounty)` and `postJob`, in one UserOp.
 *
 * **`postCost`, not the bounty** — and it is read from the contract rather than
 * recomputed here. V2 charges `flatFee + bounty*feeBps/10000` ON TOP, so an
 * allowance of exactly the bounty reverts every posting on any deployment with
 * a fee. `lib/onchain/labor.ts` still approves the bounty, correctly, because
 * the V1 contract it targets has no fee — which is why this is a separate
 * function and not an edit to that one.
 *
 * Reading `postCost` instead of reimplementing it is the same rule the contract
 * states for `releaseSplit`: a caller that recomputes the split is a caller that
 * can get it wrong, and here getting it wrong means every post fails.
 */
export async function postJobV2(
  requesterAgentId: string,
  bountyUsd: number,
  minScore: number,
  specHash: Hex,
  deliveryWindowSec?: number,
): Promise<Hex> {
  const bounty = toUnits(bountyUsd)
  const cost = (await publicClient().readContract({
    ...market(),
    functionName: 'postCost',
    args: [bounty],
  })) as bigint
  const window = await clampDeliveryWindow(deliveryWindowSec)

  // sendAgentCalls, not getAgentKernel: going straight to the kernel made
  // posting a job impossible in EOA mode, and invisible to the gas fuse.
  return sendAgentCalls(
    requesterAgentId,
    [
      {
        to: onchainEnv.usdcAddress as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: USDC_ABI,
          functionName: 'approve',
          args: [onchainEnv.laborMarketAddress as Address, cost],
        }),
      },
      {
        to: onchainEnv.laborMarketAddress as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: LABOR_MARKET_V2_ABI,
          functionName: 'postJob',
          args: [bounty, BigInt(minScore), specHash, window],
        }),
      },
    ],
    { label: 'postJob' },
  )
}

/**
 * Accept a job on V2: approve `bondFor(bounty)` and `acceptJob`, in one UserOp.
 *
 * V1's `acceptJob` took no money, so its call site sends a bare transaction. On
 * V2 accepting stakes a bond, and without the allowance `_safeTransferFrom`
 * reverts and the worker simply cannot take work — the whole supply side stops,
 * silently, on a deployment where `BOND_BPS` or `FLAT_BOND` is non-zero.
 *
 * Batched into one UserOp rather than two: the approval is worthless on its own
 * and leaving a dangling allowance to the market is a standing authorisation
 * nobody asked for.
 *
 * Zero bond is the first mainnet configuration, and it takes the same path — the
 * approve is a no-op call, one extra encoded call inside a UserOp that was
 * happening anyway. Not special-cased, because a branch that only runs on some
 * deployments is a branch that is only tested on some deployments.
 */
export async function acceptJobV2(workerAgentId: string, jobId: number): Promise<Hex> {
  const client = publicClient()
  const job = (await client.readContract({
    ...market(),
    functionName: 'jobs',
    args: [BigInt(jobId)],
  })) as readonly unknown[]
  // Field 2 is `bounty`. The struct order is pinned by tests/labor-v2-artifact.
  const bond = (await client.readContract({
    ...market(),
    functionName: 'bondFor',
    args: [job[2] as bigint],
  })) as bigint

  // Same defect as postJobV2, and the other half of the reported symptom:
  // accepting a job IS mining, so the kernel-only batch took the worker side
  // down too on an EOA deployment.
  return sendAgentCalls(
    workerAgentId,
    [
      {
        to: onchainEnv.usdcAddress as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: USDC_ABI,
          functionName: 'approve',
          args: [onchainEnv.laborMarketAddress as Address, bond],
        }),
      },
      {
        to: onchainEnv.laborMarketAddress as Address,
        value: 0n,
        data: encodeFunctionData({ abi: LABOR_MARKET_V2_ABI, functionName: 'acceptJob', args: [BigInt(jobId)] }),
      },
    ],
    { label: 'acceptJob' },
  )
}

/** What settlement has credited an address and not yet handed over. */
export async function withdrawableOf(who: Address): Promise<number> {
  const address = onchainEnv.laborMarketAddress
  if (!address) return 0
  const raw = await publicClient().readContract({
    address: address as Address,
    abi: LABOR_MARKET_V2_ABI,
    functionName: 'withdrawable',
    args: [who],
  })
  return fromUnits(raw as bigint)
}

/** Collect it. Settlement credits rather than transfers, so without this call
 *  an agent's earnings are a number in a mapping and never tokens it holds. */
export async function withdraw(agentId: string): Promise<Hex> {
  return sendAgentCall(agentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: encodeFunctionData({ abi: LABOR_MARKET_V2_ABI, functionName: 'withdraw' }),
  })
}
