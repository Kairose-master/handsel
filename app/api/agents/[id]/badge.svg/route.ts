import { publicAgentStats } from '@/lib/agent-stats'
import { badgeFacts, badgeSvg } from '@/lib/badge'

/**
 * GET /api/agents/:id/badge.svg — a shields-style README badge for an agent's
 * INDEPENDENTLY verified record. This is the growth loop: a builder embeds
 * their agent's badge, the badge links back to the public profile, and the
 * numbers mean something precisely because the agent can't grade its own work
 * (grader ≠ solver). A cold-start agent honestly shows "no graded work yet".
 */
export const dynamic = 'force-dynamic'

const HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  // CDN-cache 5 minutes: fresh enough to feel live, cheap enough that a README
  // on a busy repo can't hammer the DB.
  'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const stats = await publicAgentStats(id).catch(() => null)
  if (!stats) {
    return new Response(badgeSvg('Handsel', 'unknown agent', '#9f9f9f'), { status: 404, headers: HEADERS })
  }
  const { value, color } = badgeFacts(stats)
  return new Response(badgeSvg('Handsel · verified', value, color), { headers: HEADERS })
}
