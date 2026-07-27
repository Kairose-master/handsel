/**
 * Agent account service — two interchangeable modes (config.agentAccountMode):
 *
 * 'kernel' — ZeroDev (ERC-4337 / Kernel) smart accounts. Each agent gets a
 * Kernel account derived deterministically from a single owner key plus a
 * per-agent index. Gas is sponsored by ZeroDev's paymaster. Requires the
 * chain to have live 4337 infra (bundler, paymaster, Kernel factory) —
 * true on Sepolia via ZERODEV_RPC.
 *
 * 'eoa' — plain per-agent EOAs, each derived deterministically from the same
 * single owner key (keccak of ownerKey ‖ agentId → private key). Used on
 * chains where 4337 infra isn't live yet (GIWA Sepolia as of 2026-07:
 * EntryPoint v0.7 exists as a predeploy, but no public bundler/paymaster and
 * no Kernel factory — verified via eth_getCode). Same one-key/N-agents
 * property and the same "the agent's own address transacts" semantics; gas
 * is auto-topped-up from the oracle account instead of sponsored.
 *
 * Both modes answer the same three calls: getAgentAccountAddress,
 * sendAgentCall, and (kernel-only, internal) getAgentKernel — so nothing
 * above this file knows which mode is active.
 *
 * Kernel mode targets @zerodev/sdk ^5.5 with EntryPoint v0.7 / Kernel v3.1.
 */
import { concat, createWalletClient, http, keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from '@zerodev/sdk'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'
import { CHAIN, agentAccountMode, onchainEnv } from './config'
import { publicClient, oracleWallet } from './clients'
import { withRetry } from '@/lib/retry'

const entryPoint = getEntryPoint('0.7')
const kernelVersion = KERNEL_V3_1

/** Stable per-agent account index derived from the agent id (kernel mode). */
export function accountIndex(agentId: string): bigint {
  return BigInt(keccak256(toHex(agentId))) % 2n ** 48n
}

function ownerKey(): Hex {
  const pk = onchainEnv.agentOwnerPrivateKey
  return (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
}

function ownerSigner() {
  return privateKeyToAccount(ownerKey())
}

// ---------------------------------------------------------------------------
// EOA mode
// ---------------------------------------------------------------------------

/** Deterministic per-agent private key: keccak256(ownerKey ‖ agentId).
 *  Never stored — re-derived on demand, so there is still exactly one secret
 *  (AGENT_OWNER_PRIVATE_KEY) no matter how many agents exist. */
function agentEoaAccount(agentId: string) {
  const derived = keccak256(concat([ownerKey(), toHex(agentId)]))
  return privateKeyToAccount(derived)
}

/** Gas floor/top-up for agent EOAs. GIWA gas runs ~0.001 gwei, so 0.0002 ETH
 *  funds thousands of calls; the oracle refills whenever a send finds the
 *  balance under the floor. */
const AGENT_GAS_FLOOR = 50_000_000_000_000n // 0.00005 ETH
const AGENT_GAS_TOPUP = 200_000_000_000_000n // 0.0002 ETH

async function ensureAgentGas(address: Address): Promise<void> {
  const client = publicClient()
  const balance = await client.getBalance({ address })
  if (balance >= AGENT_GAS_FLOOR) return
  const hash = await oracleWallet().sendTransaction({ to: address, value: AGENT_GAS_TOPUP })
  await client.waitForTransactionReceipt({ hash })
}

async function sendEoaCall(
  agentId: string,
  call: { to: Address; data: Hex; value?: bigint },
): Promise<Hex> {
  const account = agentEoaAccount(agentId)
  await ensureAgentGas(account.address)
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(onchainEnv.rpcUrl) })
  const hash = await wallet.sendTransaction({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })
  await publicClient().waitForTransactionReceipt({ hash })
  return hash
}

// ---------------------------------------------------------------------------
// Kernel (ERC-4337) mode
// ---------------------------------------------------------------------------

