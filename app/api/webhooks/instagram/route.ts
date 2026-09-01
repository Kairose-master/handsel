/**
 * GET/POST /api/webhooks/instagram — Meta's comments webhook, the trigger for
 * comment-to-DM Private Replies (lib/social/instagram-dm-server.ts).
 *
 * Two contracts to honor, both Meta's:
 *   GET  → the subscription verification handshake (echo hub.challenge when
 *          hub.verify_token matches INSTAGRAM_WEBHOOK_VERIFY_TOKEN).
 *   POST → MUST answer 200 fast, always: repeated non-2xx gets the
 *          subscription disabled. So the signature check is the only gate
 *          that rejects; everything after it is swallowed into the DM log
 *          rather than surfaced as a status code.
 *
 * Every POST byte is HMAC-verified (X-Hub-Signature-256, META_APP_SECRET)
 * before parsing — same posture as /api/github/webhook. With the DM kill
 * switch off this endpoint still 200s (Meta stays subscribed) and does
 * nothing.
 */
import { parseCommentWebhook, verifyWebhookSignature } from '@/lib/social/instagram/dm'
import { handleCommentEvent, isDmAutomationEnabled } from '@/lib/social/instagram-dm-server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  if (!expected) {
    return Response.json({ error: 'Webhook not configured (INSTAGRAM_WEBHOOK_VERIFY_TOKEN)' }, { status: 503 })
  }
  if (mode === 'subscribe' && token === expected) {
    return new Response(challenge ?? '', { status: 200 })
  }
  return Response.json({ error: 'Verification failed' }, { status: 403 })
}

export async function POST(request: Request) {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    return Response.json({ error: 'Webhook not configured (META_APP_SECRET)' }, { status: 503 })
  }
  const raw = await request.text()
  if (!verifyWebhookSignature(secret, raw, request.headers.get('x-hub-signature-256'))) {
    return Response.json({ error: 'Bad signature' }, { status: 401 })
  }
  try {
    if (isDmAutomationEnabled()) {
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }
      // Sequential on purpose: the hourly ceiling and dedupe reads race
      // under Promise.all, and a webhook batch is at most a handful.
      for (const event of parseCommentWebhook(body)) {
        await handleCommentEvent(event)
      }
    }
  } catch {
    // Outcomes live in social_dm_log; a 500 here only makes Meta retry.
  }
  return Response.json({ ok: true })
}
