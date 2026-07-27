/**
 * On-chain layer configuration (Ethereum Sepolia or GIWA Sepolia).
 *
 * The whole on-chain layer is OPTIONAL and gated on these env vars — when
 * they're absent the app runs exactly as before (off-chain only). When set,
 * the credit engine mirrors each recalculated limit to the registry and
 * attests the score via EAS, and agents can draw/repay real (test) USDC
 * through their own on-chain accounts.
 *
 * Chain is selected with ONCHAIN_CHAIN ('sepolia' default | 'giwa-sepolia').
 * Agent accounts run in one of two modes (AGENT_ACCOUNT_MODE, auto-detected
 * from ZERODEV_RPC when unset):
 *  - 'kernel': ERC-4337 Kernel smart accounts via ZeroDev (Sepolia).
 *  - 'eoa':    per-agent EOAs derived deterministically from the owner key —
 *              for chains where 4337 infra (bundler/paymaster/Kernel factory)
 *              isn't live yet, like GIWA Sepolia as of 2026-07. Same
 *              one-key/N-agents property, no bundler dependency.
 */
import { defineChain } from 'viem'
import { base, sepolia } from 'viem/chains'

export const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
})

const CHAINS = { sepolia, 'giwa-sepolia': giwaSepolia, base } as const
export const CHAIN = CHAINS[(process.env.ONCHAIN_CHAIN ?? 'sepolia') as keyof typeof CHAINS] ?? sepolia
export const EXPLORER_URL = CHAIN.blockExplorers?.default.url ?? 'https://sepolia.etherscan.io'
export const USDC_DECIMALS = 6

/**
 * Is the configured chain one where losing money means losing money?
 *
 * Everything in this codebase was written against a testnet and quietly
 * assumes it: the escrow token is mintable by anyone, the faucet posts
 * practice work, gas is sponsored without a budget. None of those assumptions
 * survives contact with a real chain, and the dangerous ones fail silently
 * rather than loudly — so the chain's own `testnet` flag is turned into a
 * first-class fact that the money paths can consult.
 *
 * viem sets `testnet` on test chains and leaves it undefined on mainnets, so
 * the check is deliberately "not explicitly a testnet" rather than "explicitly
 * a mainnet": an unknown chain is treated as real money, which is the safe
 * direction to be wrong in.
 */
export const IS_REAL_MONEY = CHAIN.testnet !== true

/** EAS deployment per chain. GIWA and Base are OP Stack, so EAS ships as a
 *  predeploy at the standard address; Sepolia uses the standalone deployment.
 *  GIWA's was verified present with eth_getCode. Base's is the documented OP
 *  Stack predeploy and should be verified the same way before it is relied on
 *  — a wrong address here breaks attestations, which is loud, rather than
 *  losing funds, which is not. */
const EAS_DEFAULTS: Record<number, `0x${string}`> = {
  [sepolia.id]: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e',
  [giwaSepolia.id]: '0x4200000000000000000000000000000000000021',
  [base.id]: '0x4200000000000000000000000000000000000021',
}

export const onchainEnv = {
  rpcUrl: process.env.ONCHAIN_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? '',
  zerodevRpc: process.env.ZERODEV_RPC ?? '', // bundler + paymaster (ZeroDev v3 RPC), kernel mode only
  oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY ?? '', // publishes limits + attests
  agentOwnerPrivateKey: process.env.AGENT_OWNER_PRIVATE_KEY ?? '', // signer behind every agent account
  registryAddress: (process.env.CREDIT_REGISTRY_ADDRESS ?? '') as `0x${string}` | '',
  vaultAddress: (process.env.CREDIT_VAULT_ADDRESS ?? '') as `0x${string}` | '',
  laborMarketAddress: (process.env.LABOR_MARKET_ADDRESS ?? '') as `0x${string}` | '',
  verifiedEscrowAddress: (process.env.VERIFIED_TASK_ESCROW_ADDRESS ?? '') as `0x${string}` | '',
  /**
   * The escrow token. `USDC_ADDRESS` is the name to use; `MOCK_USDC_ADDRESS`
   * is read after it only so existing testnet deployments keep working.
   *
   * There is deliberately NO default. On a mainnet the wrong token address is
   * unrecoverable — funds approved and transferred to it are simply gone —
   * and a plausible-looking constant compiled into the app is exactly how that
   * happens. Unset fails loudly at startup; a wrong default fails silently at
   * settlement.
   */
  usdcAddress: (process.env.USDC_ADDRESS ?? process.env.MOCK_USDC_ADDRESS ?? '') as `0x${string}` | '',
  /**
   * Operator's explicit confirmation that the ZeroDev project has a spending
   * policy. Sponsored gas on a real chain is the operator's money, spendable
   * by anyone who can cause a UserOperation, and there is no way to detect the
   * policy from here — so it is an acknowledgement rather than a check.
   * See docs/v2-plan.md, paymaster section.
   */
  paymasterMeteredAck: process.env.PAYMASTER_METERED === 'true',
  veilpollFactoryAddress: (process.env.VEILPOLL_FACTORY_ADDRESS ?? '') as `0x${string}` | '', // commit-reveal poll factory
  governanceRevealDays: Number(process.env.GOVERNANCE_REVEAL_DAYS ?? '2'), // reveal window after a proposal closes
  // Both supported chains have an EAS default, so this is always a real address.
  easAddress: (process.env.EAS_ADDRESS ?? EAS_DEFAULTS[CHAIN.id]) as `0x${string}`,
  easSchemaUid: (process.env.EAS_SCHEMA_UID ?? '') as `0x${string}` | '',
}

