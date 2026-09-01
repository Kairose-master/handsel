import { evidencePubliclyVisible, getWorkProof } from '@/lib/work-proof-store'

/**
 * GET /api/proof/<id> — the machine-readable work proof.
 *
 * `/proof/<id>` is the human page; this is the same record as JSON so a verifier
 * can fetch `{ proof, signature, attester }` and check it locally against the
 * recipe at `/api/attestation`, with no further trust in us. Proofs are public
 * by design — the whole point is that anyone can verify them.
 *
 * The `proof` object here is the exact EIP-712 message that was signed; pass it
 * straight into `recoverTypedDataAddress`.
 */
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const stored = await getWorkProof(id)
  if (!stored) return Response.json({ error: 'proof not found' }, { status: 404 })

  // Office-scoped jobs (lib/office.ts): the PROOF stays public — hashes,
  // parties, verdict and signature commit without revealing — but the
  // evidence bundle carries the sealed spec and the deliverable, exactly the
  // bytes the visibility split keeps off the public board. A proof id must
  // not be a way around it.
  const evidenceVisible = stored.evidence ? await evidencePubliclyVisible(stored.proof.jobRef) : true

  return Response.json({
    id: stored.id,
    proof: stored.proof,
    signature: stored.signature,
    attester: stored.attester,
    cid: stored.cid,
    // v2 proofs carry their evidence: the bundle whose canonical-JSON keccak256
    // must equal proof.evidenceHash, and whose deliverable must hash to
    // proof.contentHash. Null on v1 proofs — those prove provenance only.
    evidence: evidenceVisible ? stored.evidence : null,
    ...(evidenceVisible
      ? {}
      : {
          evidenceWithheld:
            'this job is scoped to its office; the evidence bundle (spec + deliverable) is not public. The hashes above still commit to it — the parties who hold the material can re-derive them.',
        }),
    verify: '/api/attestation',
  })
}
