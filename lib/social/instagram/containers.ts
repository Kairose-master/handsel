/**
 * Media containers — step one of every publish.
 *
 * A container is Meta's staging object: you hand it a PUBLIC media URL, Meta
 * fetches and processes the asset, and only a FINISHED container can be
 * published. Containers expire after ~24h unpublished, so a stored container
 * id is a resumable checkpoint, not a durable artifact.
 */
import { igFetch } from './client'
import { ContainerFailedError, ContainerTimeoutError } from './errors'
import type { ContainerStatus, ContainerStatusCode, InstagramConfig, PollOptions, RequestOptions } from './types'

type CreateContainerResponse = { id: string }

export type ImageContainerParams = {
  imageUrl: string
  caption?: string
  altText?: string
  /** True when this image is one slide of a carousel. */
  isCarouselItem?: boolean
}

export async function createImageContainer(
  config: InstagramConfig,
  p: ImageContainerParams,
  options?: RequestOptions,
): Promise<string> {
  const res = await igFetch<CreateContainerResponse>(
    config,
    `${config.accountId}/media`,
    {
      method: 'POST',
      params: {
        image_url: p.imageUrl,
        caption: p.caption,
        alt_text: p.altText,
        is_carousel_item: p.isCarouselItem ? true : undefined,
      },
    },
    options,
  )
  return res.id
}

export type VideoContainerParams = {
  videoUrl: string
  /** REELS is the only feed-video lane; STORIES for a story video; VIDEO only inside carousels. */
  mediaType: 'REELS' | 'STORIES' | 'VIDEO'
  caption?: string
  shareToFeed?: boolean
  coverUrl?: string
  thumbOffsetMs?: number
  isCarouselItem?: boolean
}

export async function createVideoContainer(
  config: InstagramConfig,
  p: VideoContainerParams,
  options?: RequestOptions,
): Promise<string> {
  const res = await igFetch<CreateContainerResponse>(
    config,
    `${config.accountId}/media`,
    {
      method: 'POST',
      params: {
        video_url: p.videoUrl,
        media_type: p.mediaType,
        caption: p.caption,
        share_to_feed: p.shareToFeed,
        cover_url: p.coverUrl,
        thumb_offset: p.thumbOffsetMs,
        is_carousel_item: p.isCarouselItem ? true : undefined,
      },
    },
    options,
  )
  return res.id
}

export type StoryImageContainerParams = { imageUrl: string }

export async function createStoryImageContainer(
  config: InstagramConfig,
  p: StoryImageContainerParams,
  options?: RequestOptions,
): Promise<string> {
  const res = await igFetch<CreateContainerResponse>(
    config,
    `${config.accountId}/media`,
    { method: 'POST', params: { image_url: p.imageUrl, media_type: 'STORIES' } },
    options,
  )
  return res.id
}

/** The parent container binding 2–10 already-created child containers. */
export async function createCarouselContainer(
  config: InstagramConfig,
  p: { children: string[]; caption?: string },
  options?: RequestOptions,
): Promise<string> {
  if (p.children.length < 2 || p.children.length > 10) {
    throw new Error(`Instagram carousels take 2–10 items, got ${p.children.length}`)
  }
  const res = await igFetch<CreateContainerResponse>(
    config,
    `${config.accountId}/media`,
    { method: 'POST', params: { media_type: 'CAROUSEL', children: p.children.join(','), caption: p.caption } },
    options,
  )
  return res.id
}

export async function getContainerStatus(
  config: InstagramConfig,
  containerId: string,
  options?: RequestOptions,
): Promise<ContainerStatus> {
  const res = await igFetch<{ id: string; status_code: ContainerStatusCode; status?: string }>(
    config,
    containerId,
    { params: { fields: 'status_code,status' } },
    options,
  )
  return { id: res.id, statusCode: res.status_code, status: res.status }
}

/** Images finish in seconds; video processing is minutes. Callers pick the budget. */
export const IMAGE_POLL_TIMEOUT_MS = 60_000
export const VIDEO_POLL_TIMEOUT_MS = 10 * 60_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Poll a container until it is publishable.
 *
 * - FINISHED / PUBLISHED → returns the status (PUBLISHED means a previous
 *   attempt already published it — the caller's duplicate guard needs to see
 *   that, not an error).
 * - ERROR / EXPIRED → ContainerFailedError (a NEW container is required).
 * - budget exhausted while IN_PROGRESS → ContainerTimeoutError (resumable:
 *   the same container may be polled again later).
 */
export async function waitForContainer(
  config: InstagramConfig,
  containerId: string,
  opts: PollOptions = {},
): Promise<ContainerStatus> {
  const timeoutMs = opts.timeoutMs ?? VIDEO_POLL_TIMEOUT_MS
  const start = Date.now()
  let delay = opts.initialDelayMs ?? 2000

  for (;;) {
    const status = await getContainerStatus(config, containerId, { signal: opts.signal })
    if (status.statusCode === 'FINISHED' || status.statusCode === 'PUBLISHED') return status
    if (status.statusCode === 'ERROR' || status.statusCode === 'EXPIRED') {
      throw new ContainerFailedError(containerId, status.statusCode, status.status)
    }
    const elapsed = Date.now() - start
    if (elapsed + delay > timeoutMs) throw new ContainerTimeoutError(containerId, elapsed)
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.5), 30_000)
  }
}
