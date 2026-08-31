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
import { chainTransport } from './transport'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createKernelAccount,
  createKernelAccountClient,
} from '@zerodev/sdk'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'
import { CHAIN, agentAccountMode, onchainEnv } from './config'
import { bundlerDialect, paymasterClient } from './paymaster'
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
export const AGENT_GAS_FLOOR = 50_000_000_000_000n // 0.00005 ETH
const AGENT_GAS_TOPUP = 200_000_000_000_000n // 0.0002 ETH

/**
 * Top up an agent's EOA — METERED, because this is the operator's money.
 *
 * **This used to be unconditional, and the reason given was false.**
 * `sendAgentCall` returned early for EOA mode saying "the gas lands on the
 * agent's own balance, so there is nothing of the operator's to meter". But the
 * agent's balance is where it lands only because THIS FUNCTION PUT IT THERE,
 * out of the oracle wallet. There was plenty to meter and none of it was
 * metered: no budget, no ledger, no cap, on the path that is live whenever
 * ZERODEV_RPC is unset — which is the default.
 *
 * The attack is a sentence long: create agents, cause one send each, and every
 * one draws 0.0002 ETH from the oracle. Agent creation is rate-limited
 * (MAX_AGENTS_PER_ACCOUNT, REGISTER_HOURLY_MAX_USERS) but not free-limited, and
 * the drain has no ceiling of its own.
 *
 * What makes it worse than the money: on the one-key deployment this project
 * chose, the oracle IS the arbiter. An oracle with no ETH cannot call
 * `resolveDispute`, so draining gas takes the market's only judge offline —
 * the same shape as the keeper-lane reserve in lib/gas-budget.ts, which exists
 * precisely so a gas attack cannot disable settlement.
 *
 * So it goes through the same fuse as every other sponsored call, with the same
 * two lanes. Exhaustion here cannot "degrade to self-pay" — an agent with no
 * ether has nothing to pay with — so it simply does not top up, and the send
 * that follows fails on its own terms. That is the honest outcome: the
 * operator's subsidy has a limit, and reaching it is not the same as the
 * market being broken.
 */
async function ensureAgentGas(address: Address, agentId: string, lane: 'user' | 'keeper'): Promise<void> {
  const client = publicClient()
  const balance = await client.getBalance({ address })
  if (balance >= AGENT_GAS_FLOOR) return

  const { decideSponsorship, gasSpentInWindow, gasSpentTotal, recordGasSpend, AGENT_TOPUP_COST_USD } = await import(
    '@/lib/gas-budget'
  )
  const spent = await gasSpentInWindow(lane, agentId)
  const grantSpent = await gasSpentTotal()
  const verdict = decideSponsorship({
    lane,
    agentSpentUsd: spent.agent,
    laneSpentUsd: spent.lane,
    // Undefined, not zero, when the total could not be read — zero would mean
    // "the grant is untouched", which is the answer that spends it.
    grantSpentUsd: grantSpent ?? undefined,
    // There is no self-pay for a top-up: the whole point is that this account
    // has no ether. `sponsor` or nothing.
    canSelfPay: false,
  })
  if (verdict.decision !== 'sponsor') {
    console.error(`[agent-gas] not topping up ${agentId}: ${verdict.reason}`)
    return
  }

  // Recorded BEFORE the send, like every other spend in this file: a top-up
  // that lands and is not recorded is one the budget will hand out again. And
  // recorded at the TOP-UP price, not a UserOp's — this is roughly sixty times
  // the smaller unit, and a ledger that prices every spend at the cheapest one
  // agrees with itself rather than with the bank.
  await recordGasSpend(lane, agentId, 'eoa-topup', AGENT_TOPUP_COST_USD)
  const hash = await oracleWallet().sendTransaction({ to: address, value: AGENT_GAS_TOPUP })
  await client.waitForTransactionReceipt({ hash })
}

