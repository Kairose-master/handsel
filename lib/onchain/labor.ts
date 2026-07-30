/**
 * On-chain labor market operations. Writes go through the acting agent's
 * ERC-4337 account (sponsored UserOps); reads come straight from the contract.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'
import { LABOR_MARKET_ABI, USDC_ABI, USDC_DECIMALS, JOB_STATUS, onchainEnv } from './config'
import { publicClient, oracleWallet } from './clients'
import { sendAgentCall, sendAgentCalls } from './account'
import { governingDeadline, hasLapsed } from '@/lib/deadlines'

const toUnits = (usd: number) => parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS)
const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS

export type OnchainJob = {
  id: number
  requester: Address
  worker: Address
  bounty: number
  minScore: number
  /**
   * V1's seven states, PLUS V2's eighth.
   *
   * Widened rather than cast, so every consumer has to acknowledge `Expired`
   * exists. It is the state a job reaches when a deadline settled it and NOBODY
   * judged the work — distinct from `Completed` (someone said it was good) and
   * `Refunded` (someone said it was not, or it never arrived). A reader that
   * collapses it into either one is reporting a verdict that was never reached,
   * which is the exact thing the contract added a separate state to prevent.
   *
   * Against a V1 market the value never occurs, so nothing that handles it is
   * wasted and nothing that ignores it is wrong today.
   */
  status: (typeof JOB_STATUS)[number] | 'Expired'
  specHash: Hex
  resultHash: Hex
  /**
   * The deadline governing the CURRENT state, unix seconds, or null on a V1
   * market which has none.
   *
   * Needed because `status` alone is not enough to know what may be done to a
   * job. The contract's enum changes only when somebody CALLS an exit, so a job
   * whose open window lapsed an hour ago still reads `Open` until `expireOpen`
   * runs. `Open` therefore means "open, or lapsed and not yet settled", and the
   * two differ in whether `acceptJob` reverts.
   *
   * Dropping it is why the board offered Accept on job #1 for 46 minutes after
   * it became unacceptable, and why pressing it produced a digest instead of a
   * sentence. `readJobsV2` decoded all four deadlines; this shape kept none.
   */
  deadline: number | null
  /** True when `deadline` has passed: the state is stale and the only thing
   *  left to do is call the exit that settles it. */
  lapsed: boolean
}

/**
 * Post a job: approve the market and postJob, atomically.
 *
 * **Routes to V2 when the configured address is a V2**, because the two
 * contracts disagree about this call in two ways at once and neither
 * disagreement fails politely. V2's `postJob` takes a fourth argument
 * (`deliveryWindow`), so the V1 encoding below targets a selector V2 does not
 * have; and V2 pulls `bounty + fee`, so an allowance of exactly the bounty
 * reverts on any deployment with a fee.
 *
 * The note that used to sit here said this would be "wrong the moment the
 * address changes" and left it at that. A warning is not a mechanism.
 *
 * The V1 path below is unchanged and stays correct for the V1 contract, which
 * is still live on Sepolia.
 */
export async function postJob(
  requesterAgentId: string,
  bountyUsd: number,
  minScore: number,
  specHash: Hex,
  deliveryWindowSec?: number,
): Promise<Hex> {
  const { isV2Market, postJobV2 } = await import('./labor-v2')
  if (await isV2Market()) {
    return postJobV2(requesterAgentId, bountyUsd, minScore, specHash, deliveryWindowSec)
  }
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

  // The V1 path has the same kernel-only defect its V2 replacement had. Fixed
  // here too rather than left as a trap for whoever points a deployment at a V1
  // market address.
  return sendAgentCalls(
    requesterAgentId,
    [
      { to: onchainEnv.usdcAddress as Address, value: 0n, data: approve },
      { to: onchainEnv.laborMarketAddress as Address, value: 0n, data: post },
    ],
    { label: 'postJob' },
  )
}

function marketCall(fn: 'acceptJob' | 'approveJob' | 'cancelJob' | 'raiseDispute', jobId: number) {
  return encodeFunctionData({ abi: LABOR_MARKET_ABI, functionName: fn, args: [BigInt(jobId)] })
}

/**
 * Accept a job.
 *
 * The selector is identical on both contracts, so unlike `postJob` this one
 * would encode fine against V2 — and still fail, because V2's `acceptJob` pulls
 * a bond and this sends no allowance with it. A worker would simply be unable to
 * take work, on every job, on any deployment with a non-zero bond.
 */
export async function acceptJob(workerAgentId: string, jobId: number): Promise<Hex> {
  const { isV2Market, acceptJobV2 } = await import('./labor-v2')
  if (await isV2Market()) return acceptJobV2(workerAgentId, jobId)
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
  // V2's `jobs` getter returns FOURTEEN fields and its status enum has eight
  // entries. Decoding that with the seven-field tuple below does not throw —
  // viem hands back the first seven and the reader gets numbers. Worse, the
  // `?? 'Open'` further down turns V2's eighth status (`Expired`) into `Open`,
  // which puts every timeout-settled job back on the board as available work.
  const { isV2Market, readJobsV2 } = await import('./labor-v2')
  const nowSec = Math.floor(Date.now() / 1000)
  if (await isV2Market()) {
    const v2 = await readJobsV2()
    return v2
      .map((j) => ({
        id: j.id,
        requester: j.requester,
        worker: j.worker,
        bounty: j.bounty,
        // These are decoded now. `specHash: '0x'` was not a missing display
        // field — it is the key every caller joins `job_specs` on, so zeroing it
        // detached the brief from the job. Every V2 job read back as "Untitled
        // job" with a null description and null acceptance criteria: a market in
        // which no worker can see what the work is. Verified against job #1 on
        // Base Sepolia, whose spec_hash was on chain the whole time.
        minScore: j.minScore,
        status: j.status,
        specHash: j.specHash,
        resultHash: j.resultHash,
        deadline: governingDeadline(j),
        lapsed: hasLapsed(j, nowSec),
      }))
      .reverse()
  }
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
    // V1 has no deadlines at all — that is the whole reason V2 exists. Null and
    // false are the honest answers here, not placeholders: nothing lapses on a
    // contract with nothing to lapse.
    deadline: null,
    lapsed: false,
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
