/**
 * The Instagram provider behind the SocialJob queue.
 *
 * This is the ONLY place the queue's vocabulary (kinds, checkpoints,
 * failure classes) meets the Graph API's (containers, status codes, error
 * codes). It never throws for expected failures — every outcome is a typed
 * `SocialPublishOutcome` so the queue's one retry rule (social-job.ts,
 * `nextAfterFailure`) stays the single authority on what happens next.
 *
 * Resumability: the container id is checkpointed the moment it exists, so a
 * crash or poll timeout resumes THAT container instead of creating a second
 * post — `publishContainerSafely` closes the remaining duplicate window at
 * the media_publish call itself.
 */
import {
  ContainerFailedError,
  ContainerTimeoutError,
  InstagramApiError,
  createCarouselContainer,
  createImageContainer,
  createStoryContainer,
  createVideoContainer,
  getInstagramConfig,
  getMedia,
  hasQuotaFor,
  isNetworkError,
  publishContainerSafely,
  redactToken,
  waitForContainer,
  DEFAULT_API_VERSION,
  DEFAULT_GRAPH_HOST,
  IMAGE_POLL_TIMEOUT_MS,
  VIDEO_POLL_TIMEOUT_MS,
  type InstagramConfig,
  type PollOptions,
} from '@/lib/social/instagram'
import type { PublishCheckpoint, SocialJob, SocialPublishOutcome, SocialPublisher } from '@/lib/social/social-job'

/**
 * Resolve credentials: the encrypted platform_secrets KV wins (that is where
 * this repo keeps operator secrets), env vars are the documented fallback so
 * a fresh deployment works from .env alone. Lazy import keeps this module
 * loadable in tests without a database.
 */
export async function resolveInstagramConfig(): Promise<InstagramConfig | null> {
  try {
    const { getPlatformSecret } = await import('@/lib/platform-secret')
    const [token, accountId] = await Promise.all([
      getPlatformSecret('instagram_access_token'),
      getPlatformSecret('instagram_account_id'),
    ])
    if (token && accountId) {
      return {
        accessToken: token,
        accountId,
        apiVersion: process.env.INSTAGRAM_API_VERSION?.trim() || DEFAULT_API_VERSION,
        graphHost: process.env.INSTAGRAM_GRAPH_HOST?.trim() || DEFAULT_GRAPH_HOST,
      }
    }
  } catch {
    // No DB (tests, cold build) — fall through to env.
  }
  return getInstagramConfig()
}

