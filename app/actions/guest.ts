'use server'

/**
 * Guest mode: a read-only, no-login snapshot of the platform's real,
 * live data — for visitors deciding whether to sign up. Every number here
 * is a genuine query against the same tables/on-chain reads the logged-in
 * dashboard uses (see Claude.md's "No fabricated numbers, ever"); nothing
 * is seeded or hardcoded for show. Deliberately narrower than the logged-in
 * views: no per-user "mine" labeling (there's no user), no mutations.
 */
import { db } from '@/lib/db'
import { SAFE_JOB_SPEC_COLUMNS } from '@/lib/db/safe-select'
import { agent, agentEvent, agentTemplate, platformEvent, jobSpec, agentTask } from '@/lib/db/schema'
import { eq, desc, inArray } from 'drizzle-orm'
import { gradeForDisplay } from '@/lib/job-grade'
import { computeLaborIndex } from '@/lib/platform-index'

function truncate(addr: string | null | undefined): string | null {
  if (!addr || /^0x0+$/.test(addr)) return null
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Same shape as the logged-in Jobs page's cards (acceptance criteria,
 *  real output, dispute reason, attachment) minus "mine"/action buttons —
 *  guests can't act, but should be able to see the real flow at a glance.
 *  Exported so GET /api/tasks (lib/task-spec.ts) can reuse the same
 *  session-less on-chain read instead of duplicating it — that route passes
 *  its own `limit`; the guest page keeps relying on the 10-row default. */
/**
 * Why the market returned no jobs — three values, not two.
 *
 * `publicJobs` collapsed all three into `[]`, and GET /api/tasks served that
 * as `{ count: 0 }` with HTTP 200. Measured on the live deployment before
 * `ONCHAIN_LABOR_MARKET_ADDRESS` was set: the documented public integration
 * point told every polling agent "there is no work here" when the truth was
 * "this deployment has no market."
 *
 * That is the same shape as the deliverable check in lib/spec-hash.ts, and it
 * matters for the same reason: two values force "I cannot tell" to be reported
 * as one of the two things it is not. It is also this repo's own first rule —
 * no fake data — since a hardcoded `[]` standing in for a query result is a
 * number on a page that nothing measured.
 *
 * A PAGE may degrade to zero cards; that reads as an empty market to a human
 * looking at an otherwise-visibly-broken site. An API may not, because the
 * caller is a program with no other signal.
 */
export type MarketReadState = 'ok' | 'unconfigured' | 'unreachable'

/**
 * `publicJobs` with the reason attached — what GET /api/tasks calls.
 *
 * The state is RETURNED and never stashed on the module. A `let` at module
 * scope set by one call and read by the next is a race the moment two requests
 * overlap, which on a serverless runtime is the normal case rather than the
 * unusual one; the caller would get another request's verdict about a different
 * market and have no way to know.
 */
export async function publicJobsResult(limit = 10) {
  return readPublicJobs(limit)
}

/**
 * The array form, for pages.
 *
 * A page rendering zero cards is an acceptable degradation — a human is looking
 * at a site whose other numbers are visibly missing too. A program polling an
 * API has no such context, which is the whole reason the two forms differ.
 */
export async function publicJobs(limit = 10) {
  return (await readPublicJobs(limit)).jobs
}

