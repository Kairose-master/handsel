'use server'

/**
 * Session boundary for the social content queue — thin on purpose, the real
 * rules live in lib/social/social-job.ts (pure) and social-queue-server.ts.
 *
 * The approval action records the approving USER's email: the queue's
 * fingerprint check makes "what was approved is what publishes" mechanical,
 * and this is where the "who" half of that audit trail is captured. Nothing
 * in this file can publish — publishing belongs to the ops-cycle tick, which
 * only ever claims jobs a human moved past the approval gate.
 */
import { getSession } from '@/lib/get-session'
import {
  approveSocialJob,
  createSocialJob,
  deleteSocialJob,
  getSocialJob,
  listSocialJobs,
  requeueSocialJob,
  socialQueueSummary,
  submitSocialJob,
  updateSocialJobPayload,
} from '@/lib/social/social-queue-server'
import { isInstagramConfigured } from '@/lib/social/instagram'
import type { SocialJob, SocialJobKind, SocialJobPayload } from '@/lib/social/social-job'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user
}

export async function getSocialDesk(): Promise<{
  configured: boolean
  jobs: SocialJob[]
  summary: Record<string, number>
}> {
  const user = await requireUser()
  const [jobs, summary] = await Promise.all([listSocialJobs(user.id), socialQueueSummary(user.id)])
  return { configured: isInstagramConfigured(), jobs, summary }
}

export async function createSocialDraft(input: {
  kind: SocialJobKind
  payload: SocialJobPayload
  campaign?: string
  scheduledAt?: string
  agentId?: string
  draft?: boolean
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const user = await requireUser()
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : undefined
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) return { ok: false, error: 'Invalid scheduled time' }
  const res = await createSocialJob({
    userId: user.id,
    platform: 'instagram',
    kind: input.kind,
    payload: input.payload,
    campaign: input.campaign,
    scheduledAt,
    agentId: input.agentId,
    draft: input.draft,
  })
  if (res.error || !res.job) return { ok: false, error: res.error ?? 'Failed to create job' }
  return { ok: true, id: res.job.id }
}

export async function submitSocialDraft(id: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser()
  return submitSocialJob(id, user.id)
}

export async function approveSocial(id: string, scheduledAt?: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser()
  const when = scheduledAt ? new Date(scheduledAt) : undefined
  if (when && Number.isNaN(when.getTime())) return { ok: false, error: 'Invalid scheduled time' }
  return approveSocialJob(id, user.id, user.email ?? user.id, when)
}

export async function editSocialPayload(
  id: string,
  payload: SocialJobPayload,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser()
  return updateSocialJobPayload(id, user.id, payload)
}

export async function requeueSocial(id: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser()
  return requeueSocialJob(id, user.id)
}

export async function deleteSocial(id: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser()
  return deleteSocialJob(id, user.id)
}

export async function getSocialJobDetail(id: string): Promise<SocialJob | null> {
  const user = await requireUser()
  return getSocialJob(id, user.id)
}
