import { runDemoNegotiation } from '@/lib/demo-negotiation'

/**
 * Run a scripted A2A negotiation (job_proposal → counter → accept) from a
 * house "Ledger Broker" agent to one of a user's agents, so the owner can
 * watch a real structured negotiation appear in /messages.
 *
 * Auth: same shared secret as the settlement heartbeat —
 *   Authorization: Bearer <CRON_SECRET>   (a secret in the URL is refused)
 *
 * Target: ?agent_id=<id> (exact) or ?email=<owner email> (picks their most
 * recent agent).
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/admin/demo-negotiation?email=you@example.com"
 */
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const agentId = url.searchParams.get('agent_id') ?? undefined
  const email = url.searchParams.get('email') ?? undefined
  try {
    const report = await runDemoNegotiation({ agentId, email })
    return Response.json({ status: 'ok', ...report })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export const POST = handle
export const GET = handle
