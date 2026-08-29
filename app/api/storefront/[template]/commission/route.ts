import { NextResponse } from 'next/server'
import { commissionPricing } from '@/lib/storefront-pricing'
import { commissionOffice } from '@/lib/office-storefront'
import { absoluteUrl } from '@/lib/origin'

/**
 * POST /api/storefront/{template}/commission — buy a whole office run.
 *
 * Paywalled per template in middleware.ts (x402 settles the exact price
 * before this handler runs), so by the time we are here the client HAS
 * paid. Two consequences shape everything below:
 *
 *  - An unknown template was never in the middleware's price map, so a
 *    request reaching here for one arrived UNPAID — refuse it outright
 *    rather than serving a free ride through a misspelled path.
 *  - Every refusal after a real payment must come with the receipt. The
 *    commission token exists even for a failed escrow, and the response
 *    says so, because "we kept your money and told you nothing" is the one
 *    behaviour a pay-first machine economy cannot survive.
 */
export const maxDuration = 120 // hiring + on-chain escrow of a whole pipeline

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

export async function POST(request: Request, ctx: { params: Promise<{ template: string }> }) {
  const { template } = await ctx.params
  const pricing = commissionPricing(template)
  if (!pricing) {
    return NextResponse.json(
      { error: `No storefront sells "${template}". GET /api/storefront lists what is for sale.` },
      { status: 404 },
    )
  }
  // Same posture as /api/jobs/external: without the paywall this is a free
  // door into a prime's escrow funds. Refuse to run unpaid.
  if (!process.env.X402_PAY_TO) {
    return NextResponse.json({ error: 'Storefront commissions are not enabled on this deployment (X402_PAY_TO unset)' }, { status: 503 })
  }

  const { recordX402Payment } = await import('@/lib/x402-ledger')
  await recordX402Payment({ endpoint: `/api/storefront/${template}/commission`, request, amountUsd: pricing.priceUsd })

  const body = await request.json().catch(() => null)
  const scope = String(body?.scope ?? '').trim()
  if (scope.length < 20 || scope.length > 4000) {
    return NextResponse.json(
      {
        error: 'scope must be 20–4000 characters — it becomes the brief every role in the office works from.',
        note: 'Payment was received; retry with a valid scope and the SAME payer address, quoting this response, and the operator can reconcile.',
      },
      { status: 400 },
    )
  }

  const result = await commissionOffice({ templateId: template, scope, payer: payerFromHeader(request) })
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, receipt: result.token ?? null },
      { status: 409 },
    )
  }
  return NextResponse.json({
    status: 'commissioned',
    token: result.token,
    poll: absoluteUrl(`/api/storefront/commission/${result.token}`),
    note:
      'The desk is working. Poll the URL above (each poll also drives verification); when status is "completed" ' +
      'the response carries the assembled deliverable. The token is the only key — keep it.',
  })
}
