import { NextResponse } from 'next/server'
import { handleInboundMail } from '@/lib/mail-desk'

/**
 * POST /api/mail/inbound — where the mail provider's inbound webhook
 * points (Resend inbound, Postmark, Cloudflare Email Routing → Worker →
 * here). This is the Mail Desk's ear; lib/mail-desk.ts is the brain.
 *
 * Auth is a shared secret in the URL (?secret=) or X-Mail-Secret header —
 * the standard posture for provider webhooks that cannot do OAuth. Without
 * MAIL_INBOUND_SECRET set the route refuses outright: an open inbound
 * endpoint would let anyone forge "customer" emails from arbitrary
 * addresses.
 *
 * Always 200 for authenticated payloads, parseable or not: a 4xx/5xx makes
 * providers retry-storm, and a mail we could not serve was already answered
 * (or deliberately ignored) inside handleInboundMail.
 */
export const maxDuration = 60 // an LLM intent extraction sits inside

export async function POST(request: Request) {
  const secret = process.env.MAIL_INBOUND_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Mail desk not enabled (MAIL_INBOUND_SECRET unset)' }, { status: 503 })
  }
  const url = new URL(request.url)
  const given = request.headers.get('x-mail-secret') ?? url.searchParams.get('secret')
  if (given !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const payload = await request.json().catch(() => null)
  const outcome = await handleInboundMail(payload)
  return NextResponse.json({ ok: true, outcome: outcome.kind })
}
