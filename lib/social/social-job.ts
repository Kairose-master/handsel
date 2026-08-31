/**
 * SocialJob — the platform-agnostic content queue, as pure rules.
 *
 * The abstraction is deliberate (docs/social/instagram.md): a SocialJob is
 * what the queue schedules, approves and retries; a `SocialPublisher` is one
 * provider behind it. Instagram is the first provider; adding another
 * platform is a new provider, not a rewrite of the job system.
 *
 * Everything in this file is pure — status vocabulary, transition legality,
 * payload validation, the approval fingerprint, and the failure→next-state
 * rule — so the whole lifecycle is unit-testable without a database or a
 * network (the repo's stated preference: pure functions + tests over
 * untested tick code). lib/social/social-queue-server.ts is the impure half.
 */
import { createHash } from 'node:crypto'

export type SocialPlatform = 'instagram'

export type SocialJobKind = 'post' | 'carousel' | 'reel' | 'story'

/**
 * One status axis, two regimes:
 *
 * Editorial (nothing here talks to a network):
 *   DRAFT → APPROVAL_REQUIRED → READY | SCHEDULED
 * Execution (the ops-cycle tick owns these):
 *   QUEUED → PREPARING → UPLOADING → PROCESSING → PUBLISHING → PUBLISHED
 * Failure:
 *   FAILED (permanent or retries exhausted) · EXPIRED (the provider-side
 *   container died; a manual requeue starts a fresh one) · NEEDS_AUTH (the
 *   token is dead; no retry can fix it — reconnect the account).
 *
 * The approval boundary is load-bearing: no transition reaches QUEUED except
 * through READY/SCHEDULED, and READY/SCHEDULED are only reachable via
 * `approve` — generation completing is never publication (Phase 10).
 */
export type SocialJobStatus =
  | 'DRAFT'
  | 'APPROVAL_REQUIRED'
  | 'READY'
  | 'SCHEDULED'
  | 'QUEUED'
  | 'PREPARING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'EXPIRED'
  | 'NEEDS_AUTH'

/** Statuses the tick may atomically claim and start executing. */
export const CLAIMABLE_STATUSES: SocialJobStatus[] = ['READY', 'SCHEDULED', 'QUEUED']

/** Statuses that are over — nothing moves them except an explicit human requeue. */
export const TERMINAL_STATUSES: SocialJobStatus[] = ['PUBLISHED', 'FAILED', 'EXPIRED', 'NEEDS_AUTH']

/** In-flight execution phases (crash here = the sweep re-claims and resumes from the checkpoint). */
export const IN_FLIGHT_STATUSES: SocialJobStatus[] = ['PREPARING', 'UPLOADING', 'PROCESSING', 'PUBLISHING']

export const ALLOWED_TRANSITIONS: Record<SocialJobStatus, SocialJobStatus[]> = {
  DRAFT: ['APPROVAL_REQUIRED'],
  APPROVAL_REQUIRED: ['READY', 'SCHEDULED', 'DRAFT'],
  READY: ['PREPARING', 'QUEUED', 'APPROVAL_REQUIRED'],
  SCHEDULED: ['PREPARING', 'QUEUED', 'APPROVAL_REQUIRED'],
  QUEUED: ['PREPARING', 'FAILED', 'NEEDS_AUTH', 'APPROVAL_REQUIRED'],
  // PREPARING → PROCESSING directly happens on a resume (the container
  // already exists, so there is nothing to upload).
  PREPARING: ['UPLOADING', 'PROCESSING', 'QUEUED', 'FAILED', 'EXPIRED', 'NEEDS_AUTH'],
  UPLOADING: ['PROCESSING', 'QUEUED', 'FAILED', 'EXPIRED', 'NEEDS_AUTH'],
  PROCESSING: ['PUBLISHING', 'QUEUED', 'FAILED', 'EXPIRED', 'NEEDS_AUTH'],
  PUBLISHING: ['PUBLISHED', 'QUEUED', 'FAILED', 'EXPIRED', 'NEEDS_AUTH'],
  PUBLISHED: [],
  FAILED: ['QUEUED'],
  EXPIRED: ['QUEUED'],
  NEEDS_AUTH: ['QUEUED'],
}

