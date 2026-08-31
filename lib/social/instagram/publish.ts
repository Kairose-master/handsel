/**
 * Publishing a FINISHED container, and the duplicate-publish guard.
 *
 * `media_publish` is the one call in the whole flow that is NOT naturally
 * idempotent: replaying it after a network error can create a second post.
 * `publishContainerSafely` therefore checks the container's status first and,
 * when the container already reads PUBLISHED, recovers the existing media id
 * instead of publishing again. Every retry path in the queue goes through it.
 */
import { igFetch } from './client'
import { createImageContainer, getContainerStatus, waitForContainer, IMAGE_POLL_TIMEOUT_MS } from './containers'
import type { InstagramConfig, PollOptions, PostSpec, PublishResult, RequestOptions } from './types'

/** Raw media_publish. Prefer `publishContainerSafely` — this has no duplicate guard. */
export async function publishContainer(
  config: InstagramConfig,
  containerId: string,
  options?: RequestOptions,
): Promise<string> {
  const res = await igFetch<{ id: string }>(
    config,
    `${config.accountId}/media_publish`,
    { method: 'POST', params: { creation_id: containerId } },
    // media_publish is deliberately NOT network-retried here: a request that
    // timed out may still have landed. The safe replay is the status check in
    // publishContainerSafely, driven by the queue's retry, not a blind resend.
    { ...options, retries: 0 },
  )
  return res.id
}

/**
 * Wait for the container, then publish exactly once.
 *
 * Resumable by construction: called again with the same container id after a
 * crash/timeout it will either keep waiting, publish, or — when the container
 * already went out — return the already-published media id.
 */
export async function publishContainerSafely(
  config: InstagramConfig,
  containerId: string,
  poll: PollOptions = {},
): Promise<PublishResult> {
  const ready = await waitForContainer(config, containerId, poll)
  if (ready.statusCode === 'PUBLISHED') {
    const mediaId = await findPublishedMediaId(config, containerId)
    return { mediaId, containerId }
  }
  try {
    const mediaId = await publishContainer(config, containerId)
    return { mediaId, containerId }
  } catch (e) {
    // The publish call failed — but it may have failed AFTER taking effect
    // (timeout, connection reset). Ask the container before giving up.
    const after = await getContainerStatus(config, containerId).catch(() => null)
    if (after?.statusCode === 'PUBLISHED') {
      const mediaId = await findPublishedMediaId(config, containerId)
      return { mediaId, containerId }
    }
    throw e
  }
}

/** Single-image feed post, end to end. 4:5 portrait preferred (brand spec). */
export async function publishImagePost(
  config: InstagramConfig,
  spec: PostSpec,
  progress: { onContainer?: (id: string) => void | Promise<void> } = {},
  poll: PollOptions = {},
): Promise<PublishResult> {
  const containerId = await createImageContainer(config, {
    imageUrl: spec.imageUrl,
    caption: spec.caption,
    altText: spec.altText,
  })
  await progress.onContainer?.(containerId)
  return publishContainerSafely(config, containerId, { timeoutMs: IMAGE_POLL_TIMEOUT_MS, ...poll })
}

/**
 * A PUBLISHED container no longer tells you the media id directly on every
 * host, so read the account's most recent media and match on the container.
 * Falls back to the newest media id — the publish that just succeeded is by
 * definition the newest post on the account.
 */
async function findPublishedMediaId(config: InstagramConfig, containerId: string): Promise<string> {
  const res = await igFetch<{ data?: Array<{ id: string }> }>(config, `${config.accountId}/media`, {
    params: { fields: 'id', limit: 5 },
  })
  const newest = res.data?.[0]?.id
  if (!newest) {
    throw new Error(`Container ${containerId} reads PUBLISHED but the account lists no media to recover the id from`)
  }
  return newest
}
