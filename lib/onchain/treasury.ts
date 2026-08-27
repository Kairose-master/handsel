/**
 * Treasury layer: the agent's smart account as a real wallet.
 * Deposits are just transfers to the account address; withdrawals/payments
 * are USDC transfers executed as sponsored UserOps from the agent's account.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'
import { IS_REAL_MONEY, USDC_ABI, USDC_DECIMALS, onchainEnv } from './config'
import { publicClient } from './clients'
import { sendAgentCall } from './account'
import { mintBlocker } from './mainnet-guard'

const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const

// MockUSDC.mint is permissionless on testnet — anyone (including the agent's
// own smart account) may mint to any address. This lets users self-fund test
// USDC entirely in-app, no CLI or deployer key required.
const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const

export async function usdcBalanceOf(address: Address): Promise<number> {
  const value = (await publicClient().readContract({
    address: onchainEnv.usdcAddress as Address,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint
  return Number(value) / 10 ** USDC_DECIMALS
}

/** The agent account's native ETH, in wei.
 *
 *  Worth surfacing because on a deployment with no paymaster this is what
 *  decides whether the agent can act at all: below the floor in
 *  lib/onchain/account.ts it cannot accept a job, including one already
 *  escrowed for it. It is also real money the owner put in and, until
 *  withdrawEth existed, could not take out. */
export async function ethBalanceOfWei(address: Address): Promise<bigint> {
  return publicClient().getBalance({ address })
}

/** Same, as ether. Display only — never round-trip a balance through a float
 *  to compute a transfer amount. */
export async function ethBalanceOf(address: Address): Promise<number> {
  return Number(await ethBalanceOfWei(address)) / 1e18
}

/** Send native ETH from the agent's smart account. `data: '0x'` with a value
 *  is a plain transfer; it goes through sendAgentCall so it obeys the same gas
 *  fuse and lane accounting as every other write. */
export async function transferEth(agentId: string, to: Address, amountWei: bigint): Promise<Hex> {
  return sendAgentCall(agentId, { to, data: '0x', value: amountWei })
}

/** Send USDC from the agent's smart account to any external address. */
export async function transferUsdc(agentId: string, to: Address, amountUsd: number): Promise<Hex> {
  const data = encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS)],
  })
  return sendAgentCall(agentId, { to: onchainEnv.usdcAddress as Address, data })
}

/** Self-mint test USDC into the agent's own smart account (testnet only). */
export async function mintTestUsdc(agentId: string, amountUsd: number, toAddress: Address): Promise<Hex> {
  // Refused BEFORE the UserOperation is built. On a real chain the escrow
  // token is issued by someone else and has no permissionless mint, so this
  // would revert — but only after the sponsored gas was already spent, which
  // is the operator paying for a guaranteed failure.
  const blocked = mintBlocker(IS_REAL_MONEY)
  if (blocked) throw new Error(blocked.detail)

  const data = encodeFunctionData({
    abi: MINT_ABI,
    functionName: 'mint',
    args: [toAddress, parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS)],
  })
  return sendAgentCall(agentId, { to: onchainEnv.usdcAddress as Address, data })
}
