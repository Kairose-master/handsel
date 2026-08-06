import { DOMAIN, TYPES, WORK_PROOF_SCHEMA, trustedAttester } from '@/lib/attestation'

/**
 * GET /api/attestation — the recipe for verifying a Handsel work proof WITHOUT
 * trusting Handsel.
 *
 * `/api/proof/verify` already recovers a signature, but it does the recovery on
 * our server and tells you the answer — so a consumer still trusts our word.
 * This endpoint closes that gap: it publishes the exact EIP-712 `domain`,
 * `types`, `primaryType`, and the canonical `attester` address, so anyone can
 * run `recoverTypedDataAddress` **in their own process** and compare, with zero
 * further calls to us. That is what makes a Handsel proof *consumable* by a
 * partner rather than something they have to take on faith — the interop lane in
 * `docs/external-grading.md`, made real.
 *
 * Everything here is DERIVED (attester from the oracle key, chainId from the
 * configured chain), never a hardcoded literal — the same rule §26 enforced for
 * the task feed. A stale published address would send verifiers checking against
 * the wrong key, which is worse than no recipe at all.
 *
 * ## What this verifies, and what it does not
 *
 * Recovering the signature proves **provenance**: the Handsel oracle signed
 * "this contentHash was graded with verdict V by grader G at time T". It is
 * non-repudiable — the oracle cannot later deny it. It does **not** re-derive
 * the verdict: it does not prove the work actually passes the test, only that we
 * said it did. Re-deriving the verdict is the recomputable lane
 * (`docs/external-grading.md`), which requires the proof to carry the test and
 * the deliverable; that is the named next step, not this.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const attester = trustedAttester()

  return Response.json({
    schema: WORK_PROOF_SCHEMA,
    // The address a genuine proof MUST recover to. Null when the oracle key is
    // not configured on this deployment — a verifier must treat null as "cannot
    // verify here", never as "any signer is fine".
    attester,
    // Cross-check this against the oracle's on-chain identity (it signs ERC-8004
    // validations) rather than trusting this endpoint alone — that is the trust
    // anchor that is not us.
    attesterIsOnchainOracle: true,
    // The full EIP-712 recipe. A verifier reconstructs the typed-data hash from
    // exactly these and recovers the signer locally.
    eip712: {
      primaryType: 'WorkProof',
      domain: DOMAIN,
      types: TYPES,
    },
    verify: {
      how: 'recoverTypedDataAddress({ domain, types, primaryType, message: proof, signature }) === attester',
      note:
        'Proves provenance (the oracle signed this verdict), which is non-repudiable. It does NOT re-derive ' +
        'the verdict — that the work actually passes — which is the recomputable lane, not this. See ' +
        'docs/verifying-proofs.md.',
      fetchProof: 'GET /api/proof/<id> returns { proof, signature, attester } for any issued proof.',
    },
  })
}