export function canTransition(from: SocialJobStatus, to: SocialJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** What the queue stores about one piece of content. URLs must already be public. */
export type SocialJobPayload = {
  imageUrl?: string
  videoUrl?: string
  /** Carousel slides, in order. */
  items?: Array<{ imageUrl?: string; videoUrl?: string; altText?: string }>
  caption?: string
  altText?: string
  coverUrl?: string
  thumbOffsetMs?: number
  shareToFeed?: boolean
}

export type SocialJob = {
  id: string
  userId: string
  /** The office agent acting as Publisher, when one is attached — feeds the diorama's Market room. */
  agentId: string | null
  platform: SocialPlatform
  kind: SocialJobKind
  payload: SocialJobPayload
  status: SocialJobStatus
  campaign: string | null
  scheduledAt: Date | null
  approvedAt: Date | null
  approvedBy: string | null
  /** Fingerprint of the payload AS APPROVED — publish refuses on mismatch. */
  approvedFingerprint: string | null
  /** Provider-side resumable checkpoint (Instagram: the container id). */
  containerId: string | null
  /** Carousel child containers, in slide order. */
  childContainerIds: string[] | null
  remoteMediaId: string | null
  permalink: string | null
  attempts: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  publishedAt: Date | null
}

export const MAX_PUBLISH_ATTEMPTS = 4

/** Validate a payload for its kind. Returns null when fine, else the reason. */
export function validatePayload(kind: SocialJobKind, payload: SocialJobPayload): string | null {
  const urls: Array<string | undefined> = [
    payload.imageUrl,
    payload.videoUrl,
    payload.coverUrl,
    ...(payload.items ?? []).flatMap((i) => [i.imageUrl, i.videoUrl]),
  ]
  for (const u of urls) {
    if (u !== undefined && !/^https:\/\//.test(u)) {
      return `Media URLs must be public https URLs (got ${u.slice(0, 40)}…) — Instagram fetches them server-side`
    }
  }
  switch (kind) {
    case 'post':
      if (!payload.imageUrl) return 'A post needs imageUrl'
      return null
    case 'carousel': {
      const items = payload.items ?? []
      if (items.length < 2 || items.length > 10) return `A carousel needs 2–10 items, got ${items.length}`
      if (items.some((i) => !i.imageUrl && !i.videoUrl)) return 'Every carousel item needs imageUrl or videoUrl'
      return null
    }
    case 'reel':
      if (!payload.videoUrl) return 'A reel needs videoUrl'
      return null
    case 'story':
      if (!payload.imageUrl && !payload.videoUrl) return 'A story needs imageUrl or videoUrl'
      if (payload.imageUrl && payload.videoUrl) return 'A story is one image OR one video, not both'
      return null
  }
}

/**
 * What approval actually approved: the media and the words. A change to
 * either after approval MUST send the job back through approval — silently
 * replacing media behind an approval is explicitly forbidden (Phase 10), and
 * a fingerprint makes that a mechanical check instead of a promise.
 */
export function payloadFingerprint(payload: SocialJobPayload): string {
  const canonical = JSON.stringify({
    imageUrl: payload.imageUrl ?? null,
    videoUrl: payload.videoUrl ?? null,
    items: (payload.items ?? []).map((i) => ({ imageUrl: i.imageUrl ?? null, videoUrl: i.videoUrl ?? null, altText: i.altText ?? null })),
    caption: payload.caption ?? null,
    coverUrl: payload.coverUrl ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Publish-time guard: does the payload still match what was approved? */
export function approvalStillValid(job: Pick<SocialJob, 'payload' | 'approvedFingerprint'>): boolean {
  if (!job.approvedFingerprint) return false
  return payloadFingerprint(job.payload) === job.approvedFingerprint
}

/** Is this job due to execute now? */
export function isDue(job: Pick<SocialJob, 'status' | 'scheduledAt'>, now: Date = new Date()): boolean {
  if (job.status === 'READY' || job.status === 'QUEUED') return true
  if (job.status === 'SCHEDULED') return job.scheduledAt !== null && job.scheduledAt.getTime() <= now.getTime()
  return false
}

/** How one attempt ended, in provider-agnostic terms. */
export type PublishFailure = {
  error: string
  /** Transient (network, 5xx, rate limit) — another attempt can succeed. */
  retryable: boolean
  /** The token/permissions are dead — retrying is harmful, reconnect instead. */
  needsAuth?: boolean
  /** The provider-side container is unusable — a fresh attempt needs a new one. */
  containerExpired?: boolean
  /**
   * Not a failure of THIS job at all (e.g. the account's publish quota is
   * full): requeue without counting an attempt, so waiting out a window
   * cannot exhaust the retry budget.
   */
  deferred?: boolean
}

/**
 * The one retry rule, applied by the server after every failed attempt:
 * auth failures park at NEEDS_AUTH immediately; an expired/errored container
 * parks at EXPIRED (its checkpoint must be discarded); transient failures
 * requeue until MAX_PUBLISH_ATTEMPTS, then FAILED; permanent errors FAIL on
 * the first strike — blindly replaying a validation error can never succeed.
 */
export function nextAfterFailure(
  job: Pick<SocialJob, 'attempts'>,
  failure: PublishFailure,
  maxAttempts: number = MAX_PUBLISH_ATTEMPTS,
): { status: SocialJobStatus; attempts: number; clearContainer: boolean } {
  if (failure.deferred) return { status: 'QUEUED', attempts: job.attempts, clearContainer: false }
  const attempts = job.attempts + 1
  if (failure.needsAuth) return { status: 'NEEDS_AUTH', attempts, clearContainer: false }
  if (failure.containerExpired) return { status: 'EXPIRED', attempts, clearContainer: true }
  if (failure.retryable && attempts < maxAttempts) return { status: 'QUEUED', attempts, clearContainer: false }
  return { status: 'FAILED', attempts, clearContainer: false }
}

/** Outcome a provider returns. Providers NEVER throw for expected failures. */
export type SocialPublishOutcome =
  | { ok: true; remoteMediaId: string; containerId?: string; permalink?: string }
  | ({ ok: false } & PublishFailure)

/** Checkpoints the provider reports mid-flight so a crash resumes instead of duplicating. */
export type PublishCheckpoint = {
  /** Persist the provider-side container id(s) the moment they exist. */
  saveContainer: (containerId: string, childContainerIds?: string[]) => Promise<void>
  /** Move the job through the in-flight phases (UPLOADING → PROCESSING → PUBLISHING). */
  setPhase: (phase: 'UPLOADING' | 'PROCESSING' | 'PUBLISHING') => Promise<void>
}

/** One provider = one platform. The queue is the only caller. */
export interface SocialPublisher {
  platform: SocialPlatform
  /** False ⇒ every job for this platform parks at NEEDS_AUTH-style refusal without network calls. */
  isConfigured: () => boolean | Promise<boolean>
  publish: (job: SocialJob, checkpoint: PublishCheckpoint) => Promise<SocialPublishOutcome>
}
