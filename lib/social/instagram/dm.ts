/**
 * Comment-triggered DM (Private Replies) — the pure half.
 *
 * Everything decidable without a network or the database lives here: webhook
 * payload normalization, X-Hub-Signature-256 verification, comment triage,
 * the dedupe key, the freshness window and the template linter. The send
 * path and the durable log are in lib/social/instagram-dm-server.ts.
 *
 * The policy this module encodes by construction rather than convention:
 * a DM can only ever be addressed by comment_id, so cold outreach is not a
 * disabled feature — it is a feature this integration cannot express. One
 * message per person per campaign, ever (the dedupe key has no expiry);
 * negative or complaint comments route to a human, never to promo; and the
 * template linter refuses copy that does not name Handsel in its own words
 * (a link URL containing "handsel" does not count as self-identification).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Webhook payload normalization
// ---------------------------------------------------------------------------

export type CommentEvent = {
  commentId: string
  mediaId: string
  text: string
  fromId: string
  fromUsername: string
  /** epoch ms of the comment (entry time when the field-level ts is absent) */
  timestampMs: number
}

/**
 * Normalize a Meta comments-webhook POST body into CommentEvents. Unknown
 * shapes yield [] — the webhook route must never 500 over a payload we do
 * not recognize (Meta disables endpoints that error repeatedly).
 */
export function parseCommentWebhook(body: unknown): CommentEvent[] {
  const out: CommentEvent[] = []
  const root = body as { object?: string; entry?: unknown[] } | null
  if (!root || root.object !== 'instagram' || !Array.isArray(root.entry)) return out
  for (const entry of root.entry) {
    const e = entry as { time?: number; changes?: unknown[] }
    for (const change of e.changes ?? []) {
      const c = change as {
        field?: string
        value?: {
          id?: string
          media?: { id?: string }
          text?: string
          from?: { id?: string; username?: string }
          timestamp?: number | string
        }
      }
      if (c.field !== 'comments' || !c.value) continue
      const v = c.value
      if (!v.id || !v.from?.id) continue
      const ts = typeof v.timestamp === 'string' ? Date.parse(v.timestamp) : v.timestamp
      out.push({
        commentId: v.id,
        mediaId: v.media?.id ?? '',
        text: v.text ?? '',
        fromId: v.from.id,
        fromUsername: v.from.username ?? '',
        timestampMs:
          Number.isFinite(ts) && Number(ts) > 0 ? Number(ts) : e.time ? e.time * 1000 : Date.now(),
      })
    }
  }
  return out
}

/**
 * X-Hub-Signature-256 verification: constant-time compare, and a missing or
 * malformed header is a plain false, never a throw — the route turns false
 * into 401 and logs nothing attacker-controlled.
 */
export function verifyWebhookSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const given = signatureHeader.slice('sha256='.length)
  if (given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Triage + trigger matching
// ---------------------------------------------------------------------------

export type DmCampaign = {
  id: string
  /** case-insensitive whole-word triggers, e.g. ['proof', 'link'] */
  triggers: string[]
  /** approved template; {{username}} and {{link}} are the only variables */
  template: string
  link: string
  /** true = any comment on the campaign's media qualifies (still triaged, still deduped) */
  anyComment?: boolean
  /** restrict to specific media ids; empty/absent = all account media */
  mediaIds?: string[]
}

export type TriageVerdict = 'reply' | 'human' | 'ignore'

const NEGATIVE_MARKERS =
  /\b(scam|fraud|rug|stolen|refund|lawsuit|report(?:ed|ing)?|hate|angry|broken|doesn'?t work|worst)\b/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Route a comment: negative/complaint -> human (a promo DM under an angry
 * comment is how a brand account earns a screenshot), matching trigger ->
 * reply, everything else -> ignore. Silence is always safe; a wrong DM never is.
 */
export function triageComment(
  event: CommentEvent,
  campaigns: DmCampaign[],
  selfAccountId: string,
): { verdict: TriageVerdict; campaign?: DmCampaign; reason: string } {
  if (event.fromId === selfAccountId) return { verdict: 'ignore', reason: 'own comment (echo)' }
  if (!event.text.trim()) return { verdict: 'ignore', reason: 'empty comment' }
  if (NEGATIVE_MARKERS.test(event.text)) {
    return { verdict: 'human', reason: 'negative/complaint marker — human review' }
  }
  for (const campaign of campaigns) {
    if (campaign.mediaIds?.length && !campaign.mediaIds.includes(event.mediaId)) continue
    if (campaign.anyComment) return { verdict: 'reply', campaign, reason: 'campaign accepts any comment' }
    const text = event.text.toLowerCase()
    if (
      campaign.triggers.some(t =>
        new RegExp(`(?:^|\\W)${escapeRegExp(t.toLowerCase())}(?:$|\\W)`).test(text),
      )
    ) {
      return { verdict: 'reply', campaign, reason: `trigger matched (${campaign.id})` }
    }
  }
  return { verdict: 'ignore', reason: 'no campaign matched' }
}

// ---------------------------------------------------------------------------
// Freshness, dedupe, rate ceiling, template
// ---------------------------------------------------------------------------

/** Meta's private-reply window is 7 days; stopping at 6 never races the boundary. */
export const MAX_COMMENT_AGE_MS = 6 * 24 * 60 * 60 * 1000
/** Account-wide outbound ceiling — deliberately far under Meta's limits. */
export const MAX_DMS_PER_HOUR = 20
export const DM_MAX_CHARS = 1000

export function isCommentFresh(
  event: Pick<CommentEvent, 'timestampMs'>,
  now: number = Date.now(),
): boolean {
  return now - event.timestampMs <= MAX_COMMENT_AGE_MS
}

/** PRIMARY KEY of social_dm_log: one DM per person per campaign, forever. */
export function dmDedupeKey(fromId: string, campaignId: string): string {
  return `${campaignId}:${fromId}`
}

export function renderDmTemplate(
  campaign: DmCampaign,
  event: CommentEvent,
): { text: string; problems: string[] } {
  const problems: string[] = []
  const text = campaign.template
    .replaceAll('{{username}}', event.fromUsername || 'there')
    .replaceAll('{{link}}', campaign.link)
  if (/\{\{[^}]+\}\}/.test(text)) problems.push('template contains an unknown variable')
  if (text.length > DM_MAX_CHARS) problems.push(`rendered DM is ${text.length} chars (max ${DM_MAX_CHARS})`)
  // Self-identification must live in the words, not smuggled in via the URL.
  if (!/handsel/i.test(campaign.template.replaceAll('{{link}}', ''))) {
    problems.push('DM must self-identify as Handsel')
  }
  return { text, problems }
}
