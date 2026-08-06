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
export const WORK_PROOF_SCHEMA_V2 = 'handsel.work.v2'
export const EVIDENCE_SCHEMA = 'handsel.evidence.v1'

/** The canonical, signable body of a work proof. Strings keep it flexible
 *  (worker/requester may be a smart-account address or an internal agentId).
 *  `evidenceHash` exists only on v2 proofs: the keccak256 of the canonical
 *  evidence bundle (spec + deliverable + grader class), which is what turns a
 *  proof from provenance-only into something a third party can re-run. */
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
  evidenceHash?: Hex
}

/** Everything a third party needs to re-derive the verdict themselves: the
 *  spec the deliverable was judged against, the deliverable itself, and which
 *  CLASS of grader produced the verdict — because what "re-run" means depends
 *  on it: `mechanical`/`reproducible` re-runs to the same answer; `model`
 *  re-runs to an independent opinion (you re-judge with your own model). The
 *  class lives inside the hash so nobody can quietly relabel an opinion as a
 *  computation after the fact. */
export interface EvidenceBundle {
  schema: string
  spec: string
  deliverable: { text?: string | null; base64?: string | null }
  grader: string
  graderClass: 'reproducible' | 'mechanical' | 'model'
}

/** EIP-712 domain and types, exported so `/api/attestation` publishes the exact
 *  recipe a third party needs to verify a proof locally — one source of truth,
 *  never a copy that could drift from what the oracle actually signs (§26). */
export const DOMAIN = { name: 'Handsel', version: '1', chainId: CHAIN.id } as const
export const TYPES = {
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

/** v2 = v1 + evidenceHash. A NEW type rather than a change to TYPES: every
 *  already-issued v1 signature must keep verifying against the exact recipe it
 *  was signed under, forever. Schema strings select the recipe. */
export const TYPES_V2 = {
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
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const

/** The recipe is selected by the proof's own schema field — which is itself
 *  inside the signature, so a proof cannot lie about which recipe verifies it. */
export function typesFor(schema: string) {
  return schema === WORK_PROOF_SCHEMA_V2 ? TYPES_V2 : TYPES
}

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

/** Deterministic JSON: object keys sorted recursively, no whitespace. Two
 *  parties serializing the same bundle MUST get identical bytes, or the
 *  evidence hash is useless — so the canonical form is pinned here and in
 *  `tests/proof-evidence.test.ts`, not left to JSON.stringify key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** keccak256 over the canonical bytes of the evidence bundle. This is the
 *  bytes32 a v2 proof signs — binding spec, deliverable AND grader class into
 *  the signature, so none of them can be swapped after issuance. */
export function evidenceHashOf(bundle: EvidenceBundle): Hex {
  return keccak256(Buffer.from(canonicalJson(bundle), 'utf8'))
}

/** A third party's evidence check, pure and local: does this bundle actually
 *  hash to what the signed proof committed to — and does the deliverable in
 *  the bundle match the proof's contentHash? Returns null when sound, else the
 *  first reason it is not. Verifying the SIGNATURE is verifyWorkProof's job;
 *  this verifies that the evidence being shown is the evidence that was signed. */
export function evidenceProblem(bundle: EvidenceBundle, proof: WorkProof): string | null {
  if (proof.schema !== WORK_PROOF_SCHEMA_V2) return `proof schema ${proof.schema} carries no evidence commitment`
  if (!proof.evidenceHash) return 'v2 proof missing evidenceHash'
  if (bundle.schema !== EVIDENCE_SCHEMA) return `unknown evidence schema ${bundle.schema}`
  if (evidenceHashOf(bundle) !== proof.evidenceHash) return 'evidence bundle does not hash to the signed evidenceHash'
  if (contentHashOf(bundle.deliverable) !== proof.contentHash) {
    return 'deliverable in evidence does not match the signed contentHash'
  }
  return null
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
  const signature = await signer.signTypedData({
    domain: DOMAIN,
    types: typesFor(proof.schema),
    primaryType: 'WorkProof',
    message: toMessage(proof),
  })
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
    types: typesFor(proof.schema),
    primaryType: 'WorkProof',
    message: toMessage(proof),
    signature,
  })
  const trust = (expectedAttester ?? trustedAttester())?.toLowerCase()
  const trusted = !!trust && recovered.toLowerCase() === trust
  return { valid: trusted, recovered, trusted }
}