async function sendEoaCall(
  agentId: string,
  call: { to: Address; data: Hex; value?: bigint },
  lane: 'user' | 'keeper' = 'user',
): Promise<Hex> {
  const account = agentEoaAccount(agentId)
  await ensureAgentGas(account.address, agentId, lane)
  const wallet = createWalletClient({ account, chain: CHAIN, transport: chainTransport() })
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
/**
 * Build the Kernel account + client for one agent.
 *
 * `sponsored: false` omits the paymaster, so the UserOp is paid for out of the
 * KERNEL ACCOUNT's own ETH. That is what kernel-mode self-pay has to be: the
 * account that acts is the account that pays, so identity is preserved. Sending
 * from the agent's EOA instead — which is what "self-pay" meant before — swaps
 * the sender for an account holding none of the agent's tokens, and the call
 * fails on `NotWorker` or an allowance rather than on a budget.
 *
 * An unsponsored op also skips `requireSponsoredOp`, and must: that meter exists
 * to bound the operator's sponsored spend, and an op the operator is not paying
 * for is not part of what it bounds. Charging it there would make exhaustion
 * permanent — the fallback would be metered by the thing it is the fallback for.
 *
 * The nonce serialization stays in both cases. It is a property of the ACCOUNT,
 * not of who pays: two concurrent ops from one smart account collide on nonce
 * (AA25) regardless of funding.
 */
export async function getAgentKernel(agentId: string, opts: { sponsored?: boolean } = {}) {
  const sponsored = opts.sponsored ?? true
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

  const kernelClient = createKernelAccountClient({
    account,
    chain: CHAIN,
    bundlerTransport: http(onchainEnv.bundlerRpc),
    client,
    // Whichever paymaster this deployment is configured for — ZeroDev's, an
    // ERC-7677 endpoint like CDP's, or none. The bundler above is unaffected;
    // the two were only ever coupled by sharing a URL.
    ...(sponsored ? (() => { const pm = paymasterClient(); return pm ? { paymaster: pm } : {} })() : {}),
    /**
     * Fees from the chain when the bundler is not ZeroDev's.
     *
     * The SDK's default estimator calls `zd_getUserOperationGasPrice`, which is
     * a ZeroDev extension rather than ERC-4337, so CDP answers `request denied`
     * — the failure the first real mainnet posting hit, from inside a client
     * that looked vendor-neutral because every URL had been made so. viem's
     * own estimate is what any standard bundler expects.
     */
    ...(bundlerDialect() === 'standard'
      ? {
          /**
           * An empty object rather than nothing.
           *
           * viem puts `context` in the fourth position of
           * `pm_getPaymasterStubData` and leaves it `undefined` unless told
           * otherwise, which serialises to `null` inside the params array. CDP
           * answers `Missing or invalid parameters`. ERC-7677 describes context
           * as an optional OBJECT, so `{}` is the empty case spelled the way
           * the spec spells it.
           */
          paymasterContext: {},
          userOperation: {
            estimateFeesPerGas: async () => {
              const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas()
              return { maxFeePerGas, maxPriorityFeePerGas }
            },
          },
        }
      : {}),
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
    // Only when the operator is paying. An unsponsored op is the self-pay
    // fallback, and metering it with the sponsored budget would make exhaustion
    // permanent: the escape hatch would be gated by the thing it escapes.
    if (sponsored) {
      const { requireSponsoredOp } = await import('./gas-meter')
      await requireSponsoredOp(agentId)
    }

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
  opts: { lane?: 'user' | 'keeper'; label?: string } = {},
): Promise<Hex> {
  return sendAgentCalls(agentId, [call], opts)
}

/**
 * Send one OR MORE calls from the agent's account.
 *
 * Two writes needed a batch — `approve` then `postJob`, `approve` then
 * `acceptJob` — and both reached for `getAgentKernel` + `sendUserOperation`
 * directly because `sendAgentCall` took a single call. That made posting a job
 * and accepting a job the only two labour-market writes that were **kernel
 * only**. On an EOA-mode deployment there is no bundler and no paymaster, so
 * both were structurally impossible while submit, approve, dispute, withdraw
 * and every transfer worked — which reads exactly like "posting is broken and
 * mining is broken" and nothing else.
 *
 * They also bypassed the gas fuse completely: no `decideSponsorship`, no
 * `recordGasSpend`. Two of the most expensive operations in the system were
 * the two the budget could not see.
 *
 * In kernel mode the calls land as one atomic UserOp, as before. In EOA mode
 * there is nothing to batch with, so they are sent in order. That is NOT
 * atomic, and the ordering is what makes it safe: the approve is for exactly
 * the amount the following call spends, so a failure in between leaves a
 * dangling allowance to this market — recoverable, and never lost funds.
 */
export async function sendAgentCalls(
  agentId: string,
  calls: { to: Address; data: Hex; value?: bigint }[],
  opts: { lane?: 'user' | 'keeper'; label?: string } = {},
): Promise<Hex> {
  if (calls.length === 0) throw new Error('sendAgentCalls: nothing to send')

  /**
   * Sequentially, returning the hash of the LAST call — the one that carries the
   * meaning. An approve's hash is of no interest to any caller.
   *
   * Every call after the first is RETRIED, because a sequential batch on a
   * load-balanced RPC has a race an atomic UserOp does not. `sendEoaCall` waits
   * for the approve's receipt, so the approve is genuinely mined — but the next
   * request may be routed to a different node that has not yet seen that block.
   * It reads the allowance as still zero and the gas estimate reverts.
   *
   * Observed exactly once and then unreproducible: `postJob` reverted with the
   * allowance already correctly set to `postCost` on chain, and the identical
   * call simulated fine a minute later. A retry converges as soon as the node
   * catches up, and a GENUINE revert still fails — just after a few seconds
   * more, with the same error. That is the right trade: this cannot turn a real
   * revert into a success, only a propagation lag into one.
   *
   * Not a substitute for a dedicated RPC endpoint, which is the actual fix for
   * read-after-write consistency.
   */
  const sendSequentially = async (lane: 'user' | 'keeper'): Promise<Hex> => {
    let hash: Hex | undefined
    for (const [i, c] of calls.entries()) {
      // The first call depends on no earlier call in this batch, so a revert
      // there is always real and must surface immediately.
      const attempts = i === 0 ? 1 : 3
      for (let attempt = 1; ; attempt++) {
        try {
          hash = await sendEoaCall(agentId, c, lane)
          break
        } catch (error) {
          if (attempt >= attempts) throw error
          const delay = 2000 * attempt
          console.warn(
            `[onchain] call ${i + 1}/${calls.length} of ${opts.label ?? 'batch'} failed on attempt ` +
              `${attempt} — retrying in ${delay}ms in case the preceding call has not propagated: ` +
              `${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
          )
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    return hash as Hex
  }

  // EOA mode still spends the operator's money — `ensureAgentGas` refills the
  // agent out of the ORACLE wallet — so the lane is threaded through and the
  // top-up is metered by the same fuse. The comment that used to sit here said
  // there was nothing of the operator's to meter, which was the opposite of
  // true and left this path uncapped.
  if (agentAccountMode === 'eoa') return sendSequentially(opts.lane ?? 'user')

  // The fuse. Sponsored gas is the one pool an attacker drains without paying
  // anything, so exhaustion has to have an answer that is not "the market is
  // down" — see lib/gas-budget.ts. Keeper traffic draws on a reserve user
  // traffic cannot touch, because a single pool would let a gas attack disable
  // the permissionless exits that free OTHER people's escrow.
  const lane = opts.lane ?? 'user'
  const { decideSponsorship, gasSpentInWindow, gasSpentTotal, recordGasSpend, PAYMASTER_DISABLED } = await import('@/lib/gas-budget')
  const spent = await gasSpentInWindow(lane, agentId)
  const grantSpent = await gasSpentTotal()
  const verdict = decideSponsorship({
    lane,
    agentSpentUsd: spent.agent,
    laneSpentUsd: spent.lane,
    grantSpentUsd: grantSpent ?? undefined,
    // Kernel mode CAN self-pay — but from the kernel account, not the EOA.
    //
    // This was false for a while, and the reason it was false is still true: the
    // EOA is a different account holding none of the agent's tokens, so sending
    // from it changes WHICH ACCOUNT ACTS rather than who pays gas, and the call
    // fails on `NotWorker` or an allowance with nothing naming a budget.
    //
    // The answer is not to route elsewhere, it is to drop the PAYMASTER: an
    // unsponsored UserOp from the same kernel account, funded by that account's
    // own ETH. Identity preserved, operator no longer paying — which is exactly
    // what "self-pay" is supposed to mean.
    //
    // Only for the user lane. The keeper reserve exists so the permissionless
    // exits keep freeing other people's escrow when the user lane is drained; if
    // keeper ops fell back to agent ETH, a drained reserve would silently become
    // the agents' problem instead of surfacing as the operator's.
    //
    // That reasoning is about a reserve that RAN OUT. With no paymaster there is
    // no reserve to drain and nothing being hidden — refusing keeper work would
    // just stop the permissionless exits outright, which is the failure the two
    // lanes exist to prevent. So in that mode the keeper self-pays too.
    canSelfPay: PAYMASTER_DISABLED || lane === 'user',
  })

  if (verdict.decision === 'refuse') {
    throw new Error(`gas sponsorship refused: ${verdict.reason}`)
  }
  const sponsored = verdict.decision === 'sponsor'
  if (sponsored) {
    // Recorded BEFORE the send. An op that lands and is never billed is how a
    // budget silently stops bounding anything; an op billed and then rejected
    // only over-counts, which errs toward degrading sooner.
    await recordGasSpend(lane, agentId, opts.label ?? 'agent call')
  } else {
    console.warn(`[onchain] ${verdict.reason} — agent ${agentId} self-paying from its kernel account`)
  }

  const { account, kernelClient, address } = await getAgentKernel(agentId, { sponsored })

  // Self-pay needs the KERNEL account to hold ETH, and nothing tops it up.
  //
  // `ensureAgentGas` cannot: it spends the ORACLE's ether and is gated by this
  // same budget, so it would refuse precisely when self-pay is needed — and if it
  // did not, "self-pay" would be operator-funded, which is sponsorship with
  // another name and would make the budget unenforceable.
  //
  // So the account either has a float or it does not, and the difference has to
  // be said out loud. Checked here rather than left to the bundler, whose answer
  // to an underfunded sender is an AA21 nobody reads as "fund this address".
  if (!sponsored) {
    let balance = await publicClient().getBalance({ address })
    if (balance < AGENT_GAS_FLOOR) {
      // Before giving up: the OWNER may have filled a pool of their own.
      //
      // This is the kernel-mode counterpart of `ensureAgentGas`, and the
      // distinction it turns on is whose money moves. That function spends the
      // OPERATOR's ether, which is why it is gated by the budget above and
      // why it would refuse exactly here. lib/local-paymaster.ts spends the
      // account's own, from an agent its owner designated on purpose, so this
      // budget has no claim on it — and a full ERC-4337 paymaster, which this
      // deployment has no EntryPoint deposit for, is not needed to move ether
      // between two wallets one person controls.
      //
      // Never fatal and never load-bearing: it returns a reason instead of
      // throwing, and the balance is re-read rather than assumed, so a refusal
      // or a lagging node falls through to exactly the error below.
      const { sponsorAgentGas } = await import('@/lib/local-paymaster')
      const outcome = await sponsorAgentGas(agentId)
      if (outcome.sponsored) balance = await publicClient().getBalance({ address })
    }
    if (balance < AGENT_GAS_FLOOR) {
      throw new Error(
        `${verdict.reason}, and the agent cannot self-pay: kernel account ${address} holds ` +
          `${balance} wei, under the ${AGENT_GAS_FLOOR} floor. Either send it a little ETH so it can ` +
          `fund its own operations, set a gas pool on this account so its own agents top each other ` +
          `up (fund_agent_eth / set_gas_pool), or raise AGENT_GAS_BUDGET_USD / ` +
          `USER_LANE_GAS_BUDGET_USD. Sponsored gas is the operator's money and this budget is what ` +
          `bounds it, so it is not topped up automatically here.`,
      )
    }
  }
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(
      calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })),
    ),
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
