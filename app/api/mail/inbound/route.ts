import { NextResponse } from 'next/server'
import { handleInboundMail, verifyResendWebhookSignature } from '@/lib/mail-desk'

/**
 * POST /api/mail/inbound — where the mail provider's inbound webhook
 * points (Resend inbound, Postmark, Cloudflare Email Routing → Worker →
 * here). This is the Mail Desk's ear; lib/mail-desk.ts is the brain.
 *
 * Two authentication paths, in preference order:
 *
 * 1. **Resend's Svix signature** (RESEND_WEBHOOK_SECRET). A real HMAC over
 *    the exact raw bytes — same posture as lib/github-app.ts's
 *    verifyGithubSignature. Preferred whenever the provider signs, because
 *    a signature cannot leak from a URL the way ?secret= can.
 * 2. **A shared secret** (MAIL_INBOUND_SECRET), in ?secret= or the
 *    X-Mail-Secret header — the fallback for providers that do not sign.
 *
 * With neither env var set the route refuses outright: an open inbound
 * endpoint would let anyone forge "customer" emails from arbitrary
 * addresses.
 *
 * The body is read as TEXT first and only parsed after verification —
 * the HMAC is computed over the raw bytes, so re-serializing a parsed
 * object would change them and every real signature would fail.
 *
 * Always 200 for authenticated payloads, parseable or not: a 4xx/5xx makes
 * providers retry-storm, and a mail we could not serve was already answered
 * (or deliberately ignored) inside handleInboundMail.
 */
export const maxDuration = 60 // an LLM intent extraction sits inside

export async function POST(request: Request) {
  const svixSecret = process.env.RESEND_WEBHOOK_SECRET
  const sharedSecret = process.env.MAIL_INBOUND_SECRET
  if (!svixSecret && !sharedSecret) {
    return NextResponse.json(
      { error: 'Mail desk not enabled (set RESEND_WEBHOOK_SECRET or MAIL_INBOUND_SECRET)' },
      { status: 503 },
    )
  }

  const rawBody = await request.text()

  let authorized = false
  if (svixSecret) {
    authorized = verifyResendWebhookSignature(
      rawBody,
      {
        id: request.headers.get('svix-id'),
        timestamp: request.headers.get('svix-timestamp'),
        signature: request.headers.get('svix-signature'),
      },
      svixSecret,
    )
  }
  if (!authorized && sharedSecret) {
    const given = request.headers.get('x-mail-secret') ?? new URL(request.url).searchParams.get('secret')
    authorized = given === sharedSecret
  }
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let payload: unknown = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    payload = null
  }
  const outcome = await handleInboundMail(payload)
  return NextResponse.json({ ok: true, outcome: outcome.kind })
}
