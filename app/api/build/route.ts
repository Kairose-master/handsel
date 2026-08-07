import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getSession } from '@/lib/get-session'
import { agent, buildRun } from '@/lib/db/schema'
import { nanoid } from 'nanoid'
import { validateRepoFullName } from '@/lib/repo-jobs'
import { normalizeRepoFullName } from '@/lib/repo-job-post'
import { openEnvelope, draw, refund, type BuildEnvelope } from '@/lib/build-envelope'
import { baseUnitsToUsd, bountyFromBudget, usdToBaseUnits } from '@/lib/repo-build'

/**
 * POST /api/build — docs/build-service.md increment 2, the repo lane.
 *
 * v1 decision (recorded here because the doc says it must be, not assumed):
 * a build is exactly ONE repo job. The whole budget funds that job's bounty
 * plus the platform posting fee (lib/repo-build.ts derives the split so the
 * two never exceed the budget); a planner-decomposed N-subtask build is a
 * later increment, once lib/delegation.ts has repo-goal awareness it does
 * not have today.
 *
 * Sequencing follows lib/build-envelope.ts's contract to the letter: draw()
 * BEFORE postRepoJob (the money-moving primitive), refund() immediately if
 * it throws. The envelope stays OPEN (not closed) after a successful post —
 * the job is live and its real outcome (CI pass, refund, expiry) settles
 * later. Closing it, and reading that outcome back, is GET /api/build/<id>
 * — increment 3, deliberately not built here (see docs/build-service.md).
 * This route's own response is therefore the only place a caller learns
 * what happened until increment 3 lands.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type BuildRequest = {
  requesterAgentId?: string
  goal?: string
  repoUrl?: string
  budgetBaseUnits?: string
  baseBranch?: string
  issueUrl?: string
  criteria?: string
  minScore?: number
}

async function recordRun(row: {
  id: string
  requesterAgentId: string
  goal: string
  repoFullName: string
  budgetBaseUnits: string
  envelope: BuildEnvelope
  status: 'posted' | 'failed'
  specHash?: string
  bountyUsd: number
  feeUsd: number
  reason?: string
}) {
  const { ensureBuildRunTable } = await import('@/lib/db/ensure-columns')
  await ensureBuildRunTable()
  await db.insert(buildRun).values({
    id: row.id,
    requesterAgentId: row.requesterAgentId,
    goal: row.goal,
    repoFullName: row.repoFullName,
    budgetBaseUnits: row.budgetBaseUnits,
    drawnBaseUnits: row.envelope.drawnBaseUnits,
    refundedBaseUnits: row.envelope.refundedBaseUnits,
    closed: row.envelope.closed,
    status: row.status,
    specHash: row.specHash ?? null,
    bountyUsd: row.bountyUsd.toFixed(2),
    feeUsd: row.feeUsd.toFixed(2),
    reason: row.reason ?? null,
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session?.user) return Response.json({ error: 'Not signed in' }, { status: 401 })

  let body: BuildRequest
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 })
  }

  // The requester agent must be the caller's — a build spends real escrow,
  // scoped to what the signed-in account owns, same rule as every other
  // money-moving route (app/api/repo/ci-bounty/route.ts).
  const requesterAgentId = String(body.requesterAgentId ?? '')
  const [ag] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, requesterAgentId), eq(agent.userId, session.user.id)))
  if (!ag) return Response.json({ error: 'No such agent on your account' }, { status: 403 })

  const goal = String(body.goal ?? '').trim()
  if (goal.length < 20) {
    return Response.json({ error: 'goal must be specific enough to work (20+ characters)' }, { status: 400 })
  }

  // Increment 2 accepts only repo goals — text/mixed goals are increment 4.
  const repoFullName = normalizeRepoFullName(String(body.repoUrl ?? ''))
  if (!validateRepoFullName(repoFullName)) {
    return Response.json(
      { error: 'repoUrl is required and must resolve to owner/name — this increment only builds repo goals' },
      { status: 400 },
    )
  }

  const budgetBaseUnits = String(body.budgetBaseUnits ?? '')
  let envelope: BuildEnvelope
  try {
    envelope = openEnvelope(budgetBaseUnits)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'invalid budgetBaseUnits' }, { status: 400 })
  }

  const split = bountyFromBudget(baseUnitsToUsd(budgetBaseUnits))
  if (!split) {
    return Response.json({ error: 'budgetBaseUnits is too small to fund a bounty plus the posting fee' }, { status: 400 })
  }
  const amountBaseUnits = usdToBaseUnits(split.bountyUsd + split.feeUsd)

  const id = nanoid()
  const gate = draw(envelope, amountBaseUnits)
  if (!gate.ok) {
    await recordRun({
      id,
      requesterAgentId,
      goal,
      repoFullName,
      budgetBaseUnits,
      envelope: gate.envelope,
      status: 'failed',
      bountyUsd: split.bountyUsd,
      feeUsd: split.feeUsd,
      reason: gate.reason,
    })
    return Response.json({ buildId: id, status: 'failed', reason: gate.reason }, { status: 400 })
  }
  envelope = gate.envelope

  try {
    const { postRepoJob } = await import('@/lib/repo-job-post')
    const result = await postRepoJob({
      requesterAgentId,
      repoFullName,
      baseBranch: body.baseBranch,
      title: goal.slice(0, 120),
      brief: goal,
      issueUrl: body.issueUrl,
      criteria: body.criteria,
      bountyUsd: split.bountyUsd,
      minScore: body.minScore,
    })

    await recordRun({
      id,
      requesterAgentId,
      goal,
      repoFullName: result.repoFullName,
      budgetBaseUnits,
      envelope,
      status: 'posted',
      specHash: result.specHash,
      bountyUsd: split.bountyUsd,
      feeUsd: split.feeUsd,
    })

    return Response.json({
      buildId: id,
      status: 'posted',
      repoFullName: result.repoFullName,
      specHash: result.specHash,
      bountyUsd: split.bountyUsd,
      feeUsd: split.feeUsd,
      txHash: result.txHash,
    })
  } catch (error) {
    // The money-moving primitive threw — release the reservation immediately
    // (lib/build-envelope.ts's documented contract), so a retry within this
    // same build's budget sees the headroom as real, not phantom-spent.
    envelope = refund(envelope, amountBaseUnits)
    const reason = error instanceof Error ? error.message : String(error)
    await recordRun({
      id,
      requesterAgentId,
      goal,
      repoFullName,
      budgetBaseUnits,
      envelope,
      status: 'failed',
      bountyUsd: split.bountyUsd,
      feeUsd: split.feeUsd,
      reason,
    })
    return Response.json({ buildId: id, status: 'failed', reason }, { status: 502 })
  }
}
