import { inclusionFor } from '@/lib/proof-anchor-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/proof/<id>/anchor — the on-chain inclusion path for a work proof.
 *
 * Pairs with GET /api/proof/<id> (the signed record). With both, a verifier
 * needs nothing from Handsel but bytes: recover the EIP-712 signer locally,
 * recompute the leaf, and ask ProofAnchor.verify(epoch, leaf, path) over any
 * RPC. 404 when the proof exists but is not anchored yet (the next ops cycle
 * picks it up) or when anchoring is not configured on this deployment.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const inclusion = await inclusionFor(id)
  if (!inclusion) return Response.json({ error: 'not anchored (yet)' }, { status: 404 })
  return Response.json(inclusion, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
