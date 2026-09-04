/**
 * On-chain layer configuration — Base mainnet in production, Base Sepolia
 * for the V2 rehearsal, plus Ethereum Sepolia and GIWA Sepolia for earlier
 * deployments (see `docs/deployments.md` for which URL runs which chain).
 *
 * The whole on-chain layer is OPTIONAL and gated on these env vars — when
 * they're absent the app runs exactly as before (off-chain only). When set,
 * the credit engine mirrors each recalculated limit to the registry and
 * attests the score via EAS, and agents can draw/repay real (test) USDC
 * through their own on-chain accounts.
 *
 * Chain is selected with ONCHAIN_CHAIN ('sepolia' default | 'base' |
 * 'base-sepolia' | 'giwa-sepolia' — see the CHAINS map below). Agent
 * accounts run in one of two modes (AGENT_ACCOUNT_MODE, auto-detected
 * from ZERODEV_RPC/BUNDLER_RPC when unset):
 *  - 'kernel': ERC-4337 Kernel smart accounts via ZeroDev — what mainnet runs.
 *  - 'eoa':    per-agent EOAs derived deterministically from the owner key —
 *              for chains where 4337 infra (bundler/paymaster/Kernel factory)
 *              isn't live yet, like GIWA Sepolia as of 2026-07. Same
 *              one-key/N-agents property, no bundler dependency.
 */
import { defineChain } from 'viem'
import { base, baseSepolia, sepolia } from 'viem/chains'

export const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
})

/**
 * Every chain this app can be pointed at.
 *
 * **`base-sepolia` was missing, and it is where the deploy scripts default to.**
 * `scripts/deploy-labor-v2.mjs` and `scripts/deploy-registry.mjs` accept
 * `base-sepolia` (their default) or `base`; this list accepted `sepolia`,
 * `giwa-sepolia` or `base`. The two overlapped on mainnet alone, so the chain a
 * testnet deploy actually lands on was one the app could not name — and the
 * `?? sepolia` below turned that into silence rather than an error: the app
 * would read a real market address on the wrong chain, every call would revert,
 * `isV2Market()` would answer false, and it would go on behaving as a V1
 * market. Everything wired for V2 would simply not run, with nothing saying so.
 *
 * Pinned against the scripts by tests/chain-list-parity.test.ts.
 */
const CHAINS = { sepolia, 'giwa-sepolia': giwaSepolia, 'base-sepolia': baseSepolia, base } as const

/**
 * An UNSET chain defaults; an unrecognised one THROWS.
 *
 * Those are different mistakes. Absent means "no on-chain layer", which is a
 * supported way to run this app. A value that is present and unknown is always
 * a typo, and the old `?? sepolia` answered it by quietly picking a chain — the
 * one failure mode where a wrong answer looks exactly like a right one.
 */
const chainName = process.env.ONCHAIN_CHAIN
if (chainName && !(chainName in CHAINS)) {
  throw new Error(
    `ONCHAIN_CHAIN="${chainName}" is not a chain this app knows. ` +
      `Expected one of: ${Object.keys(CHAINS).join(', ')}. ` +
      `Falling back silently would point every contract read at the wrong chain.`,
  )
}
export const CHAIN = CHAINS[(chainName ?? 'sepolia') as keyof typeof CHAINS]
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
  /**
   * Comma-separated backup chain-RPC URLs, tried in order when the primary
   * fails (measured failure mode: 429 from a rate-limited provider — see
   * lib/onchain/transport.ts). Optional; unset means primary-only, exactly
   * the previous behavior.
   */
  rpcFallbackUrls: process.env.ONCHAIN_RPC_FALLBACK_URLS ?? '',
  zerodevRpc: process.env.ZERODEV_RPC ?? '', // legacy name: ZeroDev's URL was bundler AND paymaster
  /**
   * The bundler, whoever runs it.
   *
   * `ZERODEV_RPC` named a vendor for a role, and while that vendor supplied both
   * roles the name cost nothing. It costs something the moment the paymaster
   * moves: CDP serves bundling and sponsorship from ONE url, so pointing at it
   * meant either setting a variable named for a competitor or not being able to
   * leave. `BUNDLER_RPC` is the role. The old name still works, and on the
   * testnet nothing changes.
   */
  bundlerRpc: (process.env.BUNDLER_RPC?.trim() || process.env.ZERODEV_RPC) ?? '',
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

