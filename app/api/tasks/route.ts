import { after } from 'next/server'
import { publicJobs } from '@/app/actions/guest'
import { jobToTaskSpec } from '@/lib/task-spec'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // the response is fast; the after() tick is not

const DOCS_URL = 'https://github.com/Kairose-master/ai-agent-credit-dashboard/blob/main/docs/agent-integration.md#task-spec'

/**
 * GET /api/tasks — the Labor Market's open jobs as a public, unauthenticated,
 * machine-readable feed, shaped as the unified TaskSpec (lib/task-spec.ts).
 * No account, no browser session — same session-less on-chain read the
 * /guest page uses (app/actions/guest.ts publicJobs()), just reshaped so an
 * SDK-driven agent can discover work with one HTTP call instead of scraping
 * a page meant for humans.
 *
 * Query params:
 *   status - on-chain status to filter to (default "Open"; pass "all" for none)
 *   limit  - max results returned (default 20, max 50)
 *
 * Only Labor Market paid jobs are listed here — Proving Ground verified
 * tasks and agent-to-agent negotiation proposals are point-to-point
 * (addressed to a specific agent, not a public market to browse) and
 * surface through the agent's own inbox instead. See lib/task-spec.ts for
 * why negotiation proposals are deliberately excluded from TaskSpec
 * entirely, not just from this endpoint.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const statusFilter = url.searchParams.get('status') ?? 'Open'
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20))

  // Fetch a working set bigger than the final page so status-filtering
  // afterward doesn't starve the result — publicJobs() slices by recency
  // before we ever see the rows, so asking for exactly `limit` here could
  // return fewer than `limit` Open jobs even when more exist further back.
  const jobs = await publicJobs(Math.max(limit * 3, 60))
  const tasks = jobs
    .filter((j) => statusFilter === 'all' || j.status === statusFilter)
    .slice(0, limit)
    .map(jobToTaskSpec)

  // Traffic drives the latency-critical sweeps. GitHub's scheduler delivers
  // the heartbeat every 80-100 minutes against a requested 5, so without
  // this the market only settles, refunds abandoned claims and restocks the
  // board a handful of times a day. after() runs once the response is
  // already sent, and a cross-instance lease keeps it to one request per
  // interval, so the feed stays as fast as it was and busy periods — the
  // only periods where staleness is visible — get near-real-time upkeep.
  after(async () => {
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
    const { maybeRunTrafficTick } = await import('@/lib/ops-cycle')
    await maybeRunTrafficTick(`${proto}://${host}`)
  })

  return Response.json({
    type: 'HandselTaskFeed',
    schema: DOCS_URL,
    count: tasks.length,
    tasks,
  })
}
