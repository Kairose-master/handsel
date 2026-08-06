import { resolveMcpAuth } from '@/lib/oauth'
import { gradeTextSubmission } from '@/lib/text-grading'
import { rateLimited } from '@/lib/rate-limit'
import { nanoid } from 'nanoid'
import { absoluteUrl } from '@/lib/origin'
import { toEvaluateArgs, type EvaluatorAward } from '@/lib/taskmarket-evaluator'

/**
 * POST /api/evaluator/verdict — grade a deliverable and return it shaped as an
 * ERC-8195 `evaluate()` call.
 *
 * This is `/api/grade` with the last mile attached: the same independent
 * grading, plus the exact argument list TaskMarket's `EvaluatorFacet.evaluate`
 * takes, plus the signed proof whose `contentHash` is the `evidenceHash` inside
 * it. A market that has assigned Handsel as a task's evaluator can call this and
 * relay the result; a market that has not can call it anyway and check the proof
 * itself (`docs/verifying-proofs.md`).
 *
 * We do not broadcast. TaskMarket gates every state change on
 * `_requireForwarder`, and their forwarder accepts calls from one authorised
 * relay server, so the transaction is always theirs to send. What we return is
 * the decision — including the decision that there is no verdict to send, in
 * which case `evaluatorTimeout()` forfeits OUR stake and hands the task back to
 * the requester. `submit: false` is a real outcome, not an error.
 *
 * Auth: the same Bearer tokens the MCP connector uses. Fail-closed.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_DELIVERABLE_CHARS = 120_000
const MAX_SPEC_CHARS = 10_000
const MAX_AWARDS = 32
const PER_USER_PER_HOUR = 30

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveMcpAuth(request)
  if (!auth) return Response.json({ error: 'invalid_token' }, { status: 401 })

  if (rateLimited(auth.userId, { bucket: 'api-evaluator', windowMs: 60 * 60 * 1000, max: PER_USER_PER_HOUR })) {
    return Response.json({ error: 'rate limit reached — try again later' }, { status: 429 })
  }

  let deliverable: string, spec: string, taskId: string, rewardBaseUnits: string
  let awards: EvaluatorAward[]
  try {
    const body = await request.json()
    deliverable = String(body?.deliverable ?? '')
    spec = String(body?.spec ?? '')
    taskId = String(body?.taskId ?? '').slice(0, 66)
    rewardBaseUnits = String(body?.rewardBaseUnits ?? '')
    awards = Array.isArray(body?.awards) ? body.awards.slice(0, MAX_AWARDS) : []
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 })
  }
  if (!deliverable.trim()) return Response.json({ error: 'deliverable required' }, { status: 400 })
  if (!spec.trim()) return Response.json({ error: 'spec required' }, { status: 400 })
  if (!/^\d+$/.test(rewardBaseUnits)) {
    return Response.json({ error: 'rewardBaseUnits required (USDC base units, decimal string)' }, { status: 400 })
  }
  if (deliverable.length > MAX_DELIVERABLE_CHARS) {
    return Response.json({ error: `deliverable too large (max ${MAX_DELIVERABLE_CHARS} chars)` }, { status: 400 })
  }
  if (spec.length > MAX_SPEC_CHARS) {
    return Response.json({ error: `spec too large (max ${MAX_SPEC_CHARS} chars)` }, { status: 400 })
  }

  const graded = await gradeTextSubmission(
    { title: taskId ? `TaskMarket ${taskId}` : 'External evaluation', description: null, acceptanceCriteria: spec },
    deliverable,
    auth.userId,
  )

  // A pass earns the signed proof that becomes the on-chain evidenceHash. Unlike
  // /api/grade, the proof is NOT a bonus here: without it there is no evidence to
  // anchor, and toEvaluateArgs refuses to submit — so a storage failure costs us
  // the evaluator stake rather than producing an unverifiable APPROVE.
  let proof: { id: string; contentHash: string; attester: string } | undefined
  if (graded.passed === true) {
    try {
      const { issueWorkProof } = await import('@/lib/work-proof-store')
      const stored = await issueWorkProof({
        jobRef: taskId || `eval-${nanoid(10)}`,
        kind: 'text',
        worker: awards[0]?.worker ?? `worker@${auth.email}`,
        requester: auth.email,
        grader: 'llm-review',
        deliverable: { text: deliverable },
      })
      if (stored) proof = { id: stored.id, contentHash: stored.proof.contentHash, attester: stored.attester }
    } catch {
      /* falls through to "no evidence, no verdict" below */
    }
  }

  const decision = toEvaluateArgs({
    grade: { passed: graded.passed, reason: graded.output, proof },
    rewardBaseUnits,
    awards,
  })

  return Response.json({
    taskId: taskId || null,
    // passed: true | false | null — null means grading did not run. Callers MUST
    // NOT read it as a verdict in either direction; `decision.submit` is false.
    passed: graded.passed,
    gradedAt: graded.gradedAt,
    decision,
    ...(proof ? { proof: { ...proof, url: absoluteUrl(`/proof/${proof.id}`) } } : {}),
    verify: absoluteUrl('/api/attestation'),
  })
}
