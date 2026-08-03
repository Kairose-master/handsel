import { after } from 'next/server'
import { publicJobsResult } from '@/app/actions/guest'
import { jobToTaskSpec } from '@/lib/task-spec'
import { TASK_FEED_SAFETY, TASK_FEED_UNTRUSTED_FIELDS } from '@/lib/untrusted-input'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // the response is fast; the after() tick is not

const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md#task-spec'

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
  const { state, jobs } = await publicJobsResult(Math.max(limit * 3, 60))
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

  // "No open jobs" and "I could not read the market" are DIFFERENT ANSWERS, and
  // this endpoint used to give both of them as `200 {count: 0}`. Measured on the
  // live deployment before ONCHAIN_LABOR_MARKET_ADDRESS was set: every polling
  // agent was told the market was empty when the truth was that there was no
  // market. A human hitting the site would have seen a page visibly missing its
  // other numbers; a program has no such context, and this is the documented
  // integration point programs are pointed at.
  //
  // 503 rather than 500: the condition is expected to end, and it names a
  // retry. The body still parses as a feed so a naive client sees `count: null`
  // rather than a field that silently became zero.
  if (state !== 'ok') {
    return Response.json(
      {
        type: 'HandselTaskFeed',
        schema: DOCS_URL,
        count: null,
        // Present even here, so the field is part of the shape rather than
        // something a client learns about only on a good day.
        safety: TASK_FEED_SAFETY,
        untrustedFields: TASK_FEED_UNTRUSTED_FIELDS,
        tasks: [],
        error: state,
        detail:
          state === 'unconfigured'
            ? 'This deployment has no labour market configured. It is not that there is no work — there is no market to have work in.'
            : 'The labour market could not be read (RPC unavailable). Retry; this is not an empty market.',
      },
      { status: 503, headers: { 'retry-after': '30' } },
    )
  }

  return Response.json({
    type: 'HandselTaskFeed',
    schema: DOCS_URL,
    count: tasks.length,
    // Who wrote the text below, and what it is never allowed to make you do.
    // The claim path has carried this since the worker-injection work
    // (lib/untrusted-input.ts); the feed did not — which left the DISCOVERY
    // path, unauthenticated and documented and polled by programs, handing a
    // stranger's prose to an agent with nothing attached saying whose it was.
    safety: TASK_FEED_SAFETY,
    untrustedFields: TASK_FEED_UNTRUSTED_FIELDS,
    tasks,
  })
}
