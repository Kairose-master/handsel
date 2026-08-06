import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { resolveCallbackAuth, callbackSecretMatches } from '@/lib/webhook'
import { canAppeal } from '@/lib/appeal'
import { classifyGrader } from '@/lib/grader-class'
import { logPlatformEvent } from '@/lib/platform-feed'

/**
 * POST /api/jobs/appeal — a worker contests a failing verdict.
 *
 * The counterpart to ERC-8195's `appeal()`, and the missing half of every
 * grading defect in `docs/failure-modes.md`: until this route existed, a worker
 * that had been graded wrongly could do nothing but be graded wrongly.
 *
 * **Worker-secret auth, not session auth.** The party with standing here is the
 * agent, and most workers have no browser — the desktop miner, MCP workers and
 * headless scripts all authenticate with the same secret they use to submit
 * work. Requiring a logged-in owner would make the right theoretical for
 * exactly the population most likely to need it.
 *
 * Filing is free and changes nothing on its own. `canAppeal` decides whether the
 * appeal is admissible; the resolution runs separately, because deciding
 * entitlement inside a request and deciding the verdict inside the same request
 * would make an appeal something a worker can trigger and immediately benefit
 * from. Those are different authorities and they get different call paths.
 *
 * Body: { agent_id, spec_hash }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const agentId = body?.agent_id as string | undefined
  const specHash = body?.spec_hash as string | undefined
  if (!agentId || !specHash) {
    return Response.json({ error: 'Missing agent_id or spec_hash' }, { status: 400 })
  }

  const [ag] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!ag) return Response.json({ error: 'Agent not found' }, { status: 404 })

  const auth = await resolveCallbackAuth(agentId)
  if (!auth.required || !callbackSecretMatches(auth, request.headers.get('x-runtime-secret'))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, specHash))
  if (!spec) return Response.json({ error: 'Job not found' }, { status: 404 })

  const result = spec.testResult
  if (!result) {
    return Response.json({ error: 'This job has no recorded verdict to appeal' }, { status: 409 })
  }
  if (result.appeal) {
    // Idempotent rather than an error: a worker retrying a request that already
    // succeeded should learn the state, not be told it did something wrong.
    return Response.json({ appeal: result.appeal, alreadyFiled: true })
  }

  // Which grader produced the verdict decides how the appeal is heard, so it is
  // read from the same fields the grading dispatch used. An unrecognised grader
  // classifies to the weakest class, which routes to a panel — the expensive
  // path. Getting this backwards would let an unknown grader claim the cheap one.
  const graderClass = classifyGrader(
    spec.testSuiteSlug ? 'tests' : spec.repoFullName ? 'ci' : spec.testCode ? 'code' : 'llm-review',
  )

  const gradedAtMs = result.gradedAt ? Date.parse(result.gradedAt) : Number.NaN
  const decision = canAppeal({
    requestingAgentId: agentId,
    workerAgentId: spec.workerAgentId,
    passed: result.passed,
    graderClass,
    gradedAtMs: Number.isFinite(gradedAtMs) ? gradedAtMs : null,
    priorAppeals: 0,
    nowMs: Date.now(),
  })

  if (!decision.ok) {
    return Response.json({ error: decision.reason }, { status: 409 })
  }

  const appeal = {
    filedAt: new Date().toISOString(),
    route: decision.route,
    originalPassed: result.passed as boolean,
    status: 'open' as const,
  }
  await db
    .update(jobSpec)
    .set({ testResult: { ...result, appeal } })
    .where(eq(jobSpec.specHash, specHash))

  await logPlatformEvent(
    'VERDICT_APPEALED',
    `A worker appealed the failing verdict on job ${spec.onchainJobId} — to be re-heard by ${decision.route}`,
  ).catch(() => {})

  return Response.json({ appeal })
}
