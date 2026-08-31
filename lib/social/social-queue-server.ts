/**
 * The social content queue — the impure half of lib/social/social-job.ts.
 *
 * Self-migrating (CREATE TABLE IF NOT EXISTS on first use, the
 * work-proof-store pattern), ticked by the ops cycle (`socialQueue` step,
 * NOT fast — it publishes to the outside world), and driven entirely by the
 * pure rules in social-job.ts: this file only fetches rows, claims them
 * atomically, and applies whatever the rules say.
 *
 * Duplicate-publish prevention is layered:
 *  1. an atomic UPDATE…WHERE status IN (claimable) claims a job — two
 *     concurrent ticks cannot both execute it;
 *  2. the provider checkpoints its container id the moment it exists, so a
 *     retry resumes that container instead of creating a second one;
 *  3. publishContainerSafely re-reads container state before media_publish.
 */
import { pool } from '@/lib/db'
import { nanoid } from 'nanoid'
import {
  approvalStillValid,
  canTransition,
  nextAfterFailure,
  payloadFingerprint,
  validatePayload,
  CLAIMABLE_STATUSES,
  IN_FLIGHT_STATUSES,
  MAX_PUBLISH_ATTEMPTS,
  type PublishCheckpoint,
  type SocialJob,
  type SocialJobKind,
  type SocialJobPayload,
  type SocialJobStatus,
  type SocialPlatform,
  type SocialPublisher,
} from '@/lib/social/social-job'

/** Jobs processed per tick — video polling is slow and the cron budget is 300s. */
const TICK_BATCH = 2

/** An in-flight job untouched this long is a crashed tick; requeue it (its checkpoint resumes). */
const STUCK_IN_FLIGHT_MS = 15 * 60_000

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS social_jobs (
       id text PRIMARY KEY,
       user_id text NOT NULL,
       agent_id text,
       platform text NOT NULL,
       kind text NOT NULL,
       payload jsonb NOT NULL,
       status text NOT NULL,
       campaign text,
       scheduled_at timestamptz,
       approved_at timestamptz,
       approved_by text,
       approved_fingerprint text,
       container_id text,
       child_container_ids jsonb,
       remote_media_id text,
       permalink text,
       attempts integer NOT NULL DEFAULT 0,
       last_error text,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now(),
       published_at timestamptz
     )`,
  )
  await pool.query(`CREATE INDEX IF NOT EXISTS social_jobs_status_idx ON social_jobs (status, scheduled_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS social_jobs_user_idx ON social_jobs (user_id, created_at DESC)`)
}

type Row = {
  id: string
  user_id: string
  agent_id: string | null
  platform: SocialPlatform
  kind: SocialJobKind
  payload: SocialJobPayload
  status: SocialJobStatus
  campaign: string | null
  scheduled_at: Date | null
  approved_at: Date | null
  approved_by: string | null
  approved_fingerprint: string | null
  container_id: string | null
  child_container_ids: string[] | null
  remote_media_id: string | null
  permalink: string | null
  attempts: number
  last_error: string | null
  created_at: Date
  updated_at: Date
  published_at: Date | null
}

function toJob(r: Row): SocialJob {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id,
    platform: r.platform,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    campaign: r.campaign,
    scheduledAt: r.scheduled_at,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    approvedFingerprint: r.approved_fingerprint,
    containerId: r.container_id,
    childContainerIds: r.child_container_ids,
    remoteMediaId: r.remote_media_id,
    permalink: r.permalink,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  }
}

/** Provider registry. One entry per platform; the tick looks up by job.platform. */
async function publisherFor(platform: SocialPlatform): Promise<SocialPublisher | null> {
  if (platform === 'instagram') {
    const { instagramPublisher } = await import('@/lib/social/instagram-publisher')
    return instagramPublisher
  }
  return null
}

export async function createSocialJob(input: {
  userId: string
  platform: SocialPlatform
  kind: SocialJobKind
  payload: SocialJobPayload
  campaign?: string
  scheduledAt?: Date
  agentId?: string
  /** true parks it as DRAFT (not yet submitted for approval). */
  draft?: boolean
}): Promise<{ job?: SocialJob; error?: string }> {
  const invalid = validatePayload(input.kind, input.payload)
  if (invalid) return { error: invalid }
  await ensureTable()
  const id = `soc_${nanoid(12)}`
  // Everything enters through the approval gate: generation completing is
  // never publication. DRAFT is the only alternative entry state.
  const status: SocialJobStatus = input.draft ? 'DRAFT' : 'APPROVAL_REQUIRED'
  const { rows } = await pool.query(
    `INSERT INTO social_jobs (id, user_id, agent_id, platform, kind, payload, status, campaign, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      id,
      input.userId,
      input.agentId ?? null,
      input.platform,
      input.kind,
      JSON.stringify(input.payload),
      status,
      input.campaign ?? null,
      input.scheduledAt ?? null,
    ],
  )
  return { job: toJob(rows[0] as Row) }
}

