/**
 * Verified-task escrow operations. Post escrows the bounty; settlement is
 * commit-reveal from the solver's ERC-4337 account: commit binds the task to
 * the solver before the answer is visible on-chain (front-running protection),
 * reveal triggers automatic payout when the answer hash matches.
 */
import { encodeFunctionData, encodePacked, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem'
import { USDC_ABI, USDC_DECIMALS, VERIFIED_ESCROW_ABI, onchainEnv } from './config'
import { publicClient } from './clients'
import { getAgentAccountAddress, sendAgentCall, sendAgentCalls } from './account'

const toUnits = (usd: number) => parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS)

/** Escrow the bounty and post the task (approve + postTask in one UserOp).
 *  Returns the tx hash and the new on-chain task id. */
export async function postVerifiedTask(
  requesterAgentId: string,
  bountyUsd: number,
  minScore: number,
  specHash: Hex,
  answerHash: Hex,
): Promise<{ txHash: Hex; taskId: number }> {
  const amount = toUnits(bountyUsd)
  const approve = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'approve',
    args: [onchainEnv.verifiedEscrowAddress as Address, amount],
  })
  const post = encodeFunctionData({
    abi: VERIFIED_ESCROW_ABI,
    functionName: 'postTask',
    args: [amount, BigInt(minScore), specHash, answerHash],
  })

  // Same kernel-only batch the labour market had.
  const txHash = await sendAgentCalls(
    requesterAgentId,
    [
      { to: onchainEnv.usdcAddress as Address, value: 0n, data: approve },
      { to: onchainEnv.verifiedEscrowAddress as Address, value: 0n, data: post },
    ],
    { label: 'postTask' },
  )

  const count = (await publicClient().readContract({
    address: onchainEnv.verifiedEscrowAddress as Address,
    abi: VERIFIED_ESCROW_ABI,
    functionName: 'taskCount',
  })) as bigint

  return { txHash, taskId: Number(count) }
}

/** Compute the commitment binding (taskId, solver, salt, answer). */
export function buildCommitment(taskId: number, solver: Address, salt: Hex, answer: string): Hex {
  return keccak256(
    encodePacked(['uint256', 'address', 'bytes32', 'bytes'], [BigInt(taskId), solver, salt, toHex(answer)]),
  )
}

export const answerHashOf = (answer: string): Hex => keccak256(toHex(answer))

/** Solver settles: commit, then reveal (two sequential UserOps). On a correct
 *  answer the contract pays the bounty inside the reveal transaction. */
export async function commitAndReveal(
  solverAgentId: string,
  taskId: number,
  answer: string,
  salt: Hex,
): Promise<{ commitTx: Hex; revealTx: Hex }> {
  // getAgentAccountAddress, not getAgentKernel: this needed only an ADDRESS, and
  // the kernel one is the wrong address in EOA mode. A commitment bound to an
  // account that never reveals cannot be revealed by anyone — the solver's work
  // would be unrecoverable rather than merely rejected.
  const address = await getAgentAccountAddress(solverAgentId)
  const commitment = buildCommitment(taskId, address, salt, answer)

  const commitTx = await sendAgentCall(solverAgentId, {
    to: onchainEnv.verifiedEscrowAddress as Address,
    data: encodeFunctionData({
      abi: VERIFIED_ESCROW_ABI,
      functionName: 'commitAnswer',
      args: [BigInt(taskId), commitment],
    }),
  })

  const revealTx = await sendAgentCall(solverAgentId, {
    to: onchainEnv.verifiedEscrowAddress as Address,
    data: encodeFunctionData({
      abi: VERIFIED_ESCROW_ABI,
      functionName: 'revealAnswer',
      args: [BigInt(taskId), answer, salt],
    }),
  })

  return { commitTx, revealTx }
}

/** Requester reclaims escrow from an unclaimed (Open) task. */
export async function cancelVerifiedTask(requesterAgentId: string, taskId: number): Promise<Hex> {
  return sendAgentCall(requesterAgentId, {
    to: onchainEnv.verifiedEscrowAddress as Address,
    data: encodeFunctionData({
      abi: VERIFIED_ESCROW_ABI,
      functionName: 'cancelTask',
      args: [BigInt(taskId)],
    }),
  })
}

/** On-chain status of one task (enum index → label handled by caller). */
export async function readVerifiedTaskStatus(taskId: number): Promise<number> {
  const t = (await publicClient().readContract({
    address: onchainEnv.verifiedEscrowAddress as Address,
    abi: VERIFIED_ESCROW_ABI,
    functionName: 'tasks',
    args: [BigInt(taskId)],
  })) as readonly [Address, Address, bigint, bigint, Hex, Hex, Hex, bigint, number]
  return t[8]
}
