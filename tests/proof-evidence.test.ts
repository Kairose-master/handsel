import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import {
  DOMAIN,
  TYPES,
  TYPES_V2,
  EVIDENCE_SCHEMA,
  WORK_PROOF_SCHEMA,
  WORK_PROOF_SCHEMA_V2,
  canonicalJson,
  contentHashOf,
  evidenceHashOf,
  evidenceProblem,
  signWorkProof,
  typesFor,
  verifyWorkProof,
  type EvidenceBundle,
  type WorkProof,
} from '@/lib/attestation'
import { GET as attestationRecipe } from '@/app/api/attestation/route'

/**
 * Proof v2 — "recomputation now", made checkable.
 *
 * v1 proved provenance: the oracle signed a verdict about a contentHash. v2
 * binds the JUDGMENT INPUTS into the same signature: an evidenceHash over the
 * canonical bundle of { spec, deliverable, grader, graderClass }. These tests
 * pin the three properties that make that worth anything:
 *
 *   1. Nothing in the bundle can be swapped after signing — not the spec, not
 *      the deliverable, not the grader class (an opinion cannot be quietly
 *      relabelled as a computation).
 *   2. Every already-issued v1 proof verifies exactly as before. A schema
 *      that breaks old signatures is not a version, it is a repudiation.
 *   3. The canonical form is deterministic — two independent implementations
 *      serializing the same bundle reach the same hash, or the whole scheme
 *      is an interop trap.
 */

const oracle = privateKeyToAccount(`0x${'1'.repeat(64)}`)

const bundle = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  schema: EVIDENCE_SCHEMA,
  spec: 'The function must return 42 for input 6*7.',
  deliverable: { text: 'export const answer = () => 42' },
  grader: 'llm-review',
  graderClass: 'model',
  ...over,
})

const v2Proof = (evidence: EvidenceBundle, over: Partial<WorkProof> = {}): WorkProof => ({
  schema: WORK_PROOF_SCHEMA_V2,
  jobRef: 'task-9',
  kind: 'text',
  contentHash: contentHashOf(evidence.deliverable),
  worker: 'agent-w',
  requester: 'agent-r',
  verdict: 'pass',
  grader: evidence.grader,
  gradedAt: 1_800_000_000,
  evidenceHash: evidenceHashOf(evidence),
  ...over,
})

describe('canonical JSON — the interop surface', () => {
  it('is key-order independent', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 })
    expect(a).toBe(b)
  })

  it('drops undefined but keeps null — absent and unknown stay distinguishable', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('pins the exact serialization, because a "roughly equal" canonical form is none', () => {
    expect(canonicalJson({ z: 1, a: 'x' })).toBe('{"a":"x","z":1}')
    expect(canonicalJson([1, 'two', null])).toBe('[1,"two",null]')
  })

  it('same bundle → same hash; any field changed → different hash', () => {
    expect(evidenceHashOf(bundle())).toBe(evidenceHashOf(bundle()))
    expect(evidenceHashOf(bundle({ spec: 'must return 43' }))).not.toBe(evidenceHashOf(bundle()))
    expect(evidenceHashOf(bundle({ graderClass: 'mechanical' }))).not.toBe(evidenceHashOf(bundle()))
  })
})

describe('v2 signing binds the evidence', () => {
  it('signs and verifies with the v2 recipe, selected by the schema inside the proof', async () => {
    const ev = bundle()
    const proof = v2Proof(ev)
    const signed = await signWorkProof(proof, oracle)
    expect(signed).not.toBeNull()

    expect(typesFor(proof.schema)).toBe(TYPES_V2)
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES_V2,
      primaryType: 'WorkProof',
      message: { ...proof, gradedAt: BigInt(proof.gradedAt), evidenceHash: proof.evidenceHash! },
      signature: signed!.signature,
    })
    expect(recovered.toLowerCase()).toBe(oracle.address.toLowerCase())
  })

  it('a swapped spec no longer matches the signed evidenceHash', () => {
    const ev = bundle()
    const proof = v2Proof(ev)
    const swapped = bundle({ spec: 'The function may return anything.' })
    expect(evidenceProblem(swapped, proof)).toMatch(/does not hash to the signed evidenceHash/)
    expect(evidenceProblem(ev, proof)).toBeNull()
  })

  it('a swapped deliverable fails BOTH commitments', () => {
    const ev = bundle()
    const proof = v2Proof(ev)
    const swapped = bundle({ deliverable: { text: 'export const answer = () => 41' } })
    // evidenceHash breaks first; even if an attacker recomputed it, contentHash
    // is signed separately, so the deliverable is pinned twice.
    expect(evidenceProblem(swapped, proof)).not.toBeNull()
    const proofWithSwappedEvidenceHash = { ...proof, evidenceHash: evidenceHashOf(swapped) }
    expect(evidenceProblem(swapped, proofWithSwappedEvidenceHash)).toMatch(/contentHash/)
  })

  it('an opinion cannot be relabelled as a computation after signing', () => {
    const ev = bundle({ graderClass: 'model' })
    const proof = v2Proof(ev)
    const relabelled = bundle({ graderClass: 'mechanical' })
    expect(evidenceProblem(relabelled, proof)).toMatch(/does not hash/)
  })

  it('tampering the evidenceHash inside the proof breaks the signature itself', async () => {
    const ev = bundle()
    const proof = v2Proof(ev)
    const signed = await signWorkProof(proof, oracle)
    const tampered = { ...proof, evidenceHash: evidenceHashOf(bundle({ spec: 'anything goes' })) }
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES_V2,
      primaryType: 'WorkProof',
      message: { ...tampered, gradedAt: BigInt(tampered.gradedAt) },
      signature: signed!.signature,
    })
    expect(recovered.toLowerCase()).not.toBe(oracle.address.toLowerCase())
  })
})

describe('v1 is untouched — old signatures must verify forever', () => {
  const v1Proof: WorkProof = {
    schema: WORK_PROOF_SCHEMA,
    jobRef: 'job-123',
    kind: 'code',
    contentHash: `0x${'a'.repeat(64)}`,
    worker: 'agent-w',
    requester: 'agent-r',
    verdict: 'pass',
    grader: 'pytest',
    gradedAt: 1_800_000_000,
  }

  it('v1 proofs still select the v1 recipe and verify', async () => {
    expect(typesFor(v1Proof.schema)).toBe(TYPES)
    const signed = await signWorkProof(v1Proof, oracle)
    const ok = await verifyWorkProof(v1Proof, signed!.signature, oracle.address)
    expect(ok.valid).toBe(true)
  })

  it('a v1 proof cannot claim evidence', () => {
    expect(evidenceProblem(bundle(), v1Proof)).toMatch(/carries no evidence commitment/)
  })
})

describe('the published recipe covers both schemas', () => {
  it('serves per-schema recipes derived from the same constants the signer uses', async () => {
    const body = await (await attestationRecipe()).json()
    expect(body.schemas[WORK_PROOF_SCHEMA].types).toEqual(TYPES)
    expect(body.schemas[WORK_PROOF_SCHEMA_V2].types).toEqual(TYPES_V2)
    // Legacy consumers built against body.eip712 keep working: it stays v1.
    expect(body.eip712.types).toEqual(TYPES)
  })

  it('names the grader classes and is honest that model-class re-runs yield an opinion', async () => {
    const body = await (await attestationRecipe()).json()
    expect(body.evidence.schema).toBe(EVIDENCE_SCHEMA)
    expect(body.evidence.graderClasses.model).toMatch(/opinion/i)
    expect(body.evidence.graderClasses.reproducible).toMatch(/same verdict/i)
  })
})
