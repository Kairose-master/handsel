/**
 * Proof of Authorship & Grade — off-chain, gas-free work attestations.
 *
 * Borrowed from two EAS patterns and fused for Handsel's core claim that a
 * deliverable "passed independent grading":
 *
 *  • Contents authenticity (파일 지문 + authorship): a deliverable is fingerprinted
 *    with keccak256 and stamped with who produced it. In an AI-generated /
 *    deepfake era the question is "who actually made this and is it verified?".
 *  • Reputation self-attestation defense: an attestation carries a `recipient`
 *    (the worker it is ABOUT) and an `attester` (who SIGNED it). A worker must
 *    not be able to forge its own "pass", so a verifier checks
 *    `attester == TRUSTED_SCORER` (here: the platform oracle).
 *
 * We take the EAS *off-chain* path the Contents lab recommends — the attester
 * signs (EIP-712), nothing is written on-chain, verification costs nothing —
 * so a proof ships the instant a job is graded, with zero gas and no schema
 * deployment. It can later be anchored on-chain via the same oracle key.
 */
import { keccak256, recoverTypedDataAddress, type Hex } from 'viem'
import type { Account } from 'viem'
import { CHAIN } from '@/lib/onchain/config'
import { oracleAccount } from '@/lib/onchain/clients'

export const WORK_PROOF_SCHEMA = 'handsel.work.v1'

/** The canonical, signable body of a work proof. Strings keep it flexible
 *  (worker/requester may be a smart-account address or an internal agentId). */
export interface WorkProof {
  schema: string
  jobRef: string
  kind: string
  contentHash: Hex
  worker: string
  requester: string
  verdict: string
  grader: string
  gradedAt: number
}

const DOMAIN = { name: 'Handsel', version: '1', chainId: CHAIN.id } as const
const TYPES = {
  WorkProof: [
    { name: 'schema', type: 'string' },
    { name: 'jobRef', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'worker', type: 'string' },
    { name: 'requester', type: 'string' },
    { name: 'verdict', type: 'string' },
    { name: 'grader', type: 'string' },
    { name: 'gradedAt', type: 'uint256' },
  ],
} as const

/** EIP-712 encodes the `gradedAt` uint256 as a bigint; the public WorkProof
 *  keeps it as a number for ergonomics, so convert at the signing boundary.
 *  Both sign and verify go through here, so the typed hash always matches. */
function toMessage(p: WorkProof) {
  return { ...p, gradedAt: BigInt(p.gradedAt) }
}

/** keccak256 fingerprint of the exact delivered bytes ("파일 지문"). */
export function computeContentHash(bytes: Uint8Array | Buffer): Hex {
  return keccak256(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

/** Fingerprint a base64 or data: payload (image/audio) or a UTF-8 string (text/code). */
export function contentHashOf(input: { base64?: string | null; dataUrl?: string | null; text?: string | null }): Hex {
  if (input.dataUrl) {
    const comma = input.dataUrl.indexOf(',')
    const b64 = comma >= 0 ? input.dataUrl.slice(comma + 1) : input.dataUrl
    return computeContentHash(Buffer.from(b64, 'base64'))
  }
  if (input.base64) return computeContentHash(Buffer.from(input.base64, 'base64'))
  return computeContentHash(Buffer.from(input.text ?? '', 'utf8'))
}

/** The address every verifier must trust — the platform oracle (attester). A
 *  proof only counts if it was signed by THIS key. Returns null if the oracle
 *  key is not configured. */
export function trustedAttester(): `0x${string}` | null {
  try {
    return oracleAccount().address
  } catch {
    return null
  }
}

/** Oracle signs the proof (EIP-712, off-chain, no gas). `account` is injectable
 *  for tests; defaults to the platform oracle. Returns null if unavailable. */
export async function signWorkProof(proof: WorkProof, account?: Account): Promise<{ signature: Hex; attester: `0x${string}` } | null> {
  let signer: Account
  try {
    signer = account ?? oracleAccount()
  } catch {
    return null
  }
  if (!signer.signTypedData) return null
  const signature = await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'WorkProof', message: toMessage(proof) })
  return { signature, attester: signer.address }
}

/** Recover the signer and check it against the trusted attester. This is the
 *  self-attestation defense: a worker's own signature over "I passed" fails
 *  because it does not recover to the oracle address. */
export async function verifyWorkProof(
  proof: WorkProof,
  signature: Hex,
  expectedAttester?: `0x${string}`,
): Promise<{ valid: boolean; recovered: `0x${string}`; trusted: boolean }> {
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: TYPES,
    primaryType: 'WorkProof',
    message: toMessage(proof),
    signature,
  })
  const trust = (expectedAttester ?? trustedAttester())?.toLowerCase()
  const trusted = !!trust && recovered.toLowerCase() === trust
  return { valid: trusted, recovered, trusted }
}
