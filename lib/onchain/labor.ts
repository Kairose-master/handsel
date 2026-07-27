/**
 * On-chain labor market operations. Writes go through the acting agent's
 * ERC-4337 account (sponsored UserOps); reads come straight from the contract.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'
import { LABOR_MARKET_ABI, USDC_ABI, USDC_DECIMALS, JOB_STATUS, onchainEnv } from './config'
import { publicClient, oracleWallet } from './clients'
import { getAgentKernel, sendAgentCall } from './account'

const toUnits = (usd: number) => parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS)
const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS

export type OnchainJob = {
  id: number
  requester: Address
  worker: Address
  bounty: number
  minScore: number
  status: (typeof JOB_STATUS)[number]
  specHash: Hex
  resultHash: Hex
}

/** Post a job: approve the market and postJob, atomically.
 *
 *  NOTE for the V2 migration: V2 charges a protocol fee ON TOP of the bounty,
 *  so `postJob` there pulls `bounty + fee` and this approval — exactly the
 *  bounty — reverts. V2 exposes `postCost(bounty)` for precisely this; approve
 *  that. The V1 contract this file still targets has no fee, so the amount
 *  below is correct today and wrong the moment the address changes. */
export async function postJob(
  requesterAgentId: string,
  bountyUsd: number,
  minScore: number,
  specHash: Hex,
): Promise<Hex> {
  const amount = toUnits(bountyUsd)
  const approve = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'approve',
    args: [onchainEnv.laborMarketAddress as Address, amount],
  })
  const post = encodeFunctionData({
    abi: LABOR_MARKET_ABI,
    functionName: 'postJob',
    args: [amount, BigInt(minScore), specHash],
  })

  const { account, kernelClient } = await getAgentKernel(requesterAgentId)
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([
      { to: onchainEnv.usdcAddress as Address, value: 0n, data: approve },
      { to: onchainEnv.laborMarketAddress as Address, value: 0n, data: post },
    ]),
  })
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash })
  return receipt.receipt.transactionHash as Hex
}

function marketCall(fn: 'acceptJob' | 'approveJob' | 'cancelJob' | 'raiseDispute', jobId: number) {
  return encodeFunctionData({ abi: LABOR_MARKET_ABI, functionName: fn, args: [BigInt(jobId)] })
}

export async function acceptJob(workerAgentId: string, jobId: number): Promise<Hex> {
  return sendAgentCall(workerAgentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: marketCall('acceptJob', jobId),
  })
}

export async function submitWork(workerAgentId: string, jobId: number, resultHash: Hex): Promise<Hex> {
  const data = encodeFunctionData({
    abi: LABOR_MARKET_ABI,
    functionName: 'submitWork',
    args: [BigInt(jobId), resultHash],
  })
  return sendAgentCall(workerAgentId, { to: onchainEnv.laborMarketAddress as Address, data })
}

export async function approveJob(requesterAgentId: string, jobId: number): Promise<Hex> {
  return sendAgentCall(requesterAgentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: marketCall('approveJob', jobId),
  })
}

export async function cancelJob(requesterAgentId: string, jobId: number): Promise<Hex> {
  return sendAgentCall(requesterAgentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: marketCall('cancelJob', jobId),
  })
}

/** Requester disputes a submission instead of approving it — locks the
 *  escrow until the arbiter resolves it. */
export async function raiseDispute(requesterAgentId: string, jobId: number): Promise<Hex> {
  return sendAgentCall(requesterAgentId, {
    to: onchainEnv.laborMarketAddress as Address,
    data: marketCall('raiseDispute', jobId),
  })
}

/** Arbiter (the oracle EOA, independent of both parties) settles a disputed
 *  job. Signed directly by the oracle wallet, not an agent smart account. */
export async function resolveDispute(jobId: number, releaseToWorker: boolean): Promise<Hex> {
  const wallet = oracleWallet()
  return wallet.writeContract({
    address: onchainEnv.laborMarketAddress as Address,
    abi: LABOR_MARKET_ABI,
    functionName: 'resolveDispute',
    args: [BigInt(jobId), releaseToWorker],
  })
}

// readJobs used to issue one eth_call PER JOB, sequentially — with N jobs
// on the board and four pages polling every 4-10s, one open browser tab
// burned enough compute units to trip Alchemy's free-tier rate limit and
// kill unrelated settlement transactions mid-flight (observed live). Two
// fixes, ~98% fewer upstream calls together:
//   1. Multicall3 batching: all N job reads in one RPC round-trip.
//   2. A short in-memory cache with in-flight dedup: concurrent pollers
//      within the TTL share one result instead of each re-reading the
//      chain. Per-warm-lambda, which is exactly where the polling
//      hot-path concentrates.
const READ_JOBS_TTL_MS = 4000
let jobsCache: { at: number; jobs: OnchainJob[] } | null = null
let jobsInFlight: Promise<OnchainJob[]> | null = null

async function fetchJobsUncached(): Promise<OnchainJob[]> {
  const client = publicClient()
  const market = { address: onchainEnv.laborMarketAddress as Address, abi: LABOR_MARKET_ABI } as const

  const count = (await client.readContract({ ...market, functionName: 'jobCount' })) as bigint
  if (count === 0n) return []

  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1))
  const results = (await client.multicall({
    contracts: ids.map((id) => ({ ...market, functionName: 'jobs', args: [id] })),
    allowFailure: false,
  })) as unknown as readonly (readonly [Address, Address, bigint, bigint, number, Hex, Hex])[]

  const jobs = results.map((j, idx) => ({
    id: Number(ids[idx]),
    requester: j[0],
    worker: j[1],
    bounty: fromUnits(j[2]),
    minScore: Number(j[3]),
    status: JOB_STATUS[j[4]] ?? 'Open',
    specHash: j[5],
    resultHash: j[6],
  }))
  return jobs.reverse() // newest first
}

/** Read all jobs. Cached for a few seconds by default — pass
 *  { maxAgeMs: 0 } when the caller just wrote on-chain and must see its
 *  own write (e.g. resolving a freshly posted job's id). Status-guarded
 *  writers (approve/accept) tolerate the default staleness: acting on a
 *  stale status makes the tx revert harmlessly, it never double-moves. */
export async function readJobs(opts?: { maxAgeMs?: number }): Promise<OnchainJob[]> {
  const maxAge = opts?.maxAgeMs ?? READ_JOBS_TTL_MS
  const now = Date.now()
  if (jobsCache && now - jobsCache.at < maxAge) return jobsCache.jobs
  if (jobsInFlight && maxAge > 0) return jobsInFlight

  jobsInFlight = fetchJobsUncached()
    .then((jobs) => {
      jobsCache = { at: Date.now(), jobs }
      return jobs
    })
    .finally(() => {
      jobsInFlight = null
    })
  return jobsInFlight
}
