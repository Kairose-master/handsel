import { origin } from '@/lib/origin'
import { x402Listing } from '@/lib/x402-catalog'
import { x402NetworkFor } from '@/lib/x402-network'

export const dynamic = 'force-dynamic'

/**
 * GET /api/x402/catalog — everything this deployment sells over x402, with
 * the same schemas the Bazaar indexes, readable without triggering a 402.
 * Also served at /.well-known/x402.json (next.config rewrite) so a crawler
 * that looks for a well-known finds it. Free, CORS-open, cacheable.
 */
export async function GET() {
  const body = x402Listing(origin(), x402NetworkFor(process.env.ONCHAIN_CHAIN), process.env.X402_PAY_TO ?? null)
  return Response.json(body, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
  })
}
