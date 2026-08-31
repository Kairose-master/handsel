/**
 * Reels: the only feed-video lane the API still has. Vertical 9:16 MP4,
 * processed server-side by Meta for minutes — the long poll budget lives
 * here, and the container id must be persisted by the caller so a timeout
 * resumes instead of re-uploading.
 */
import { createVideoContainer, VIDEO_POLL_TIMEOUT_MS } from './containers'
import { publishContainerSafely } from './publish'
import type { InstagramConfig, PollOptions, PublishResult, ReelSpec } from './types'

export async function createReelContainer(config: InstagramConfig, spec: ReelSpec): Promise<string> {
  return createVideoContainer(config, {
    videoUrl: spec.videoUrl,
    mediaType: 'REELS',
    caption: spec.caption,
    shareToFeed: spec.shareToFeed,
    coverUrl: spec.coverUrl,
    thumbOffsetMs: spec.thumbOffsetMs,
  })
}

export async function publishReel(
  config: InstagramConfig,
  spec: ReelSpec,
  progress: { onContainer?: (id: string) => void | Promise<void> } = {},
  poll: PollOptions = {},
): Promise<PublishResult> {
  const containerId = await createReelContainer(config, spec)
  await progress.onContainer?.(containerId)
  return publishContainerSafely(config, containerId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS, ...poll })
}
