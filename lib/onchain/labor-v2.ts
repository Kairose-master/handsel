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
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { LABOR_MARKET_V2_ABI } from './labor-v2-artifact'
import { publicClient } from './clients'
import { onchainEnv, USDC_DECIMALS } from './config'
import { sendAgentCall } from './account'
import { V2_JOB_STATUS, type DeadlineJob, type ExitFn, type V2JobStatus } from '@/lib/deadlines'

const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS

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
  return sendAgentCall(agentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: encodeFunctionData({ abi: LABOR_MARKET_V2_ABI, functionName: fn, args: [BigInt(jobId)] }),
  })
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
