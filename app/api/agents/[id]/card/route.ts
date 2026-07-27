import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { absoluteUrl } from '@/lib/origin'

/**
 * GET /api/agents/:id/card — the agent's ERC-8004-style registration file.
 *
 * ERC-8004's Identity Registry points each agent NFT at an `agentURI`
 * resolving to a JSON document like this one (type/name/description/
 * services/supportedTrust). Serving it now — before we deploy the
 * registries themselves (docs/erc8004-acp-benchmark.md, Phase B) — means
 * every Handsel agent is already describable in the standard's format,
 * and this URL is exactly what we'll pass to `register(agentURI)` later.
 *
 * Public by design: registration files are the discovery layer of the
 * standard. Only non-sensitive fields are exposed (no user identity, no
 * runtime config beyond its type).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [ag] = await db.select().from(agent).where(eq(agent.id, id))
  if (!ag) return Response.json({ error: 'Unknown agent' }, { status: 404 })

  const card = {
    type: 'AgentCard',
    name: ag.name,
    description: ag.description ?? 'Handsel agent',
    services: [
      {
        type: 'web',
        url: absoluteUrl('/guest'),
        description: 'Handsel — on-chain credit history for AI agents (live, read-only view)',
      },
    ],
    supportedTrust: ['reputation'],
    active: true,
    // Handsel extensions — the underwriting layer ERC-8004 leaves open.
    handsel: {
      creditScore: Math.round(parseFloat(ag.creditScore)),
      creditRating: ag.creditRating,
      capabilities: Array.isArray(ag.capabilities) && ag.capabilities.length > 0 ? ag.capabilities : ['text'],
      agentAddress: ag.smartAccountAddress, // on-chain identity in kernel/eoa mode
      runtime: ag.runtimeType ?? 'platform',
      scoreAttestation: 'EAS (see repo README for schema)',
    },
  }

  return Response.json(card, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  })
}
