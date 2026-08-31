/**
 * Stories: image or video, 9:16, `media_type=STORIES`.
 *
 * The API publishes PLAIN media only. Polls, stickers, music, link stickers
 * and every other interactive feature are app-only — nothing here accepts
 * them, so nothing upstream can believe they were published
 * (docs/social/instagram-brand.md states the same rule for content planning).
 */
import { createStoryImageContainer, createVideoContainer, IMAGE_POLL_TIMEOUT_MS, VIDEO_POLL_TIMEOUT_MS } from './containers'
import { publishContainerSafely } from './publish'
import type { InstagramConfig, PollOptions, PublishResult, StorySpec } from './types'

export async function createStoryContainer(config: InstagramConfig, spec: StorySpec): Promise<string> {
  if (spec.videoUrl) {
    return createVideoContainer(config, { videoUrl: spec.videoUrl, mediaType: 'STORIES' })
  }
  if (spec.imageUrl) {
    return createStoryImageContainer(config, { imageUrl: spec.imageUrl })
  }
  throw new Error('Story needs imageUrl or videoUrl')
}

export async function publishStory(
  config: InstagramConfig,
  spec: StorySpec,
  progress: { onContainer?: (id: string) => void | Promise<void> } = {},
  poll: PollOptions = {},
): Promise<PublishResult> {
  const containerId = await createStoryContainer(config, spec)
  await progress.onContainer?.(containerId)
  const timeoutMs = spec.videoUrl ? VIDEO_POLL_TIMEOUT_MS : IMAGE_POLL_TIMEOUT_MS
  return publishContainerSafely(config, containerId, { timeoutMs, ...poll })
}
