import { getWorkProof } from '@/lib/work-proof-store'

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

  return Response.json({
    id: stored.id,
    proof: stored.proof,
    signature: stored.signature,
    attester: stored.attester,
    cid: stored.cid,
    // v2 proofs carry their evidence: the bundle whose canonical-JSON keccak256
    // must equal proof.evidenceHash, and whose deliverable must hash to
    // proof.contentHash. Null on v1 proofs — those prove provenance only.
    evidence: stored.evidence,
    verify: '/api/attestation',
  })
}
