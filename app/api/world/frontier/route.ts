import { publicJobsResult } from '@/app/actions/guest'
import { jobToTaskSpec } from '@/lib/task-spec'
import { feedMeta } from '@/lib/feed-meta'
import { buildFrontier } from '@/lib/frontier-layout'
import { publicAgentLeaderboard } from '@/lib/world-agents-feed'
import { absoluteUrl } from '@/lib/origin'
import { TASK_FEED_SAFETY, TASK_FEED_UNTRUSTED_FIELDS } from '@/lib/untrusted-input'

export const dynamic = 'force-dynamic'

const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/frontier.md'

/**
 * GET /api/world/frontier — the labor market as a map.
 *
 * One public, unauthenticated read that a game world can mirror: every
 * recent job as a BEACON (id, status, bounty, grader, tile) and the agent
 * leaderboard as TOTEMS (name, score, paid jobs, tile), plus the same `meta`
 * block `/api/tasks` carries so a mirror knows which money it is looking at.
 * Consumed by the MUD game in Kairose-master/mud (`games/handsel-frontier`):
 * its oracle writes the numbers on chain, its client reads the text from
 * here. See docs/frontier.md.
 *
 * Read-only, and nothing here is new information: beacons are `/api/tasks`
 * rows, totems are `/api/world/agents` rows, tiles are a pure function of the
 * job id that the game's contract computes for itself. What this route adds
 * is one request instead of two and one vocabulary (the enum codes the
 * contract stores) instead of strings a mirror would have to map.
 *
 * CORS is open because the consumer is a browser on another origin and the
 * body is already public.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept, content-type',
  'cache-control': 'public, max-age=15',
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 50))
  const agentLimit = Math.max(1, Math.min(64, Number(url.searchParams.get('agents')) || 24))

  const [{ state, jobs }, agents] = await Promise.all([
    publicJobsResult(Math.max(limit * 3, 60)),
    publicAgentLeaderboard(agentLimit).catch(() => []),
  ])

  // Same rule as /api/tasks: an unreadable market is not an empty one, and a
  // mirror that cannot tell the difference would erase every beacon.
  if (state !== 'ok') {
    return Response.json(
      {
        type: 'HandselFrontier',
        schema: DOCS_URL,
        generatedAt: new Date().toISOString(),
        meta: feedMeta(),
        layout: null,
        beacons: [],
        totems: [],
        error: state,
        detail:
          state === 'unconfigured'
            ? 'This deployment has no labour market configured — there is no market to map.'
            : 'The labour market could not be read (RPC unavailable). Retry; this is not an empty map.',
      },
      { status: 503, headers: { ...CORS, 'retry-after': '30' } },
    )
  }

  const tasks = jobs.slice(0, limit).map(jobToTaskSpec)
  const { layout, beacons, totems } = buildFrontier(tasks, agents, absoluteUrl('/guest'))

  return Response.json(
    {
      type: 'HandselFrontier',
      schema: DOCS_URL,
      generatedAt: new Date().toISOString(),
      meta: feedMeta(),
      layout,
      // Same warning the task feed carries: the text inside each beacon was
      // written by a stranger, and a game that puts it on a sign is still
      // putting a stranger's words in front of a model.
      safety: TASK_FEED_SAFETY,
      untrustedFields: TASK_FEED_UNTRUSTED_FIELDS,
      beacons,
      totems,
    },
    { headers: CORS },
  )
}