export async function listSocialJobs(userId: string, limit = 50): Promise<SocialJob[]> {
  await ensureTable()
  const { rows } = await pool.query(
    `SELECT * FROM social_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  )
  return (rows as Row[]).map(toJob)
}

export async function getSocialJob(id: string, userId?: string): Promise<SocialJob | null> {
  await ensureTable()
  const { rows } = await pool.query(
    userId ? `SELECT * FROM social_jobs WHERE id = $1 AND user_id = $2` : `SELECT * FROM social_jobs WHERE id = $1`,
    userId ? [id, userId] : [id],
  )
  return rows[0] ? toJob(rows[0] as Row) : null
}

/** DRAFT → APPROVAL_REQUIRED (submit for review). */
export async function submitSocialJob(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const job = await getSocialJob(id, userId)
  if (!job) return { ok: false, error: 'Not found' }
  if (!canTransition(job.status, 'APPROVAL_REQUIRED')) return { ok: false, error: `Cannot submit from ${job.status}` }
  await pool.query(`UPDATE social_jobs SET status = 'APPROVAL_REQUIRED', updated_at = now() WHERE id = $1`, [id])
  return { ok: true }
}

/**
 * The human approval — the only door to the executable states. Records WHO
 * approved and a fingerprint of exactly WHAT they approved; the tick refuses
 * to publish a payload whose fingerprint has drifted since.
 */
export async function approveSocialJob(
  id: string,
  userId: string,
  approvedBy: string,
  scheduledAt?: Date | null,
): Promise<{ ok: boolean; error?: string }> {
  const job = await getSocialJob(id, userId)
  if (!job) return { ok: false, error: 'Not found' }
  const when = scheduledAt === undefined ? job.scheduledAt : scheduledAt
  const target: SocialJobStatus = when && when.getTime() > Date.now() ? 'SCHEDULED' : 'READY'
  if (!canTransition(job.status, target)) return { ok: false, error: `Cannot approve from ${job.status}` }
  await pool.query(
    `UPDATE social_jobs SET status = $2, scheduled_at = $3, approved_at = now(), approved_by = $4,
       approved_fingerprint = $5, last_error = NULL, updated_at = now() WHERE id = $1`,
    [id, target, when, approvedBy, payloadFingerprint(job.payload)],
  )
  return { ok: true }
}

/**
 * Edit content. ALWAYS voids any standing approval — the next state is
 * APPROVAL_REQUIRED no matter where the job was, because approved-then-
 * silently-changed is the exact failure mode the fingerprint exists to stop.
 * Refused while in flight or after publish.
 */
export async function updateSocialJobPayload(
  id: string,
  userId: string,
  payload: SocialJobPayload,
): Promise<{ ok: boolean; error?: string }> {
  const job = await getSocialJob(id, userId)
  if (!job) return { ok: false, error: 'Not found' }
  if (IN_FLIGHT_STATUSES.includes(job.status) || job.status === 'PUBLISHED') {
    return { ok: false, error: `Cannot edit a ${job.status} job` }
  }
  const invalid = validatePayload(job.kind, payload)
  if (invalid) return { ok: false, error: invalid }
  await pool.query(
    `UPDATE social_jobs SET payload = $2, status = 'APPROVAL_REQUIRED', approved_at = NULL, approved_by = NULL,
       approved_fingerprint = NULL, container_id = NULL, child_container_ids = NULL, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(payload)],
  )
  return { ok: true }
}

/** FAILED / EXPIRED / NEEDS_AUTH → QUEUED, by explicit human request. EXPIRED discards the dead container. */
export async function requeueSocialJob(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const job = await getSocialJob(id, userId)
  if (!job) return { ok: false, error: 'Not found' }
  if (!canTransition(job.status, 'QUEUED')) return { ok: false, error: `Cannot requeue from ${job.status}` }
  if (!approvalStillValid(job)) return { ok: false, error: 'Approval fingerprint missing or stale — re-approve first' }
  const clearContainer = job.status === 'EXPIRED'
  await pool.query(
    `UPDATE social_jobs SET status = 'QUEUED', attempts = 0, last_error = NULL,
       container_id = CASE WHEN $2 THEN NULL ELSE container_id END,
       child_container_ids = CASE WHEN $2 THEN NULL ELSE child_container_ids END,
       updated_at = now() WHERE id = $1`,
    [id, clearContainer],
  )
  return { ok: true }
}

/** Delete a job that is not mid-publish. Terminal and editorial states only. */
export async function deleteSocialJob(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const job = await getSocialJob(id, userId)
  if (!job) return { ok: false, error: 'Not found' }
  if (IN_FLIGHT_STATUSES.includes(job.status)) return { ok: false, error: `Cannot delete a ${job.status} job` }
  await pool.query(`DELETE FROM social_jobs WHERE id = $1`, [id])
  return { ok: true }
}

