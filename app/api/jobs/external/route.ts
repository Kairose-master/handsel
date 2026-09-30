import { createExternalJob } from '@/lib/external-job-create'
import { externalJobPricing, PRICE_ENV, BOUNTY_ENV } from '@/lib/external-job-pricing'

/**
 * POST /api/jobs/external — existing Base x402 adapter for external job posting.
 * The shared posting/escrow business logic also backs the XRPL merchant route.
 */
export const maxDuration = 60
const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md'

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
  if (!process.env.X402_PAY_TO) {
    return Response.json({ error: 'External job posting is not enabled on this deployment (X402_PAY_TO unset)', docs: DOCS_URL }, { status: 503 })
  }
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  const pricing = externalJobPricing({
    isRealMoney: isRealMoney(),
    price: process.env[PRICE_ENV],
    bounty: process.env[BOUNTY_ENV],
  })
  if (!pricing.open) return Response.json({ error: pricing.reason, docs: DOCS_URL }, { status: 503 })

  const { recordX402Payment } = await import('@/lib/x402-ledger')
  await recordX402Payment({ endpoint: '/api/jobs/external', request, amountUsd: pricing.priceUsd })
  const payer = payerFromHeader(request)
  return createExternalJob({
    body: await request.json().catch(() => null),
    payerKey: payer ?? 'unattributed',
    externalPoster: payer ?? 'unattributed',
    pricing,
  })
}
