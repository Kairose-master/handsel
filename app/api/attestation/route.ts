import { DOMAIN, TYPES, TYPES_V2, EVIDENCE_SCHEMA, WORK_PROOF_SCHEMA, WORK_PROOF_SCHEMA_V2, trustedAttester } from '@/lib/attestation'
import { getAddress } from 'viem'
import { CHAIN, onchainEnv } from '@/lib/onchain/config'

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
    // Cross-check this against the oracle's on-chain identity rather than
    // trusting this endpoint alone — that is the trust anchor that is not us.
    attesterIsOnchainOracle: true,
    // WHERE to cross-check it, machine-readably, because "verify it on-chain"
    // is not an instruction anyone can follow. `AgentCreditRegistry.oracle()`
    // is a view function on a deployed contract: the same address this
    // endpoint returns as `attester`, readable from any Base RPC with no call
    // to us. A verifier pins from here once and is thereafter checking against
    // a fact no Handsel endpoint can change.
    //
    // Both values are DERIVED from the same config the server signs with —
    // never a literal — so this cannot drift into pointing a verifier at the
    // wrong contract (§26, and docs/failure-modes.md §41 for the version of
    // this that was wrong).
    attesterAnchor: onchainEnv.registryAddress
      ? {
          chainId: CHAIN.id,
          chain: CHAIN.name,
          // Checksummed, because `expect` is: publishing one address in
          // lowercase and the other in EIP-55 invites a verifier to compare
          // them as strings and get a false negative (invariant 18 — an
          // address is case-insensitive, so say it one way and only one).
          contract: getAddress(onchainEnv.registryAddress),
          call: 'oracle()',
          returns: 'address',
          expect: attester,
          note:
            'Read oracle() on this contract from any RPC for the chain and compare to `attester` above. ' +
            'Equal ⇒ the attester address is confirmed by on-chain state rather than by this endpoint.',
        }
      : null,
    // The full EIP-712 recipe. A verifier reconstructs the typed-data hash from
    // exactly these and recovers the signer locally. (Kept as the v1 recipe for
    // consumers built against it; `schemas` below carries every version.)
    eip712: {
      primaryType: 'WorkProof',
      domain: DOMAIN,
      types: TYPES,
    },
    // One recipe per proof schema. The proof's own `schema` field — which is
    // itself inside the signature — selects the recipe, so a proof cannot claim
    // a recipe it was not signed under.
    schemas: {
      [WORK_PROOF_SCHEMA]: { primaryType: 'WorkProof', domain: DOMAIN, types: TYPES },
      [WORK_PROOF_SCHEMA_V2]: { primaryType: 'WorkProof', domain: DOMAIN, types: TYPES_V2 },
    },
    // v2 proofs additionally commit to an evidence bundle: keccak256 of the
    // canonical JSON (object keys sorted recursively, no whitespace, UTF-8) of
    // { schema, spec, deliverable, grader, graderClass } must equal the signed
    // evidenceHash, and contentHash(deliverable) must equal the signed
    // contentHash. GET /api/proof/<id> serves the bundle alongside the proof.
    evidence: {
      schema: EVIDENCE_SCHEMA,
      canonicalization: 'JSON with object keys sorted recursively, no whitespace, UTF-8, hashed with keccak256',
      binds: ['spec', 'deliverable', 'grader', 'graderClass'],
      graderClasses: {
        reproducible: 're-running the spec against the deliverable yields the same verdict for anyone',
        mechanical: 're-runnable given the named toolchain (e.g. a test suite); pin versions before comparing',
        model:
          're-judging with your own model yields an independent OPINION — the evidence lets you re-derive the inputs, not the verdict',
      },
    },
    verify: {
      how: 'recoverTypedDataAddress({ domain, types: schemas[proof.schema].types, primaryType, message: proof, signature }) === attester',
      note:
        'The signature proves provenance (the oracle signed this verdict), which is non-repudiable. By itself it does ' +
        'NOT re-derive the verdict — that the work actually passes. On v2 proofs the signed evidenceHash additionally ' +
        'binds the spec, deliverable and grader class, so a third party can fetch the evidence and re-derive: ' +
        'mechanically for the mechanical/reproducible classes, as an independent opinion for the model class. See ' +
        'docs/verifying-proofs.md.',
      fetchProof: 'GET /api/proof/<id> returns { proof, signature, attester, evidence } for any issued proof.',
    },
  })
}