/**
 * How agent accounts transact. Explicit env wins; otherwise inferred from
 * whether a bundler is configured.
 *
 * The inference is convenient and it is also how a mainnet deployment intended
 * to run in kernel mode came up in EOA mode with nothing said. Forgetting
 * ZERODEV_RPC is not obviously a decision about account type, but it is one, and
 * the two modes derive DIFFERENT ADDRESSES from the same owner key — so the
 * fallback silently relocates every agent's money.
 *
 * Kept, because removing it breaks every deployment that relies on it. Made
 * audible instead: `agentAccountModeSource` says whether a human chose this, and
 * /api/capabilities reports it.
 */
export const agentAccountMode: 'kernel' | 'eoa' =
  process.env.AGENT_ACCOUNT_MODE === 'eoa' || process.env.AGENT_ACCOUNT_MODE === 'kernel'
    ? process.env.AGENT_ACCOUNT_MODE
    : onchainEnv.bundlerRpc
      ? 'kernel'
      : 'eoa'

/** Whether a human set the mode, or it fell out of another variable's absence. */
export const agentAccountModeSource: 'explicit' | 'inferred' =
  process.env.AGENT_ACCOUNT_MODE === 'eoa' || process.env.AGENT_ACCOUNT_MODE === 'kernel'
    ? 'explicit'
    : 'inferred'

/**
 * True when the oracle can WRITE A CREDIT SCORE to the registry.
 *
 * Narrower than `isOnchainConfigured` on purpose, and the difference is the
 * whole product. `setLimit` is a registry call by the oracle; it does not touch
 * the vault, and neither does the EAS attestation beside it. Requiring
 * `CREDIT_VAULT_ADDRESS` to publish a score made the credit engine's on-chain
 * mirror return early on a deployment where the registry was deployed, the
 * oracle key was right and the agents were provisioned.
 *
 * Measured: two agents provisioned against registry 0xA5C1…, both reading
 * `creditScore = 0`, and ZERO `LimitUpdated` events in the log — so nothing had
 * been published rather than zero having been. Storage cannot tell those apart;
 * the event can, which is the only reason this was found.
 *
 * A score nobody publishes is the claim this product is built on, quietly not
 * happening.
 */
export function isRegistryConfigured(): boolean {
  return Boolean(onchainEnv.rpcUrl && onchainEnv.oraclePrivateKey && onchainEnv.registryAddress)
}

/**
 * True when enough is configured to talk to the registry AND THE VAULT as the
 * oracle — i.e. for borrow/repay, which is the only thing that reads the vault.
 *
 * Do not reach for this to gate anything else. It has now been the wrong
 * predicate three times: it hid the Provision button, it blocked
 * `isAgentAccountConfigured`, and it silenced the registry mirror above.
 */
export function isOnchainConfigured(): boolean {
  return Boolean(
    onchainEnv.rpcUrl &&
      onchainEnv.oraclePrivateKey &&
      onchainEnv.registryAddress &&
      onchainEnv.vaultAddress,
  )
}

/**
 * True when agents can transact.
 *
 * Exactly three things: an RPC to send to, the key that owns every agent
 * account, and a transport — kernel mode needs the ZeroDev bundler, EOA mode
 * needs nothing further (gas is topped up by the oracle account).
 *
 * **It used to also require `isOnchainConfigured()`, and that was wrong.** That
 * predicate is about talking to the registry and the VAULT as the oracle, so it
 * demands `CREDIT_VAULT_ADDRESS` — and through this function the requirement
 * reached `isLaborMarketConfigured`, `isVerifiedEscrowConfigured` and
 * `isGovernanceOnchainConfigured`, none of which touch the vault. The vault is
 * used in `lib/onchain/credit.ts` alone, for borrow and repay.
 *
 * So a labour market deployed, funded and correct was reported unconfigured
 * because an unrelated contract had not been deployed — and the symptom was
 * `GET /api/tasks` answering 503 with the market address sitting right there in
 * the env. Measured against 0xbd0fb5… on Base Sepolia.
 *
 * `isOnchainConfigured` itself is unchanged and still means what it says; its
 * own callers are the credit paths that really do need the vault.
 */
export function isAgentAccountConfigured(): boolean {
  if (!onchainEnv.rpcUrl || !onchainEnv.agentOwnerPrivateKey) return false
  return agentAccountMode === 'eoa' || Boolean(onchainEnv.bundlerRpc)
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
  // Read so the configured token's decimals can be checked against
  // USDC_DECIMALS. Every amount in this system is scaled by that constant, so
  // a token with different decimals is off by orders of magnitude in a way
  // nothing else would notice — a $5 bounty escrowing $5,000,000, or $0.000005.
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
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
