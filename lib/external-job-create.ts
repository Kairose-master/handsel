/** Shared business path for paid external job adapters (Base x402 and XRPL x402). */
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { and, count, eq, gte, isNotNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'
import { absoluteUrl } from '@/lib/origin'
import { DEFAULT_MIN_SCORE } from '@/lib/market-reach'
import type { ExternalJobPricing } from '@/lib/external-job-pricing'

const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md'

export async function externalJobInputError(bodyValue: unknown): Promise<Response | null> {
  const body = bodyValue as Record<string, unknown> | null
  const title = String(body?.title ?? '').trim()
  const description = String(body?.description ?? '').trim()
  const acceptanceCriteria = String(body?.acceptance_criteria ?? '').trim()
  const testCode = String(body?.test_code ?? '').trim()
  if (body?.split !== undefined && body?.split !== null) {
    const { parseSplitSpec } = await import('@/lib/settlement-split')
    const parsed = parseSplitSpec(body.split)
    if (!parsed.ok) return Response.json({ error: parsed.error, docs: DOCS_URL }, { status: 400 })
  }
  if (title.length < 3 || title.length > 200) return Response.json({ error: 'title must be 3–200 characters' }, { status: 400 })
  if (acceptanceCriteria.length < 10) {
    return Response.json({ error: 'acceptance_criteria must be specific enough to grade (10+ characters)' }, { status: 400 })
  }
  if (description.length > 4000 || testCode.length > 20_000) return Response.json({ error: 'description or test_code too long' }, { status: 400 })
  return null
}

export async function createExternalJob(input: {
  body: unknown
  payerKey: string
  externalPoster: string
  pricing: Extract<ExternalJobPricing, { open: true }>
}): Promise<Response> {
  const body = input.body as Record<string, unknown> | null
  const title = String(body?.title ?? '').trim()
  const description = String(body?.description ?? '').trim()
  const acceptanceCriteria = String(body?.acceptance_criteria ?? '').trim()
  const testCode = String(body?.test_code ?? '').trim()
  const minScore = Math.max(0, Math.min(900, Math.round(Number(body?.min_score) || DEFAULT_MIN_SCORE)))

  const inputError = await externalJobInputError(body)
  if (inputError) return inputError

  let splitSpec: unknown = null
  if (body?.split !== undefined && body?.split !== null) {
    const { parseSplitSpec } = await import('@/lib/settlement-split')
    const parsed = parseSplitSpec(body.split)
    if (!parsed.ok) return Response.json({ error: parsed.error, docs: DOCS_URL }, { status: 400 })
    splitSpec = parsed.spec
  }
  if (title.length < 3 || title.length > 200) return Response.json({ error: 'title must be 3–200 characters' }, { status: 400 })
  if (acceptanceCriteria.length < 10) {
    return Response.json({ error: 'acceptance_criteria must be specific enough to grade (10+ characters)' }, { status: 400 })
  }
  if (description.length > 4000 || testCode.length > 20_000) {
    return Response.json({ error: 'description or test_code too long' }, { status: 400 })
  }

  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
  if (!houseAgentId) return Response.json({ error: 'External job posting is not configured (X402_JOB_REQUESTER_AGENT_ID unset)' }, { status: 503 })
  const [house] = await db.select({ smartAccountAddress: agent.smartAccountAddress }).from(agent).where(eq(agent.id, houseAgentId))
  if (!house?.smartAccountAddress) return Response.json({ error: 'House requester agent is not provisioned' }, { status: 503 })

  const { externalPostAllowed, utcDayStart, UNATTRIBUTED_PAYER } = await import('@/lib/external-post-limits')
  const dayStart = utcDayStart()
  const payerBucket = input.payerKey || UNATTRIBUTED_PAYER
  const [[payerRow], [globalRow]] = await Promise.all([
    db.select({ n: count() }).from(jobSpec).where(and(eq(jobSpec.externalPoster, payerBucket), gte(jobSpec.createdAt, dayStart))),
    db.select({ n: count() }).from(jobSpec).where(and(isNotNull(jobSpec.externalPoster), gte(jobSpec.createdAt, dayStart))),
  ])
  const allowance = externalPostAllowed({ payerToday: Number(payerRow?.n ?? 0), globalToday: Number(globalRow?.n ?? 0) })
  if (!allowance.ok) return Response.json({ error: allowance.reason, scope: allowance.scope, docs: DOCS_URL }, { status: 429 })

  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) return Response.json({ error: 'Labor market is not configured on this deployment' }, { status: 503 })
    const { inferDeliverableKind } = await import('@/lib/artifacts')
    const { sealForInsert } = await import('@/lib/spec-hash')
    const sealed = sealForInsert(houseAgentId, {
      title,
      description: description || null,
      acceptanceCriteria,
      testCode: testCode || null,
      deliverableKind: inferDeliverableKind(title, description, acceptanceCriteria),
    }, nanoid())
    await db.insert(jobSpec).values({
      ...sealed,
      ...(splitSpec ? { splitSpec } : {}),
      requesterAgentId: houseAgentId,
      externalPoster: input.externalPoster,
      autoApprove: true,
    })
    const { postJob } = await import('@/lib/onchain/labor')
    const txHash = await postJob(houseAgentId, input.pricing.bountyUsd, minScore, sealed.specHash)
    const payerAddress = input.externalPoster.startsWith('xrpl:') ? input.externalPoster.slice(5) : input.externalPoster
    const payerLabel = payerAddress === 'unattributed' ? null : `${payerAddress.slice(0, 6)}…${payerAddress.slice(-4)}`
    await logPlatformEvent(
      'JOB_POSTED',
      `External job "${title}" posted via x402${payerLabel ? ` by ${payerLabel}` : ''} — $${input.pricing.bountyUsd} bounty`,
    )
    return Response.json({ status: 'posted', bounty_usd: input.pricing.bountyUsd, min_score: minScore, escrow_tx: txHash, auto_graded: Boolean(testCode), watch: absoluteUrl('/guest') })
  } catch (error) {
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (isUserOpPending(error)) {
      console.warn('[jobs/external] escrow pending confirmation — answering 202')
      return Response.json({
        status: 'pending',
        bounty_usd: input.pricing.bountyUsd,
        message: 'Escrow submitted and confirming on-chain. Do NOT retry — a retry posts a second job and charges you again.',
        watch: absoluteUrl('/guest'),
      }, { status: 202 })
    }
    console.error('[jobs/external] posting failed:', error)
    return Response.json({ error: `Posting failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 })
  }
}
