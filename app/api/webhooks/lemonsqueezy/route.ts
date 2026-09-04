/**
 * POST /api/webhooks/lemonsqueezy — Lemon Squeezy telling us a Repo Care
 * pilot was bought (`docs/billing.md` has the account-side setup).
 *
 * Same posture as `/api/webhooks/instagram` and `/api/github/webhook`:
 * verify the HMAC signature over the RAW body before parsing anything, then
 * answer 200 no matter what happened after that. Lemon Squeezy retries a
 * non-2xx delivery, and a retry storm over a transient database hiccup is
 * worse than one missed lead the operator's own Lemon Squeezy dashboard
 * already emailed them about — this route is a second, queryable copy of
 * that event, not the only record of it.
 *
 * There is no `LEMONSQUEEZY_API_KEY` here on purpose: this route only reads
 * what Lemon Squeezy pushes, it never calls back to Lemon Squeezy's API, so
 * a webhook signing secret is the only credential it needs.
 */
import { parsePilotOrder, verifyLemonSqueezySignature } from '@/lib/billing'

export async function POST(request: Request) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
  if (!secret) {
    return Response.json({ error: 'Webhook not configured (LEMONSQUEEZY_WEBHOOK_SECRET)' }, { status: 503 })
  }
  const raw = await request.text()
  if (!verifyLemonSqueezySignature(raw, request.headers.get('x-signature'), secret)) {
    return Response.json({ error: 'Bad signature' }, { status: 401 })
  }
  try {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    const order = parsePilotOrder(body)
    if (order) {
      const { recordPilotLead } = await import('@/lib/billing-server')
      await recordPilotLead(order)
    }
  } catch (error) {
    // A lost lead here is not a lost sale — Lemon Squeezy's own receipt and
    // seller-notification emails are the record of truth.
    console.error('[webhooks/lemonsqueezy] failed to record order (non-fatal):', error)
  }
  return Response.json({ ok: true })
}
