/**
 * Carousel publishing: N child containers → one parent → publish once.
 *
 * The expensive part is the children (each is a media fetch + process on
 * Meta's side), so the orchestration reports the ids it created as it goes —
 * the queue stores them and a retry resumes from the parent instead of
 * re-creating ten children (and burning quota-adjacent processing time).
 */
import { createCarouselContainer, createImageContainer, createVideoContainer, waitForContainer, IMAGE_POLL_TIMEOUT_MS, VIDEO_POLL_TIMEOUT_MS } from './containers'
import { publishContainerSafely } from './publish'
import type { CarouselSpec, InstagramConfig, PollOptions, PublishResult } from './types'

export type CarouselProgress = {
  /** Child container ids in slide order, reported as soon as they exist. */
  onChildren?: (ids: string[]) => void | Promise<void>
  /** The parent container id, reported before the final publish. */
  onContainer?: (id: string) => void | Promise<void>
}

export async function publishCarousel(
  config: InstagramConfig,
  spec: CarouselSpec,
  progress: CarouselProgress = {},
  poll: PollOptions = {},
): Promise<PublishResult> {
  if (spec.items.length < 2 || spec.items.length > 10) {
    throw new Error(`Instagram carousels take 2–10 items, got ${spec.items.length}`)
  }

  let hasVideo = false
  const children: string[] = []
  for (const item of spec.items) {
    if (item.videoUrl) {
      hasVideo = true
      children.push(await createVideoContainer(config, { videoUrl: item.videoUrl, mediaType: 'VIDEO', isCarouselItem: true }))
    } else if (item.imageUrl) {
      children.push(await createImageContainer(config, { imageUrl: item.imageUrl, altText: item.altText, isCarouselItem: true }))
    } else {
      throw new Error('Carousel item needs imageUrl or videoUrl')
    }
  }
  await progress.onChildren?.(children)

  const childTimeout = poll.timeoutMs ?? (hasVideo ? VIDEO_POLL_TIMEOUT_MS : IMAGE_POLL_TIMEOUT_MS)
  for (const id of children) {
    await waitForContainer(config, id, { ...poll, timeoutMs: childTimeout })
  }

  const parent = await createCarouselContainer(config, { children, caption: spec.caption })
  await progress.onContainer?.(parent)

  return publishContainerSafely(config, parent, { ...poll, timeoutMs: childTimeout })
}