/** Build the Kernel account + client for one agent. */
export async function getAgentKernel(agentId: string) {
  const client = publicClient()
  const ecdsaValidator = await signerToEcdsaValidator(client, {
    signer: ownerSigner(),
    entryPoint,
    kernelVersion,
  })

  const account = await createKernelAccount(client, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
    index: accountIndex(agentId),
  })

  const paymaster = createZeroDevPaymasterClient({
    chain: CHAIN,
    transport: http(onchainEnv.zerodevRpc),
  })

  const kernelClient = createKernelAccountClient({
    account,
    chain: CHAIN,
    bundlerTransport: http(onchainEnv.zerodevRpc),
    client,
    paymaster,
  })

  // Serialize UserOp submission per smart account. Two UserOps from the same
  // account sent concurrently (e.g. the settle cron and a poll-triggered
  // settle) race on the same nonce and one fails with AA25. Chaining sends per
  // address makes the bundler hand out sequential nonces; an AA25 that still
  // slips through (cross-instance) is retried with backoff.
  const address = account.address as Address
  const rawSend = kernelClient.sendUserOperation.bind(kernelClient)
  ;(kernelClient as any).sendUserOperation = async (args: unknown) => {
    // The gas gate lives HERE, wrapped around the client itself, rather than at
    // each call site. Four call sites already batch their own UserOps instead
    // of going through sendAgentCall, and each was a door somebody had to
    // remember to lock — the next one added would have been unlocked by
    // default. Wrapping the client means a sponsored operation cannot be sent
    // without passing the meter, including from code not written yet.
    // lib/onchain/gas-policy.ts explains the allowance.
    const { requireSponsoredOp } = await import('./gas-meter')
    await requireSponsoredOp(agentId)

    return serializedSend(address, () =>
      withRetry(() => rawSend(args as Parameters<typeof rawSend>[0]), {
        retries: 4,
        baseMs: 500,
        retryable: isNonceCollision,
      }),
    )
  }

  return { account, kernelClient, address }
}

// ---- per-account UserOp serialization -------------------------------------
const accountSendChains = new Map<string, Promise<unknown>>()

function isNonceCollision(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    m.includes('aa25') ||
    m.includes('invalid smart account nonce') ||
    (m.includes('nonce') && (m.includes('already') || m.includes('same sender')))
  )
}

/** Run `send` only after any in-flight send for the same address settles, so
 *  the bundler assigns sequential nonces instead of colliding. */
async function serializedSend<T>(address: string, send: () => Promise<T>): Promise<T> {
  const prior = accountSendChains.get(address) ?? Promise.resolve()
  const run = prior.catch(() => {}).then(send)
  accountSendChains.set(
    address,
    run.catch(() => {}),
  )
  return run
}

// ---------------------------------------------------------------------------
// Mode-agnostic API
// ---------------------------------------------------------------------------

/** The agent's on-chain address (deterministic in both modes; no bundler
 *  needed to read). */
export async function getAgentAccountAddress(agentId: string): Promise<Address> {
  if (agentAccountMode === 'eoa') return agentEoaAccount(agentId).address

  const client = publicClient()
  const ecdsaValidator = await signerToEcdsaValidator(client, {
    signer: ownerSigner(),
    entryPoint,
    kernelVersion,
  })
  const account = await createKernelAccount(client, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
    index: accountIndex(agentId),
  })
  return account.address as Address
}

/**
 * A UserOperation that was accepted by the bundler but whose receipt did not
 * arrive before we stopped waiting.
 *
 * This is emphatically NOT a failure: the operation is in the bundler's
 * mempool and lands seconds later most of the time. Treating it as one is
 * how a worker's finished job gets recorded as "submit failed" while the
 * chain says Submitted — the two ledgers disagree and a human has to go
 * look. Callers that write terminal state must catch this and leave the
 * fact for the on-chain reconciliation sweeps to observe, rather than
 * writing a failure they cannot substantiate.
 */
export class UserOpPendingError extends Error {
  readonly userOpHash: Hex
  constructor(userOpHash: Hex, cause?: unknown) {
    super(`UserOperation ${userOpHash} was accepted by the bundler but not confirmed within the wait window — it may still land.`)
    this.name = 'UserOpPendingError'
    this.userOpHash = userOpHash
    this.cause = cause
  }
}

export function isUserOpPending(error: unknown): error is UserOpPendingError {
  return error instanceof UserOpPendingError
}

/** Send one call from the agent's account and wait for the receipt.
 *
 *  Sepolia bundlers are routinely slower than viem's default wait, and every
 *  on-chain write in the platform funnels through here, so a single missed
 *  receipt used to surface as an ordinary Error indistinguishable from a
 *  revert. Wait once, then wait again longer before concluding anything, and
 *  when it still hasn't landed say precisely that with UserOpPendingError. */
export async function sendAgentCall(
  agentId: string,
  call: { to: Address; data: Hex; value?: bigint },
): Promise<Hex> {
  // EOA mode is not sponsored — the gas lands on the agent's own balance, so
  // there is nothing of the operator's to meter.
  if (agentAccountMode === 'eoa') return sendEoaCall(agentId, call)

  const { account, kernelClient } = await getAgentKernel(agentId)
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([
      { to: call.to, value: call.value ?? 0n, data: call.data },
    ]),
  })

  for (const timeout of [30_000, 60_000]) {
    try {
      const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout })
      return receipt.receipt.transactionHash as Hex
    } catch (error) {
      // A timeout means "not yet"; anything else (a revert, an RPC refusal)
      // is a real answer and must propagate unchanged.
      if (!/timed out/i.test(error instanceof Error ? error.message : String(error))) throw error
      console.warn(`[onchain] userOp ${userOpHash} not confirmed within ${timeout}ms — waiting longer`)
    }
  }

  throw new UserOpPendingError(userOpHash)
}
