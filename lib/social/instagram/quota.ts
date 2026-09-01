/**
 * The publish rate limit: 100 API-published posts per rolling 24h per account
 * (a carousel counts once). The queue asks BEFORE publishing so hitting the
 * ceiling is a scheduled wait, not an error loop — the same reasoning as
 * lib/external-post-limits.ts: a limit you can read is a plan, one you can
 * only trip over is an outage.
 */
import { igFetch } from './client'
import type { InstagramConfig, PublishingQuota, RequestOptions } from './types'

export async function getPublishingQuota(
  config: InstagramConfig,
  options?: RequestOptions,
): Promise<PublishingQuota> {
  const res = await igFetch<{
    data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }>
  }>(config, `${config.accountId}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } }, options)
  const row = res.data?.[0]
  return {
    quotaUsage: row?.quota_usage ?? 0,
    quotaTotal: row?.config?.quota_total ?? 100,
    quotaDurationSeconds: row?.config?.quota_duration ?? 86400,
  }
}

/** True when at least `needed` publishes fit in the current window. */
export async function hasQuotaFor(config: InstagramConfig, needed = 1): Promise<boolean> {
  const q = await getPublishingQuota(config)
  return q.quotaUsage + needed <= q.quotaTotal
}