async function readPublicJobs(limit: number) {
  // Close the window between a deploy and its migration: a column declared
  // in schema.ts but missing in the database breaks EVERY reader of the table.
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { state: 'unconfigured' as const, jobs: [] }

  const { readJobs } = await import('@/lib/onchain/labor')
  const { reapStuckTasks } = await import('@/lib/agent-tasks')
  await reapStuckTasks()

  let state: MarketReadState = 'ok'
  const onchainJobs = await readJobs().catch(() => {
    // An unreachable RPC is not an empty market either. Same collapse, one
    // layer down, and the one that will actually happen in production — an RPC
    // provider rate-limiting is far likelier than a missing env var.
    state = 'unreachable'
    return []
  })

  // Slice FIRST, then fetch only what the visible cards need. This used to
  // read every job_specs row and — worse — every agent_tasks row, because the
  // task query was guarded by `taskIds.length > 0 ?` but carried no WHERE
  // clause at all: it looked scoped and wasn't. agent_tasks.output holds the
  // full text of every deliverable ever submitted, so the busiest read path on
  // the site (this page, GET /api/tasks, the Minecraft poller) was pulling the
  // entire deliverable archive down to render ten cards.
  const visible = onchainJobs.slice(0, limit)
  const wantedHashes = [...new Set(visible.flatMap((j) => [j.specHash, j.specHash.toLowerCase()]))]
  const specs = wantedHashes.length > 0
    ? await db.select(SAFE_JOB_SPEC_COLUMNS).from(jobSpec).where(inArray(jobSpec.specHash, wantedHashes))
    : []
  const specByHash = new Map(specs.map((s) => [s.specHash.toLowerCase(), s]))

  // Office-scoped review jobs (lib/office.ts) never reach this feed: it is
  // the session-less, unauthenticated read (see the header comment) — an
  // anonymous caller has no identity to be "connected" as, so officeJobVisible
  // would reject every one of them anyway. Filtering here, rather than
  // relying on that, keeps a scoped job's title/description out of the
  // response entirely instead of merely unclaimable.
  const { officeJobVisible } = await import('@/lib/office')
  const visibleFiltered = visible.filter((j) =>
    officeJobVisible(specByHash.get(j.specHash.toLowerCase())?.officeOwnerId ?? null, null, false),
  )

  const taskIds = [...new Set(specs.map((s) => s.agentTaskId).filter((id): id is string => Boolean(id)))]
  const tasks = taskIds.length > 0
    ? await db
        .select({ id: agentTask.id, status: agentTask.status, output: agentTask.output })
        .from(agentTask)
        .where(inArray(agentTask.id, taskIds))
    : []
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  // Agent DISPLAY NAMES for the two sides of a job. The truncated addresses
  // below identify a wallet, not a participant anyone can recognise, which
  // makes a job impossible to match against the public agent leaderboard
  // (that's the §17 matching gap the Minecraft village hits). Names are
  // already public on /world and GET /api/world/agents, so exposing them
  // here adds no new disclosure — agent IDs deliberately stay hidden.
  const partyIds = [
    ...new Set(
      specs
        .flatMap((s) => [s.requesterAgentId, s.workerAgentId])
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const parties = partyIds.length > 0
    ? await db.select({ id: agent.id, name: agent.name }).from(agent).where(inArray(agent.id, partyIds))
    : []
  const nameByAgentId = new Map(parties.map((p) => [p.id, p.name]))

  const jobs = visibleFiltered
    .map((j) => {
      const spec = specByHash.get(j.specHash.toLowerCase())
      const task = spec?.agentTaskId ? taskById.get(spec.agentTaskId) : undefined
      return {
        id: j.id,
        title: spec?.title ?? 'Untitled job',
        description: spec?.description ?? null,
        acceptanceCriteria: spec?.acceptanceCriteria ?? null,
        status: j.status,
        bounty: j.bounty,
        minScore: j.minScore,
        requesterLabel: truncate(j.requester),
        workerLabel: truncate(j.worker),
        requesterName: spec?.requesterAgentId ? nameByAgentId.get(spec.requesterAgentId) ?? null : null,
        workerName: spec?.workerAgentId ? nameByAgentId.get(spec.workerAgentId) ?? null : null,
        workerRunStatus: task?.status ?? null,
        output: task?.status === 'completed' ? task.output : null,
        disputeNote: spec?.disputeNote ?? null,
        attachmentUrl: spec?.attachmentUrl ?? null,
        attachmentName: spec?.attachmentName ?? null,
        // Only a verdict the chain has a submission for — see lib/job-grade.ts.
        // This is the public board, so it is the surface where a grade about a
        // submission that never landed is most misleading.
        testResult: gradeForDisplay(j.resultHash, spec?.testResult),
        hasTests: Boolean(spec?.testCode),
        // GitHub repo jobs: where to clone and what to diff against. Exposed
        // as structured fields so a headless worker doesn't have to regex the
        // human-readable brief to find them.
        repoFullName: spec?.repoFullName ?? null,
        baseBranch: spec?.baseBranch ?? null,
      }
    })

  return { state, jobs }
}

/** Public leaderboard: top-earning worker agents, ranked by real payouts
 *  (JOB_COMPLETED bounties) with their independent-grading record. The
 *  competitive layer of the mining framing — every number is a live
 *  aggregation, no seeding. */
async function leaderboard() {
  const rows = await db
    .select()
    .from(agentEvent)
    .where(
      inArray(agentEvent.eventType, [
        'JOB_COMPLETED',
        'JOB_TESTS_PASSED',
        'JOB_TESTS_FAILED',
        'VERIFIED_TASK_COMPLETED',
        'VERIFIED_TASK_FAILED',
      ]),
    )

  const byAgent = new Map<
    string,
    { earnedUsd: number; jobs: number; gradedPassed: number; gradedTotal: number }
  >()
  for (const e of rows) {
    const entry = byAgent.get(e.agentId) ?? { earnedUsd: 0, jobs: 0, gradedPassed: 0, gradedTotal: 0 }
    if (e.eventType === 'JOB_COMPLETED') {
      entry.jobs += 1
      const bounty = (e.detail as { bounty?: number } | null)?.bounty
      entry.earnedUsd += typeof bounty === 'number' ? bounty : 0
    } else {
      entry.gradedTotal += 1
      if (e.eventType === 'JOB_TESTS_PASSED' || e.eventType === 'VERIFIED_TASK_COMPLETED') {
        entry.gradedPassed += 1
      }
    }
    byAgent.set(e.agentId, entry)
  }

  const ids = [...byAgent.keys()]
  if (ids.length === 0) return []
  const agents = await db.select().from(agent).where(inArray(agent.id, ids))
  const nameOf = new Map(agents.map((a) => [a.id, a]))

  return [...byAgent.entries()]
    .map(([id, s]) => ({
      name: nameOf.get(id)?.name ?? 'Unknown agent',
      runtime: nameOf.get(id)?.runtimeType ?? 'platform',
      creditScore: Math.round(parseFloat(nameOf.get(id)?.creditScore ?? '0')),
      rating: nameOf.get(id)?.creditRating ?? 'unrated',
      earnedUsd: s.earnedUsd,
      jobs: s.jobs,
      gradedPassRate: s.gradedTotal > 0 ? Math.round((s.gradedPassed / s.gradedTotal) * 100) : null,
    }))
    .sort((a, b) => b.earnedUsd - a.earnedUsd || b.jobs - a.jobs)
    .slice(0, 5)
}

export async function getGuestOverview() {
  const index = await computeLaborIndex()

  const feedRows = await db
    .select()
    .from(platformEvent)
    .orderBy(desc(platformEvent.createdAt))
    .limit(15)

  const templateRows = await db
    .select()
    .from(agentTemplate)
    .where(eq(agentTemplate.active, true))
    .orderBy(desc(agentTemplate.createdAt))
    .limit(10)

  const jobs = await publicJobs()
  const topWorkers = await leaderboard()

  return {
    topWorkers,
    stats: {
      agentCount: index.supply.agentCount,
      avgScore: index.supply.avgCreditScore,
      totalCreditLine: index.supply.totalCreditLineUsd,
    },
    feed: feedRows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, createdAt: r.createdAt })),
    templates: templateRows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      priceUsd: parseFloat(t.priceUsd),
    })),
    jobs,
    // For the environment disclosure in the footer: which kind of chain the
    // numbers above live on. Null when no chain is configured — the footer
    // then says nothing rather than guessing.
    realMoney: await marketRealMoney(),
  }
}

/**
 * Which money the guest page's numbers are denominated in, or null when no
 * labor market is configured (the page then makes no environment claim).
 *
 * Gated on `isLaborMarketConfigured`, NOT `isOnchainConfigured`. The latter is
 * about the credit registry AND THE VAULT — its own docstring says "do not
 * reach for this to gate anything else" after being the wrong predicate three
 * times. This function was the fourth: neither Base deployment has a vault, so
 * the gate returned null on both, and the landing page fell back to its
 * environment-neutral sentence — on mainnet, over real balances — while
 * `/api/tasks`'s `feedMeta()` (ungated on the vault) answered correctly.
 * Found by an external audit (issue #4, findings 3–4); failure-modes §28.
 */
async function marketRealMoney(): Promise<boolean | null> {
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) return null
    const { isRealMoney } = await import('@/lib/onchain/real-money')
    return isRealMoney()
  } catch {
    return null
  }
}
