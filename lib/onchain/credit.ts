/**
 * Registry + vault + EAS operations, expressed at the domain level.
 * Callers (credit engine, server actions) use these without touching viem.
 */
import { encodeAbiParameters, encodeFunctionData, parseUnits, keccak256, toHex, type Address, type Hex } from 'viem'
import {
  EAS_ABI,
  EAS_SCHEMA,
  REGISTRY_ABI,
  USDC_ABI,
  USDC_DECIMALS,
  VAULT_ABI,
  onchainEnv,
} from './config'
import { oracleWallet, publicClient } from './clients'
import { sendAgentCall } from './account'

const toUnits = (usd: number) => parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS)
const fromUnits = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS

/** Oracle publishes an agent's recalculated limit + score to the registry. */
export async function publishLimit(
  agentAddress: Address,
  creditLimitUsd: number,
  score: number,
): Promise<Hex> {
  const wallet = oracleWallet()
  return wallet.writeContract({
    address: onchainEnv.registryAddress as Address,
    abi: REGISTRY_ABI,
    functionName: 'setLimit',
    args: [agentAddress, toUnits(creditLimitUsd), BigInt(score)],
  })
}

/** Oracle writes an EAS attestation of the credit assessment. Returns the tx
 *  hash; the attestation UID is emitted by EAS and read from the receipt logs. */
export async function attestCredit(input: {
  agentId: string
  agentAddress: Address
  score: number
  rating: string
  creditLimitUsd: number
  riskLevel: string
}): Promise<Hex> {
  if (!onchainEnv.easSchemaUid) throw new Error('EAS_SCHEMA_UID not configured')

  const data = encodeAbiParameters(
    [
      { name: 'agentId', type: 'bytes32' },
      { name: 'creditScore', type: 'uint256' },
      { name: 'rating', type: 'string' },
      { name: 'creditLimit', type: 'uint256' },
      { name: 'riskLevel', type: 'string' },
    ],
    [
      keccak256(toHex(input.agentId)),
      BigInt(input.score),
      input.rating,
      toUnits(input.creditLimitUsd),
      input.riskLevel,
    ],
  )

  const wallet = oracleWallet()
  return wallet.writeContract({
    address: onchainEnv.easAddress,
    abi: EAS_ABI,
    functionName: 'attest',
    args: [
      {
        schema: onchainEnv.easSchemaUid as Hex,
        data: {
          recipient: input.agentAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
          data,
          value: 0n,
        },
      },
    ],
  })
}

/** On-chain available headroom (limit − outstanding) for an agent account. */
export async function readAvailable(agentAddress: Address): Promise<number> {
  const value = await publicClient().readContract({
    address: onchainEnv.vaultAddress as Address,
    abi: VAULT_ABI,
    functionName: 'available',
    args: [agentAddress],
  })
  return fromUnits(value as bigint)
}

export async function readOutstanding(agentAddress: Address): Promise<number> {
  const value = await publicClient().readContract({
    address: onchainEnv.vaultAddress as Address,
    abi: VAULT_ABI,
    functionName: 'outstanding',
    args: [agentAddress],
  })
  return fromUnits(value as bigint)
}

/** Agent draws credit from the vault via a sponsored UserOp. */
export async function drawOnchain(agentId: string, amountUsd: number): Promise<Hex> {
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: 'draw',
    args: [toUnits(amountUsd)],
  })
  return sendAgentCall(agentId, { to: onchainEnv.vaultAddress as Address, data })
}

/** Agent repays: approve the vault to pull USDC, then call repay — batched
 *  into a single UserOp so it's one atomic on-chain action. */
export async function repayOnchain(agentId: string, amountUsd: number): Promise<Hex> {
  const amount = toUnits(amountUsd)
  const approve = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'approve',
    args: [onchainEnv.vaultAddress as Address, amount],
  })
  const repay = encodeFunctionData({ abi: VAULT_ABI, functionName: 'repay', args: [amount] })

  // Two calls, through the mode-aware sender. This was a direct kernel batch, so
  // REPAYING A LOAN was impossible in EOA mode — the worst member of this family,
  // because a borrower who cannot repay accrues a default it did not earn.
  const { sendAgentCalls } = await import('./account')
  return sendAgentCalls(
    agentId,
    [
      { to: onchainEnv.usdcAddress as Address, value: 0n, data: approve },
      { to: onchainEnv.vaultAddress as Address, value: 0n, data: repay },
    ],
    { label: 'repay' },
  )
}
