/**
 * Instagram Graph API content publishing — the types.
 *
 * Everything here mirrors the OFFICIAL Instagram Platform content-publishing
 * API (graph.instagram.com / graph.facebook.com), nothing else. No private
 * endpoints, no session-cookie automation — that is a policy decision
 * (docs/social/instagram-brand.md, Phase 10 safety rules), not a gap.
 *
 * The publish flow the whole module implements:
 *
 *   media asset → publicly reachable URL → create container →
 *   poll status until FINISHED → media_publish → store media id
 *
 * Reference: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */

/** Resolved from env by `getInstagramConfig()` — never constructed with a literal token. */
export type InstagramConfig = {
  /** Long-lived access token. NEVER logged, never echoed beyond last-4. */
  accessToken: string
  /** The IG professional account id (`IG_ID` in Meta's docs). */
  accountId: string
  /** Graph API version, e.g. 'v25.0'. */
  apiVersion: string
  /**
   * 'graph.instagram.com' for tokens from Instagram Login (business login),
   * 'graph.facebook.com' for tokens from Facebook Login for Business.
   * The publishing endpoints are the same shape on both.
   */
  graphHost: string
  /** Injectable for tests (house style — no global stubbing). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** `media_type` values the container endpoint accepts. Single images send none. */
export type ContainerMediaType = 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES' | 'CAROUSEL'

/** `status_code` values a container can report. */
export type ContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED'

export type ContainerStatus = {
  id: string
  statusCode: ContainerStatusCode
  /** Free-text detail Meta attaches alongside the code (e.g. the video error). */
  status?: string
}

/** A single feed image. 4:5 portrait preferred (docs/social/instagram-brand.md). */
export type PostSpec = {
  kind: 'post'
  imageUrl: string
  caption?: string
  /** Accessibility text. Supported by the API for images only (since 2025-03-24). */
  altText?: string
}

/** 2–10 images/videos published as one carousel. */
export type CarouselSpec = {
  kind: 'carousel'
  items: Array<{ imageUrl?: string; videoUrl?: string; altText?: string }>
  caption?: string
}

/** A Reel: vertical 9:16 MP4. */
export type ReelSpec = {
  kind: 'reel'
  videoUrl: string
  caption?: string
  /** Also surface the reel in the main feed grid. */
  shareToFeed?: boolean
  /** Custom cover image URL (mutually exclusive with thumbOffset). */
  coverUrl?: string
  /** Frame offset (ms) to use as the cover instead of coverUrl. */
  thumbOffsetMs?: number
}

/**
 * A Story: image or video, 9:16, gone in 24h. The API publishes plain media
 * only — interactive features (polls, stickers, music, links) are NOT
 * available to API-published stories and nothing here pretends otherwise.
 */
export type StorySpec = {
  kind: 'story'
  imageUrl?: string
  videoUrl?: string
}

export type PublishSpec = PostSpec | CarouselSpec | ReelSpec | StorySpec

/** What a completed publish hands back to the caller. */
export type PublishResult = {
  /** The published IG media id — the durable receipt, stored on the social job. */
  mediaId: string
  /** The container that produced it (useful for audit; expired after ~24h). */
  containerId: string
}

/** GET /{ig-id}/content_publishing_limit */
export type PublishingQuota = {
  /** Posts used in the rolling 24h window. */
  quotaUsage: number
  /** The window's total (Meta's documented ceiling is 100). */
  quotaTotal: number
  /** Duration of the window in seconds (86400). */
  quotaDurationSeconds: number
}

export type MediaInsight = {
  name: string
  period: string
  value: number
  title?: string
  description?: string
}

/** GET /{media-id}?fields=... after publish. */
export type PublishedMedia = {
  id: string
  permalink?: string
  mediaType?: string
  timestamp?: string
}

/** Options every network call accepts. */
export type RequestOptions = {
  /** Max transient-failure retries (default 3). Permanent errors never retry. */
  retries?: number
  /** First retry delay in ms (default 1000, doubling per attempt). Tests set it tiny. */
  backoffBaseMs?: number
  /** AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal
}

/** Container polling budget. Video processing is minutes, images are seconds. */
export type PollOptions = {
  /** Give up after this long (default: 60s images, 10min video/reels). */
  timeoutMs?: number
  /** First delay between polls; grows 1.5x per attempt, capped at 30s. */
  initialDelayMs?: number
  signal?: AbortSignal
}
