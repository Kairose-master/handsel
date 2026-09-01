/**
 * Comment-triggered DM sending — the server half of lib/social/instagram/dm.ts.
 *
 * Flow: comments webhook (app/api/webhooks/instagram) -> triage (pure) ->
 * guardrails -> ONE private reply via POST {account-id}/messages with
 * recipient {comment_id} -> durable log. Two self-migrating tables:
 * social_dm_campaigns (a campaign row exists only after a human approved its
 * template — the approval artifact) and social_dm_log, whose PRIMARY KEY
 * dedupe claim happens BEFORE the send: a crash after send leaves a claimed
 * key (no duplicate later); a crash before send leaves sent=false with an
 * error for the ops report. The reverse order risks double-sending.
 *
 * Feature gating follows the FAUCET_ENABLED/FAUCET_DISABLED convention:
 * INSTAGRAM_DM_ENABLED=true opts the mechanism in, INSTAGRAM_DM_DISABLED
 * always wins. Enabling the flag is the standing human approval for the
 * MECHANISM; per-campaign templates are approved separately (see
 * docs/social/instagram-dm-automation.md and the copy-generation prompt in
 * .claude/skills/instagram-publisher/prompts/).
 */

import { pool } from '@/lib/db'
import { getInstagramConfig, igFetch } from '@/lib/social/instagram'
import { InstagramApiError } from '@/lib/social/instagram/errors'
import {
  dmDedupeKey,
  isCommentFresh,
  MAX_DMS_PER_HOUR,
  renderDmTemplate,
  triageComment,
  type CommentEvent,
  type DmCampaign,
} from '@/lib/social/instagram/dm'

export function isDmAutomationEnabled(): boolean {
  if (process.env.INSTAGRAM_DM_DISABLED === 'true') return false
  return process.env.INSTAGRAM_DM_ENABLED === 'true'
}

export type DmResult =
  | { sent: true; commentId: string; campaignId: string }
  | { sent: false; reason: string }

let tableReadyPromise: Promise<void> | null = null

