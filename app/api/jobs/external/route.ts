import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { and, count, eq, gte, isNotNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'
import { absoluteUrl } from '@/lib/origin'

/**
 * POST /api/jobs/external — demand from OUTSIDE, no account required.
 *
 * An external agent (or human with a wallet) pays the posting fee over
 * x402 (see middleware.ts — this route is paywalled when X402_PAY_TO is
 * set) and the platform's house requester agent escrows the bounty on the
 * Labor Market on their behalf. That makes the demand side of the market
 * reachable by any x402-capable client on the internet: no signup, no
 * API key, one paid HTTP request.
 *
 * Testnet economics are deliberately fixed-price: fee $0.10 (real x402
 * settlement on Base Sepolia) buys a $25 mUSDC bounty fronted by the
 * house agent. On mainnet this becomes bounty pass-through; the flow
 * stays identical.
 *
 * Body: { title, description?, acceptance_criteria, test_code?, min_score? }
 */
export const maxDuration = 60 // on-chain escrow inside the request

const FIXED_BOUNTY_USD = 25
const DEFAULT_MIN_SCORE = 200
const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md'

/** Best-effort payer extraction from the x402 payment header (the signed
 *  EIP-3009 authorization carries the payer as `from`). Attribution only. */
function payerFromHeader(request: Request): string | null {
  try {
    const raw = request.headers.get('x-payment')
    if (!raw) return null
    const payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    const from = payload?.payload?.authorization?.from
    return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  // Without the paywall this endpoint would be a free-spam hole into the
  // house agent's escrow funds — refuse to run unpaid.
  if (!process.env.X402_PAY_TO) {
    return Response.json(
      {
        error: 'External job posting is not enabled on this deployment (X402_PAY_TO unset)',
        docs: DOCS_URL,
      },
      { status: 503 },
    )
  }

  const { recordX402Payment } = await import('@/lib/x402-ledger')
  await recordX402Payment({ endpoint: '/api/jobs/external', request, amountUsd: 0.1 })

  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
  if (!houseAgentId) {
    return Response.json(
      { error: 'External job posting is not configured (X402_JOB_REQUESTER_AGENT_ID unset)' },
      { status: 503 },
    )
  }

  const body = await request.json().catch(() => null)
  const title = String(body?.title ?? '').trim()
  const description = String(body?.description ?? '').trim()
  const acceptanceCriteria = String(body?.acceptance_criteria ?? '').trim()
  const testCode = String(body?.test_code ?? '').trim()
  const minScore = Math.max(0, Math.min(900, Math.round(Number(body?.min_score) || DEFAULT_MIN_SCORE)))

  if (title.length < 3 || title.length > 200) {
    return Response.json({ error: 'title must be 3–200 characters' }, { status: 400 })
  }
  if (acceptanceCriteria.length < 10) {
    return Response.json(
      { error: 'acceptance_criteria must be specific enough to grade (10+ characters)' },
      { status: 400 },
    )
  }
  if (description.length > 4000 || testCode.length > 20_000) {
    return Response.json({ error: 'description or test_code too long' }, { status: 400 })
  }

  const [house] = await db
    .select({ smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.id, houseAgentId))
  if (!house?.smartAccountAddress) {
    return Response.json({ error: 'House requester agent is not provisioned' }, { status: 503 })
  }

  // The paywall is a PRICE, not a rate limit — and here the price is inverted,
  // because $0.10 buys $25 of house-escrowed bounty. Cap it. See
  // lib/external-post-limits.ts for what a few dollars of spend actually buys.
  const externalPoster = payerFromHeader(request)
  const {
    externalPostAllowed,
    utcDayStart,
    UNATTRIBUTED_PAYER,
  } = await import('@/lib/external-post-limits')
  const dayStart = utcDayStart()
  const payerKey = externalPoster ?? UNATTRIBUTED_PAYER
  const [[payerRow], [globalRow]] = await Promise.all([
    db
      .select({ n: count() })
      .from(jobSpec)
      .where(and(eq(jobSpec.externalPoster, payerKey), gte(jobSpec.createdAt, dayStart))),
    db
      .select({ n: count() })
      .from(jobSpec)
      .where(and(isNotNull(jobSpec.externalPoster), gte(jobSpec.createdAt, dayStart))),
  ])
  const allowance = externalPostAllowed({
    payerToday: Number(payerRow?.n ?? 0),
    globalToday: Number(globalRow?.n ?? 0),
  })
  if (!allowance.ok) {
    // 429, not 402: paying again would not help, and saying so plainly is the
    // difference between a client backing off and a client retrying forever.
    return Response.json({ error: allowance.reason, scope: allowance.scope, docs: DOCS_URL }, { status: 429 })
  }

  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) {
      return Response.json({ error: 'Labor market is not configured on this deployment' }, { status: 503 })
    }

    // Externally-posted jobs rarely declare a deliverable kind, so infer it
    // from the ask — otherwise a "design a logo" job defaults to 'text' and a
    // text-only worker claims it and fails grading.
    const { inferDeliverableKind } = await import('@/lib/artifacts')
    const { sealForInsert } = await import('@/lib/spec-hash')
    const sealed = sealForInsert(
      houseAgentId,
      {
        title,
        description: description || null,
        acceptanceCriteria,
        testCode: testCode || null,
        deliverableKind: inferDeliverableKind(title, description, acceptanceCriteria),
      },
      nanoid(),
    )
    const specHash = sealed.specHash
    await db.insert(jobSpec).values({
      ...sealed,
      requesterAgentId: houseAgentId,
      // Always attributed, even when the header could not be parsed — an
      // unattributable post still has to count against a bucket.
      externalPoster: payerKey,
      autoApprove: true, // the house agent has no owner who'll ever click Approve
    })

    const { postJob } = await import('@/lib/onchain/labor')
    const txHash = await postJob(houseAgentId, FIXED_BOUNTY_USD, minScore, specHash)

    await logPlatformEvent(
      'JOB_POSTED',
      `External job "${title}" posted via x402${externalPoster ? ` by ${externalPoster.slice(0, 6)}…${externalPoster.slice(-4)}` : ''} — $${FIXED_BOUNTY_USD} bounty`,
    )

    return Response.json({
      status: 'posted',
      bounty_usd: FIXED_BOUNTY_USD,
      min_score: minScore,
      escrow_tx: txHash,
      auto_graded: Boolean(testCode),
      watch: absoluteUrl('/guest'),
    })
  } catch (error) {
    // A pending escrow was accepted by the bundler and usually lands. A 500
    // tells the caller to retry, and their retry carries a NEW x402 payment,
    // so they would be charged twice and the house would escrow $50 for one
    // job. 202 with an explicit "do not retry" instead.
    const { isUserOpPending } = await import('@/lib/onchain/account')
    if (isUserOpPending(error)) {
      console.warn('[jobs/external] escrow pending confirmation — answering 202')
      return Response.json(
        {
          status: 'pending',
          bounty_usd: FIXED_BOUNTY_USD,
          message: 'Escrow submitted and confirming on-chain. Do NOT retry — a retry posts a second job and charges you again.',
          watch: absoluteUrl('/guest'),
        },
        { status: 202 },
      )
    }
    console.error('[jobs/external] posting failed:', error)
    return Response.json(
      { error: `Posting failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    )
  }
}
