import { resolveMcpAuth } from '@/lib/oauth'
import { gradeTextSubmission } from '@/lib/text-grading'
import { rateLimited } from '@/lib/rate-limit'
import { nanoid } from 'nanoid'
import { absoluteUrl } from '@/lib/origin'

/**
 * POST /api/grade — independent grading as a service, for external harnesses
 * (first consumer: Foreman's HandselEngine). The caller sends a deliverable
 * plus the spec it must satisfy; the platform's grader judges it with the
 * CALLER'S OWN LLM key (BYOK chain, billed to their account, grader ≠ solver
 * — the harness that produced the work never grades it), and a pass earns a
 * signed, publicly verifiable work proof (/proof/<id>).
 *
 * Auth: the same Bearer tokens the MCP connector uses (OAuth or personal
 * token from /api/oauth/personal-token). Fail-closed: no token, no grade.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_DELIVERABLE_CHARS = 120_000
const MAX_SPEC_CHARS = 10_000
const PER_USER_PER_HOUR = 30

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveMcpAuth(request)
  if (!auth) return Response.json({ error: 'invalid_token' }, { status: 401 })

  if (rateLimited(auth.userId, { bucket: 'api-grade', windowMs: 60 * 60 * 1000, max: PER_USER_PER_HOUR })) {
    return Response.json({ error: 'rate limit reached — try again later' }, { status: 429 })
  }

  let deliverable: string, spec: string, label: string
  try {
    const body = await request.json()
    deliverable = String(body?.deliverable ?? '')
    spec = String(body?.spec ?? '')
    label = String(body?.label ?? 'External harness run').slice(0, 200)
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 })
  }
  if (!deliverable.trim()) return Response.json({ error: 'deliverable required' }, { status: 400 })
  if (!spec.trim()) return Response.json({ error: 'spec required' }, { status: 400 })
  if (deliverable.length > MAX_DELIVERABLE_CHARS) {
    return Response.json({ error: `deliverable too large (max ${MAX_DELIVERABLE_CHARS} chars)` }, { status: 400 })
  }
  if (spec.length > MAX_SPEC_CHARS) {
    return Response.json({ error: `spec too large (max ${MAX_SPEC_CHARS} chars)` }, { status: 400 })
  }

  const verdict = await gradeTextSubmission(
    { title: label, description: null, acceptanceCriteria: spec },
    deliverable,
    auth.userId,
  )

  // A pass earns the same signed proof a market deliverable gets. Best-effort:
  // proof storage failing never turns a pass into an error.
  let proof: { id: string; contentHash: string; attester: string } | undefined
  if (verdict.passed === true) {
    try {
      const { issueWorkProof } = await import('@/lib/work-proof-store')
      const stored = await issueWorkProof({
        jobRef: `grade-${nanoid(10)}`,
        kind: 'text',
        worker: `harness@${auth.email}`,
        requester: auth.email,
        grader: 'llm-review',
        deliverable: { text: deliverable },
      })
      if (stored) proof = { id: stored.id, contentHash: stored.proof.contentHash, attester: stored.attester }
    } catch {
      /* proof is a bonus, not a gate */
    }
  }

  return Response.json({
    // passed: true | false | null — null means grading was unavailable (no
    // LLM key on the account, provider error). Callers MUST treat null as
    // "not graded", never as a pass.
    passed: verdict.passed,
    reason: verdict.output,
    gradedAt: verdict.gradedAt,
    ...(proof ? { proof: { ...proof, url: absoluteUrl(`/proof/${proof.id}`) } } : {}),
  })
}
