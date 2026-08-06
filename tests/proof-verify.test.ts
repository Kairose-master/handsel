import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import { DOMAIN, TYPES, WORK_PROOF_SCHEMA, signWorkProof, verifyWorkProof, type WorkProof } from '@/lib/attestation'
import { GET as attestationRecipe } from '@/app/api/attestation/route'

/**
 * A proof is only "consumable by a partner" if the partner can verify it WITHOUT
 * trusting us. These tests are that claim, made checkable: they reconstruct the
 * third party's own verification — recover the EIP-712 signer locally from the
 * published recipe — and assert it matches, and that tampering breaks it.
 *
 * If this ever passes while the published recipe has drifted from what the oracle
 * signs, a verifier following our docs would reject genuine proofs. So the recipe
 * endpoint is checked against the same DOMAIN/TYPES the signer uses — one source.
 */

const sampleProof = (over: Partial<WorkProof> = {}): WorkProof => ({
  schema: WORK_PROOF_SCHEMA,
  jobRef: 'job-123',
  kind: 'code',
  contentHash: '0x'.padEnd(66, 'a') as `0x${string}`,
  worker: 'agent-w',
  requester: 'agent-r',
  verdict: 'pass',
  grader: 'pytest',
  gradedAt: 1_800_000_000,
  ...over,
})

describe('a third party verifies a Handsel proof without trusting Handsel', () => {
  // A throwaway key stands in for the oracle — the test never needs the real one,
  // which is the point: verification is pure signature math over public inputs.
  const oracle = privateKeyToAccount(`0x${'1'.repeat(64)}`)

  it('recovers the signer locally from the published recipe', async () => {
    const proof = sampleProof()
    const signed = await signWorkProof(proof, oracle)
    expect(signed).not.toBeNull()

    // Exactly what a partner would run — no Handsel call, just viem over the
    // recipe we publish. `gradedAt` is uint256, so it goes in as a bigint.
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: 'WorkProof',
      message: { ...proof, gradedAt: BigInt(proof.gradedAt) },
      signature: signed!.signature,
    })
    expect(recovered.toLowerCase()).toBe(oracle.address.toLowerCase())
  })

  it('rejects a tampered proof — the verdict cannot be flipped after signing', async () => {
    const proof = sampleProof({ verdict: 'pass' })
    const signed = await signWorkProof(proof, oracle)

    // Attacker flips the verdict but keeps the signature.
    const tampered = { ...proof, verdict: 'fail' }
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: 'WorkProof',
      message: { ...tampered, gradedAt: BigInt(tampered.gradedAt) },
      signature: signed!.signature,
    })
    // Recovery still "succeeds" but yields a DIFFERENT address, so the compare
    // against the trusted attester fails. That is the whole security model.
    expect(recovered.toLowerCase()).not.toBe(oracle.address.toLowerCase())
  })

  it('verifyWorkProof agrees, and is explicit about the trusted address', async () => {
    const proof = sampleProof()
    const signed = await signWorkProof(proof, oracle)
    const ok = await verifyWorkProof(proof, signed!.signature, oracle.address)
    expect(ok.valid).toBe(true)
    expect(ok.recovered.toLowerCase()).toBe(oracle.address.toLowerCase())

    const wrong = await verifyWorkProof(proof, signed!.signature, privateKeyToAccount(`0x${'2'.repeat(64)}`).address)
    expect(wrong.valid).toBe(false) // recovered fine, but not the expected attester
  })
})

describe('the published recipe matches what the oracle actually signs', () => {
  it('serves the same domain, types and primaryType, derived not hardcoded', async () => {
    const res = await attestationRecipe()
    const body = await res.json()

    expect(body.schema).toBe(WORK_PROOF_SCHEMA)
    expect(body.eip712.primaryType).toBe('WorkProof')
    // The recipe MUST equal the signer's own constants — a drift here sends every
    // verifier checking against the wrong hash (§26's shape, one endpoint over).
    expect(body.eip712.domain).toEqual(DOMAIN)
    expect(body.eip712.types).toEqual(TYPES)
  })

  it('is honest that it proves provenance, not the verdict', async () => {
    const body = await (await attestationRecipe()).json()
    expect(JSON.stringify(body).toLowerCase()).toContain('provenance')
    expect(body.verify.note).toMatch(/does NOT re-derive/i)
  })

  it('a null attester means "cannot verify here", never "any signer is fine"', async () => {
    // On a deployment with no oracle key, attester is null. A verifier must fail
    // closed. This pins that the endpoint reports null rather than omitting it,
    // so a consumer can tell the difference.
    const body = await (await attestationRecipe()).json()
    expect('attester' in body).toBe(true)
  })
})