/** How agent accounts transact. Explicit env wins; otherwise infer from
 *  whether a ZeroDev RPC is configured. */
export const agentAccountMode: 'kernel' | 'eoa' =
  process.env.AGENT_ACCOUNT_MODE === 'eoa' || process.env.AGENT_ACCOUNT_MODE === 'kernel'
    ? process.env.AGENT_ACCOUNT_MODE
    : onchainEnv.zerodevRpc
      ? 'kernel'
      : 'eoa'

/** True when enough is configured to talk to the registry/vault as the oracle. */
export function isOnchainConfigured(): boolean {
  return Boolean(
    onchainEnv.rpcUrl &&
      onchainEnv.oraclePrivateKey &&
      onchainEnv.registryAddress &&
      onchainEnv.vaultAddress,
  )
}

/** True when agents can transact. Kernel mode additionally needs the ZeroDev
 *  bundler RPC; EOA mode only needs the owner key (gas is topped up by the
 *  oracle account). */
export function isAgentAccountConfigured(): boolean {
  if (!onchainEnv.agentOwnerPrivateKey || !isOnchainConfigured()) return false
  return agentAccountMode === 'eoa' || Boolean(onchainEnv.zerodevRpc)
}

/** True when on-chain commit-reveal governance is available: a deployed
 *  poll registry AND agents that can transact to it. Off → governance
 *  stays purely off-chain (the default). */
export function isGovernanceOnchainConfigured(): boolean {
  return Boolean(onchainEnv.veilpollFactoryAddress && isAgentAccountConfigured())
}

/** True when the on-chain labor market is available. */
export function isLaborMarketConfigured(): boolean {
  return Boolean(onchainEnv.laborMarketAddress && isAgentAccountConfigured())
}

/** True when the verified-task escrow is available. */
export function isVerifiedEscrowConfigured(): boolean {
  return Boolean(onchainEnv.verifiedEscrowAddress && isAgentAccountConfigured())
}

export const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'setLimit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'limit', type: 'uint256' },
      { name: 'score', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'creditLimit',
    stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const VAULT_ABI = [
  { type: 'function', name: 'draw', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'repay', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'available', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'outstanding', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export const USDC_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export const LABOR_MARKET_ABI = [
  { type: 'function', name: 'postJob', stateMutability: 'nonpayable', inputs: [{ name: 'bounty', type: 'uint256' }, { name: 'minScore', type: 'uint256' }, { name: 'specHash', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'acceptJob', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'submitWork', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }, { name: 'resultHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'approveJob', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelJob', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'raiseDispute', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'resolveDispute', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }, { name: 'releaseToWorker', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'arbiter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'jobCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'jobs',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      { name: 'requester', type: 'address' },
      { name: 'worker', type: 'address' },
      { name: 'bounty', type: 'uint256' },
      { name: 'minScore', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'specHash', type: 'bytes32' },
      { name: 'resultHash', type: 'bytes32' },
    ],
  },
] as const

export const JOB_STATUS = ['Open', 'Accepted', 'Submitted', 'Completed', 'Cancelled', 'Disputed', 'Refunded'] as const
export type JobStatus = (typeof JOB_STATUS)[number]

export const VERIFIED_ESCROW_ABI = [
  { type: 'function', name: 'postTask', stateMutability: 'nonpayable', inputs: [{ name: 'bounty', type: 'uint256' }, { name: 'minScore', type: 'uint256' }, { name: 'specHash', type: 'bytes32' }, { name: 'answerHash', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'commitAnswer', stateMutability: 'nonpayable', inputs: [{ name: 'taskId', type: 'uint256' }, { name: 'commitment', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'revealAnswer', stateMutability: 'nonpayable', inputs: [{ name: 'taskId', type: 'uint256' }, { name: 'answer', type: 'string' }, { name: 'salt', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'cancelTask', stateMutability: 'nonpayable', inputs: [{ name: 'taskId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'taskCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'tasks',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      { name: 'requester', type: 'address' },
      { name: 'solver', type: 'address' },
      { name: 'bounty', type: 'uint256' },
      { name: 'minScore', type: 'uint256' },
      { name: 'specHash', type: 'bytes32' },
      { name: 'answerHash', type: 'bytes32' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'revealDeadline', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
  },
] as const

// EAS.attest((bytes32 schema, (address,uint64,bool,bytes32,bytes,uint256)))
export const EAS_ABI = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

/** ABI-encoding schema for the credit attestation payload. Register the same
 *  string in the EAS SchemaRegistry to obtain EAS_SCHEMA_UID. */
export const EAS_SCHEMA = 'bytes32 agentId,uint256 creditScore,string rating,uint256 creditLimit,string riskLevel'
