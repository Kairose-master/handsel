/**
 * ERC-8004 ("Trustless Agents") integration — Phase B of
 * docs/erc8004-acp-benchmark.md.
 *
 * Handsel publishes into the standard's registries so its signals are
 * portable and composable outside this app:
 *  - Identity:   each agent registers ITSELF (its own account signs, so
 *    registry owner == agent address) pointing at /api/agents/:id/card.
 *  - Validation: every graded FACT (acceptance tests, Proving Ground) is
 *    published as a request (from the agent) + response (from the oracle
 *    as validator, 0 or 100).
 *  - Reputation: every credit recalculation is published as oracle
 *    feedback (tag1 "credit-score"). The registry itself rejects feedback
 *    from the agent's owner — grader ≠ solver, enforced on-chain.
 *
 * All of it is best-effort mirroring, same convention as EAS attestation:
 * the DB ledger stays authoritative; a registry failure never blocks the
 * underlying action.
 */
import { encodeFunctionData, keccak256, parseEventLogs, toHex, type Address } from 'viem'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { onchainEnv } from './config'
import { publicClient, oracleWallet, oracleAccount } from './clients'
import { sendAgentCall } from './account'

export const erc8004Env = {
  identity: (process.env.ERC8004_IDENTITY_ADDRESS ?? '') as Address | '',
  reputation: (process.env.ERC8004_REPUTATION_ADDRESS ?? '') as Address | '',
  validation: (process.env.ERC8004_VALIDATION_ADDRESS ?? '') as Address | '',
}

export function isErc8004Configured(): boolean {
  return Boolean(erc8004Env.identity && erc8004Env.reputation && erc8004Env.validation)
}

const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'uri', type: 'string' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const

const REPUTATION_ABI = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

const VALIDATION_ABI = [
  {
    type: 'function',
    name: 'validationRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'validationResponse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },
] as const

/** Register an agent in the Identity Registry (the agent's own account
 *  signs) and persist the assigned ERC-8004 id. Idempotent per agent. */
export async function registerAgentErc8004(agentId: string, cardUrl: string): Promise<number | null> {
  if (!isErc8004Configured()) return null
  const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!row) return null
  if (row.erc8004Id) return row.erc8004Id

  const txHash = await sendAgentCall(agentId, {
    to: erc8004Env.identity as Address,
    data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [cardUrl] }),
  })

  const receipt = await publicClient().getTransactionReceipt({ hash: txHash })
  const [registered] = parseEventLogs({ abi: IDENTITY_ABI, eventName: 'Registered', logs: receipt.logs })
  const erc8004Id = registered ? Number(registered.args.agentId) : null
  if (erc8004Id) {
    await db.update(agent).set({ erc8004Id }).where(eq(agent.id, agentId))
  }
  return erc8004Id
}

/** Oracle publishes a credit recalculation into the Reputation Registry.
 *  Best-effort mirror — never throws to the caller. */
export async function publishCreditFeedback(agentId: string, score: number, rating: string): Promise<void> {
  try {
    if (!isErc8004Configured() || !onchainEnv.oraclePrivateKey) return
    const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
    if (!row?.erc8004Id) return

    await oracleWallet().writeContract({
      address: erc8004Env.reputation as Address,
      abi: REPUTATION_ABI,
      functionName: 'giveFeedback',
      args: [BigInt(row.erc8004Id), BigInt(Math.round(score)), 0, 'credit-score', rating, '', '', `0x${'0'.repeat(64)}`],
    })
  } catch (error) {
    console.error('[erc8004] credit feedback publish failed:', error)
  }
}

/** Publish a graded fact as a Validation request (agent-signed) +
 *  response (oracle-as-validator). `verdict` is 0–100; `ref` is any
 *  stable identifier of the graded work (job id, task id). Best-effort. */
export async function publishValidation(
  agentId: string,
  verdict: number,
  tag: string,
  ref: string,
): Promise<void> {
  try {
    if (!isErc8004Configured() || !onchainEnv.oraclePrivateKey) return
    const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
    if (!row?.erc8004Id) return

    const requestHash = keccak256(toHex(`${agentId}:${tag}:${ref}`))

    await sendAgentCall(agentId, {
      to: erc8004Env.validation as Address,
      data: encodeFunctionData({
        abi: VALIDATION_ABI,
        functionName: 'validationRequest',
        args: [oracleAccount().address, BigInt(row.erc8004Id), '', requestHash],
      }),
    })

    await oracleWallet().writeContract({
      address: erc8004Env.validation as Address,
      abi: VALIDATION_ABI,
      functionName: 'validationResponse',
      args: [requestHash, Math.max(0, Math.min(100, Math.round(verdict))), '', `0x${'0'.repeat(64)}`, tag],
    })
  } catch (error) {
    console.error('[erc8004] validation publish failed:', error)
  }
}