function classifyFailure(e: unknown, token?: string): SocialPublishOutcome {
  if (e instanceof InstagramApiError) {
    return {
      ok: false,
      error: redactToken(e.message, token),
      retryable: e.isTransient,
      needsAuth: e.isAuthError,
    }
  }
  if (e instanceof ContainerFailedError) {
    // ERROR and EXPIRED both mean this container can never publish.
    return {
      ok: false,
      error: e.message,
      retryable: false,
      containerExpired: true,
    }
  }
  if (e instanceof ContainerTimeoutError) {
    // Still processing — the checkpointed container resumes next tick.
    return { ok: false, error: e.message, retryable: true }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return {
    ok: false,
    error: redactToken(msg, token),
    retryable: isNetworkError(e),
  }
}

/** Create the right container for the job's kind. Carousels also checkpoint their children. */
async function createContainerFor(
  config: InstagramConfig,
  job: SocialJob,
  checkpoint: PublishCheckpoint,
  wait?: PollOptions,
): Promise<string> {
  const p = job.payload
  switch (job.kind) {
    case 'post':
      return createImageContainer(config, {
        imageUrl: p.imageUrl!,
        caption: p.caption,
        altText: p.altText,
        isAiGenerated: p.isAiGenerated,
      })
    case 'reel':
      return createVideoContainer(config, {
        videoUrl: p.videoUrl!,
        mediaType: 'REELS',
        caption: p.caption,
        shareToFeed: p.shareToFeed,
        coverUrl: p.coverUrl,
        thumbOffsetMs: p.thumbOffsetMs,
        isAiGenerated: p.isAiGenerated,
      })
    case 'story':
      return createStoryContainer(config, {
        kind: 'story',
        imageUrl: p.imageUrl,
        videoUrl: p.videoUrl,
        isAiGenerated: p.isAiGenerated,
      })
    case 'carousel': {
      const items = p.items ?? []
      const children: string[] = []
      for (const item of items) {
        children.push(
          item.videoUrl
            ? await createVideoContainer(config, {
                videoUrl: item.videoUrl,
                mediaType: 'VIDEO',
                isCarouselItem: true,
              })
            : await createImageContainer(config, {
                imageUrl: item.imageUrl!,
                altText: item.altText,
                isCarouselItem: true,
              }),
        )
      }
      for (const id of children) await waitForContainer(config, id, wait)
      // AI disclosure goes on the parent ONLY — the API errors on children.
      const parent = await createCarouselContainer(config, {
        children,
        caption: p.caption,
        isAiGenerated: p.isAiGenerated,
      })
      await checkpoint.saveContainer(parent, children)
      return parent
    }
  }
}

/** How long one queue tick may sit waiting on Meta before checkpointing and yielding. */
export const TICK_WAIT_BUDGET_MS = 90_000

function pollTimeoutFor(job: SocialJob): number {
  const hasVideo =
    job.kind === 'reel' || Boolean(job.payload.videoUrl) || (job.payload.items ?? []).some((i) => i.videoUrl)
  return hasVideo ? VIDEO_POLL_TIMEOUT_MS : IMAGE_POLL_TIMEOUT_MS
}

/**
 * The provider body with the config already resolved — exported so tests can
 * inject a config carrying `fetchImpl` (the house DI style) without touching
 * env or globals.
 */
export async function publishWithConfig(
  config: InstagramConfig,
  job: SocialJob,
  checkpoint: PublishCheckpoint,
  poll?: PollOptions,
): Promise<SocialPublishOutcome> {
  // The queue runs inside a 300s cron budget, so one tick never waits out
  // Meta's full video-processing window: it waits up to the tick budget,
  // checkpoints, and lets ContainerTimeoutError → retryable resume the SAME
  // container next tick. (A reel can legitimately take several ticks.)
  const wait: PollOptions = poll ?? { timeoutMs: Math.min(pollTimeoutFor(job), TICK_WAIT_BUDGET_MS) }
  try {
    let containerId = job.containerId
    if (!containerId) {
      // Fresh attempt: respect the account's 100-per-24h publish window
      // BEFORE creating anything. `deferred` requeues without burning an
      // attempt — a full window is a wait, not a failure. Stories are
      // exempt from the documented quota, so they skip the check.
      if (job.kind !== 'story' && !(await hasQuotaFor(config, 1))) {
        return {
          ok: false,
          error: 'Instagram publishing quota exhausted (100 per rolling 24h) — deferred to a later tick',
          retryable: true,
          deferred: true,
        }
      }
      await checkpoint.setPhase('UPLOADING')
      containerId = await createContainerFor(config, job, checkpoint, wait)
      await checkpoint.saveContainer(containerId, job.childContainerIds ?? undefined)
    }

    await checkpoint.setPhase('PROCESSING')
    await waitForContainer(config, containerId, wait)

    await checkpoint.setPhase('PUBLISHING')
    const result = await publishContainerSafely(config, containerId, wait)

    const media = await getMedia(config, result.mediaId).catch(() => null)
    return {
      ok: true,
      remoteMediaId: result.mediaId,
      containerId,
      permalink: media?.permalink,
    }
  } catch (e) {
    return classifyFailure(e, config.accessToken)
  }
}

export const instagramPublisher: SocialPublisher = {
  platform: 'instagram',

  isConfigured: () => getInstagramConfig() !== null,

  async publish(job, checkpoint): Promise<SocialPublishOutcome> {
    const config = await resolveInstagramConfig()
    if (!config) {
      return {
        ok: false,
        error:
          'Instagram is not configured (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID unset and no platform secret stored)',
        retryable: false,
        needsAuth: true,
      }
    }
    return publishWithConfig(config, job, checkpoint)
  },
}
