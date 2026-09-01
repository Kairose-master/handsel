/**
 * The two chain calls an advance is made of, and the order they go in.
 *
 * `assignPayee` perfects the lender's claim; a USDC transfer hands over the
 * money. **The lien goes first, always.** Disbursing before assigning leaves a
 * window — one failed UserOp wide — in which the borrower has the cash and the
 * lender has nothing but a request, and every one of `assignPayee`'s reverts
 * lands inside exactly that window: the deadline passes (`TooLate`), another
 * lender got there first (`PayeeAlreadySet`), the job was submitted or
 * reclaimed in the meantime (`WrongStatus`). Those are not exotic; they are
 * what a market does while a transaction is in flight.
 *
 * The reverse order fails safe. A pledge that lands and a disbursement that
 * does not leaves the borrower with an unused lien on its own job — bad, and
 * fixable by paying, and nobody is out of pocket. That asymmetry is why the
 * sequence is not a preference.
 *
 * They are NOT one UserOp, and cannot be: the two calls are sent by different
 * accounts. Only `job.worker` may assign, and only the lender can move the
 * lender's USDC. So the ordering is enforced here, in code, by reading the
 * chain back between the two.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { sendAgentCall } from '@/lib/onchain/account'
import { publicClient } from '@/lib/onchain/clients'
import { USDC_DECIMALS, onchainEnv } from '@/lib/onchain/config'
import { LABOR_MARKET_V2_ABI } from '@/lib/onchain/labor-v2-artifact'
import { V2_JOB_STATUS, type V2JobStatus } from '@/lib/deadlines'
import type { AdvanceCollateral } from '@/lib/advance'

const market = () => ({ address: onchainEnv.laborMarketAddress as Address, abi: LABOR_MARKET_V2_ABI }) as const
const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS
const toUnits = (usd: number) => BigInt(Math.round(usd * 10 ** USDC_DECIMALS))

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as const

/**
 * Read a job as collateral.
 *
 * Straight from `jobs(jobId)` rather than from any cached mirror. The whole
 * decision turns on status, deadline and whether a payee is already set, and
 * all three are exactly the fields a stale read gets wrong in the direction
 * that costs the lender money.
 */
export async function readCollateral(jobId: number): Promise<AdvanceCollateral | null> {
  if (!onchainEnv.laborMarketAddress) return null
  const job = (await publicClient().readContract({
    ...market(),
    functionName: 'jobs',
    args: [BigInt(jobId)],
  })) as readonly unknown[]

  const requester = job[0] as Address
  // A job that was never posted decodes as all zeroes rather than reverting.
  if (requester === ZERO_ADDRESS) return null

  const statusIndex = Number(job[4] as number)
  const status: V2JobStatus | undefined = V2_JOB_STATUS[statusIndex]
  if (!status) return null

  return {
    jobId,
    contract: onchainEnv.laborMarketAddress,
    bountyUsd: fromUnits(job[2] as bigint),
    status,
    // Field 8 is `deliveryDeadline`, in unix SECONDS. Everything above this
    // layer works in milliseconds; converting here rather than at each call
    // site is what stops one of them from comparing seconds to Date.now().
    deliveryDeadlineMs: Number(job[8] as bigint) * 1000,
    existingPayee: job[12] as Address,
  }
}

/** Who the job pays and how much, as the contract itself would split it. The
 *  one function a lender is told to trust — see the contract's own note on it. */
export async function readReleaseSplit(
  jobId: number,
): Promise<{ payee: Address; toPayeeUsd: number; toWorkerUsd: number } | null> {
  if (!onchainEnv.laborMarketAddress) return null
  const [payee, toPayee, toWorker] = (await publicClient().readContract({
    ...market(),
    functionName: 'releaseSplit',
    args: [BigInt(jobId)],
  })) as readonly [Address, bigint, bigint]
  return { payee, toPayeeUsd: fromUnits(toPayee), toWorkerUsd: fromUnits(toWorker) }
}

/**
 * Perfect the lender's claim. Sent by the BORROWER, because the contract
 * accepts this from `job.worker` and from nobody else — the borrower pledging
 * its own receivable is the whole shape of the thing.
 */
export async function assignPayeeOnchain(
  borrowerAgentId: string,
  jobId: number,
  payee: Address,
  pledgeUsd: number,
): Promise<Hex> {
  return sendAgentCall(
    borrowerAgentId,
    {
      to: onchainEnv.laborMarketAddress as Address,
      data: encodeFunctionData({
        abi: LABOR_MARKET_V2_ABI,
        functionName: 'assignPayee',
        args: [BigInt(jobId), payee, toUnits(pledgeUsd)],
      }),
    },
    { label: 'assignPayee' },
  )
}

/**
 * Confirm the lien the chain actually holds, before a cent moves.
 *
 * A transaction hash is not confirmation. `sendAgentCall` returns once the
 * call is sent and mined, and "mined" is not "did what I meant" — the pledge
 * this checks for is the one thing standing between the lender and an
 * unsecured transfer, so it is read back from state rather than inferred from
 * a receipt.
 *
 * The amount is compared with a one-cent tolerance in the LENDER's favour:
 * USDC has six decimals and the quote has two, so an exact equality here is a
 * float comparison dressed up as a security check.
 */
export async function verifyLien(
  jobId: number,
  expectedPayee: Address,
  expectedPledgeUsd: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const split = await readReleaseSplit(jobId)
  if (!split) return { ok: false, reason: 'The market did not answer — the lien could not be confirmed.' }
  if (split.payee.toLowerCase() !== expectedPayee.toLowerCase()) {
    return { ok: false, reason: `The job pays ${split.payee}, not the lender.` }
  }
  if (split.toPayeeUsd + 0.01 < expectedPledgeUsd) {
    return { ok: false, reason: `The lien is $${split.toPayeeUsd.toFixed(2)}, short of the $${expectedPledgeUsd.toFixed(2)} agreed.` }
  }
  return { ok: true }
}