async function setStatus(id: string, status: SocialJobStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()']
  const params: unknown[] = [id, status]
  for (const [col, val] of Object.entries(extra)) {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
  await pool.query(`UPDATE social_jobs SET ${sets.join(', ')} WHERE id = $1`, params)
}

/**
 * One queue tick, called from the ops cycle. Sequential on purpose — the
 * slow part is Meta processing video, and TICK_BATCH bounds the wall clock.
 */
export async function tickSocialQueue(): Promise<string> {
  await ensureTable()

  // Requeue crashed in-flight jobs; their checkpointed container resumes.
  // Attempts increments so a crash loop still terminates at FAILED.
  await pool.query(
    `UPDATE social_jobs
       SET status = CASE WHEN attempts + 1 >= $2 THEN 'FAILED' ELSE 'QUEUED' END,
           attempts = attempts + 1,
           last_error = COALESCE(last_error, '') || ' [tick interrupted; resumed]',
           updated_at = now()
     WHERE status = ANY($1) AND updated_at < now() - interval '${Math.floor(STUCK_IN_FLIGHT_MS / 1000)} seconds'`,
    [IN_FLIGHT_STATUSES, MAX_PUBLISH_ATTEMPTS],
  )

  const { rows: due } = await pool.query(
    `SELECT id FROM social_jobs
      WHERE status = ANY($1) AND (status <> 'SCHEDULED' OR scheduled_at <= now())
      ORDER BY scheduled_at NULLS FIRST, created_at
      LIMIT $2`,
    [CLAIMABLE_STATUSES, TICK_BATCH],
  )
  if (due.length === 0) return 'idle'

  const results: string[] = []
  for (const { id } of due as Array<{ id: string }>) {
    // Atomic claim — the losing tick simply finds zero rows.
    const { rows: claimed } = await pool.query(
      `UPDATE social_jobs SET status = 'PREPARING', updated_at = now()
        WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [id, CLAIMABLE_STATUSES],
    )
    if (!claimed[0]) continue
    const job = toJob(claimed[0] as Row)
    results.push(`${job.id}:${await executeJob(job)}`)
  }
  return results.join(' ') || 'idle'
}

async function executeJob(job: SocialJob): Promise<string> {
  // Approval gate, re-checked at the moment of truth: the fingerprint of the
  // payload about to publish must be the fingerprint a human approved.
  if (!approvalStillValid(job)) {
    await setStatus(job.id, 'APPROVAL_REQUIRED', {
      last_error: 'Payload changed after approval (or approval missing) — re-approve before publishing',
    })
    return 'stale-approval'
  }

  const invalid = validatePayload(job.kind, job.payload)
  if (invalid) {
    await setStatus(job.id, 'FAILED', { last_error: invalid, attempts: job.attempts + 1 })
    return 'invalid'
  }

  const publisher = await publisherFor(job.platform)
  if (!publisher) {
    await setStatus(job.id, 'FAILED', { last_error: `No publisher for platform ${job.platform}` })
    return 'no-publisher'
  }

  const checkpoint: PublishCheckpoint = {
    saveContainer: async (containerId, childContainerIds) => {
      await pool.query(
        `UPDATE social_jobs SET container_id = $2, child_container_ids = $3, updated_at = now() WHERE id = $1`,
        [job.id, containerId, childContainerIds ? JSON.stringify(childContainerIds) : null],
      )
    },
    setPhase: async (phase) => {
      await setStatus(job.id, phase)
    },
  }

  const outcome = await publisher.publish(job, checkpoint)

  if (outcome.ok) {
    await setStatus(job.id, 'PUBLISHED', {
      remote_media_id: outcome.remoteMediaId,
      permalink: outcome.permalink ?? null,
      container_id: outcome.containerId ?? job.containerId,
      published_at: new Date(),
      last_error: null,
    })
    return 'published'
  }

  const next = nextAfterFailure(job, outcome)
  await setStatus(job.id, next.status, {
    attempts: next.attempts,
    last_error: outcome.error.slice(0, 2000),
    ...(next.clearContainer ? { container_id: null, child_container_ids: null } : {}),
  })
  return next.status.toLowerCase()
}

/** Read-side rollup for dashboards: how many jobs sit in each state. */
export async function socialQueueSummary(userId: string): Promise<Record<string, number>> {
  await ensureTable()
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM social_jobs WHERE user_id = $1 GROUP BY status`,
    [userId],
  )
  const out: Record<string, number> = {}
  for (const r of rows as Array<{ status: string; n: number }>) out[r.status] = r.n
  return out
}

/** Agent ids with a social job currently in flight — the diorama's Market-room signal. */
export async function agentsWithActiveSocialJobs(userId: string): Promise<Set<string>> {
  try {
    await ensureTable()
    const { rows } = await pool.query(
      `SELECT DISTINCT agent_id FROM social_jobs
        WHERE user_id = $1 AND agent_id IS NOT NULL AND status = ANY($2)`,
      [userId, [...IN_FLIGHT_STATUSES, 'QUEUED', 'READY']],
    )
    return new Set((rows as Array<{ agent_id: string }>).map((r) => r.agent_id))
  } catch {
    return new Set()
  }
}