async function ensureTables(): Promise<void> {
  if (!tableReadyPromise) {
    tableReadyPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS social_dm_campaigns (
        id text PRIMARY KEY,
        triggers jsonb NOT NULL DEFAULT '[]',
        template text NOT NULL,
        link text NOT NULL,
        any_comment boolean NOT NULL DEFAULT false,
        media_ids jsonb NOT NULL DEFAULT '[]',
        enabled boolean NOT NULL DEFAULT true,
        approved_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await pool.query(`CREATE TABLE IF NOT EXISTS social_dm_log (
        dedupe_key text PRIMARY KEY,
        from_id text NOT NULL,
        from_username text,
        campaign_id text NOT NULL,
        comment_id text NOT NULL,
        media_id text,
        verdict text NOT NULL,
        sent boolean NOT NULL DEFAULT false,
        error text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
    })()
  }
  try {
    await tableReadyPromise
  } catch (e) {
    tableReadyPromise = null // un-memoize: the next caller retries the migration
    throw e
  }
}

export async function loadDmCampaigns(): Promise<DmCampaign[]> {
  await ensureTables()
  const { rows } = await pool.query(`SELECT * FROM social_dm_campaigns WHERE enabled = true`)
  return rows.map(r => ({
    id: String(r.id),
    triggers: (r.triggers as string[]) ?? [],
    template: String(r.template),
    link: String(r.link),
    anyComment: Boolean(r.any_comment),
    mediaIds: (r.media_ids as string[]) ?? [],
  }))
}

/**
 * Register an approved campaign. The template is linted here too so a bad
 * template cannot even enter the table; `approvedBy` records who stamped it.
 */
export async function addDmCampaign(
  campaign: DmCampaign,
  approvedBy: string,
): Promise<{ ok: boolean; error?: string }> {
  const lint = renderDmTemplate(campaign, {
    commentId: 'lint', mediaId: '', text: '', fromId: 'lint', fromUsername: 'lint', timestampMs: Date.now(),
  })
  if (lint.problems.length) return { ok: false, error: lint.problems.join('; ') }
  await ensureTables()
  await pool.query(
    `INSERT INTO social_dm_campaigns (id, triggers, template, link, any_comment, media_ids, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET triggers=$2, template=$3, link=$4, any_comment=$5, media_ids=$6, approved_by=$7`,
    [campaign.id, JSON.stringify(campaign.triggers), campaign.template, campaign.link,
     campaign.anyComment ?? false, JSON.stringify(campaign.mediaIds ?? []), approvedBy],
  )
  return { ok: true }
}

async function sentInLastHour(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM social_dm_log
     WHERE sent = true AND created_at > now() - interval '1 hour'`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Handle one webhook comment event end to end. Every non-send is a
 * structured reason, never a throw — the webhook route must always answer
 * 200 fast or Meta suspends the subscription.
 */
export async function handleCommentEvent(
  event: CommentEvent,
  campaigns?: DmCampaign[],
): Promise<DmResult> {
  if (!isDmAutomationEnabled()) {
    return { sent: false, reason: 'dm automation disabled (INSTAGRAM_DM_ENABLED)' }
  }
  const config = getInstagramConfig()
  if (!config) return { sent: false, reason: 'instagram not configured (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID)' }

  const list = campaigns ?? (await loadDmCampaigns())
  const triage = triageComment(event, list, config.accountId)
  if (triage.verdict !== 'reply' || !triage.campaign) {
    if (triage.verdict === 'human') {
      await ensureTables()
      await pool.query(
        `INSERT INTO social_dm_log (dedupe_key, from_id, from_username, campaign_id, comment_id, media_id, verdict, sent)
         VALUES ($1,$2,$3,'none',$4,$5,'human',false) ON CONFLICT (dedupe_key) DO NOTHING`,
        [`human:${event.commentId}`, event.fromId, event.fromUsername, event.commentId, event.mediaId],
      )
    }
    return { sent: false, reason: triage.reason }
  }
  if (!isCommentFresh(event)) return { sent: false, reason: 'comment older than the private-reply window' }

  const { text, problems } = renderDmTemplate(triage.campaign, event)
  if (problems.length) return { sent: false, reason: `template rejected: ${problems.join('; ')}` }

  await ensureTables()
  if ((await sentInLastHour()) >= MAX_DMS_PER_HOUR) {
    return { sent: false, reason: `hourly DM ceiling (${MAX_DMS_PER_HOUR}) reached` }
  }

  const key = dmDedupeKey(event.fromId, triage.campaign.id)
  const { rows } = await pool.query(
    `INSERT INTO social_dm_log (dedupe_key, from_id, from_username, campaign_id, comment_id, media_id, verdict, sent)
     VALUES ($1,$2,$3,$4,$5,$6,'reply',false)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [key, event.fromId, event.fromUsername, triage.campaign.id, event.commentId, event.mediaId],
  )
  if (rows.length === 0) return { sent: false, reason: 'already messaged for this campaign (dedupe)' }

  try {
    await igFetch(config, `${config.accountId}/messages`, {
      method: 'POST',
      params: {
        recipient: JSON.stringify({ comment_id: event.commentId }),
        message: JSON.stringify({ text }),
      },
    })
    await pool.query(`UPDATE social_dm_log SET sent = true WHERE dedupe_key = $1`, [key])
    return { sent: true, commentId: event.commentId, campaignId: triage.campaign.id }
  } catch (e) {
    const reason =
      e instanceof InstagramApiError && e.isAuthError
        ? `needs re-auth: ${e.message}`
        : String((e as Error)?.message ?? e).slice(0, 300)
    await pool.query(`UPDATE social_dm_log SET error = $2 WHERE dedupe_key = $1`, [key, reason])
    return { sent: false, reason }
  }
}
