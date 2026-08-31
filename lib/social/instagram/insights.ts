/**
 * Post-publish performance reads — the Analyst's half of the loop.
 * Metric names vary by media product; callers pass the set they want and
 * unknown-metric errors surface as-is (they are permanent, never retried).
 */
import { igFetch } from './client'
import type { InstagramConfig, MediaInsight, RequestOptions } from './types'

/** Sane default metric sets per media product (Meta renames these across versions — override freely). */
export const DEFAULT_MEDIA_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares'] as const
export const DEFAULT_REEL_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares', 'ig_reels_video_view_total_time'] as const

export async function getMediaInsights(
  config: InstagramConfig,
  mediaId: string,
  metrics: readonly string[] = DEFAULT_MEDIA_METRICS,
  options?: RequestOptions,
): Promise<MediaInsight[]> {
  const res = await igFetch<{
    data?: Array<{ name: string; period: string; title?: string; description?: string; values?: Array<{ value: number }> }>
  }>(config, `${mediaId}/insights`, { params: { metric: metrics.join(',') } }, options)
  return (res.data ?? []).map((m) => ({
    name: m.name,
    period: m.period,
    value: m.values?.[0]?.value ?? 0,
    title: m.title,
    description: m.description,
  }))
}
