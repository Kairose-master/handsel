import { publicAgentLeaderboard } from '@/lib/world-agents-feed'

export const dynamic = 'force-dynamic'

/**
 * GET /api/world/agents — the agent leaderboard as a public, unauthenticated,
 * machine-readable feed, for external visualizers (the Minecraft plugin's v2
 * agent village; see minecraft/BUILD_PLAN.md §14, and the MUD game's totems,
 * docs/frontier.md).
 *
 * `getWorldState()` (app/actions/world.ts) is session-scoped — it returns only
 * the viewer's OWN agents — so an external process can't use it. This route is
 * the keyless read equivalent. The query, and the rule about which columns it
 * may ever expose, live in lib/world-agents-feed.ts.
 *
 * Query params:
 *   limit - max results returned (default 24, max 64)
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.max(1, Math.min(64, Number(url.searchParams.get('limit')) || 24))
  const agents = await publicAgentLeaderboard(limit)
  return Response.json({ type: 'HandselAgents', count: agents.length, agents })
}
