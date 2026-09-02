/**
 * Post one job from an agent the platform holds the keys for — the shared
 * write path behind sessions (lib/session-server.ts) and the Notion desk
 * (lib/notion-desk.ts).
 *
 * The board (app/actions/labor.ts postJobAction) and delegation
 * (lib/delegation.ts postOneSubtask) each carry their own copy of this
 * sequence with their own extras; this is the sequence alone, in the order
 * every copy agrees on:
 *
 *   mainnet guard → seal the brief → store the spec → lane → posting fee →
 *   escrow on-chain → reservation → resolve the on-chain id
 *
 * Fee before escrow, so "can't afford bounty + fee" surfaces here and a wash
 * trade costs something. Reservation after escrow, because a reservation on
 * a job that never made it on-chain is a row that means nothing.
 */
import { nanoid } from 'nanoid'
import { db } from '@/lib/db'
import { jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { sealForInsert } from '@/lib/spec-hash'
import type { Hex } from 'viem'

export type PostSpecJobInput = {
  payerAgentId: string
  title: string
  description: string
  acceptanceCriteria: string
  bountyUsd: number
  deliveryWindowSec?: number
  /** Reserve for one agent (lib/job-reservation.ts) — the market after the TTL. */
  reserveForAgentId?: string | null
  /** The job this one continues (a session's previous turn). */
  parentSpecHash?: string | null
  /** Release on a passing grade without an approve click. Default true. */
  autoApprove?: boolean
  lane?: 'local' | 'handsel'
  /** Hide from the public board; only the owner's connected offices see it. */
  officeOwnerId?: string | null
}

export async function postSpecJob(input: PostSpecJobInput): Promise<{ specHash: Hex; txHash: Hex; onchainJobId: number | null }> {
  await (await import('@/lib/onchain/real-money')).assertRealMoneyReady('Posting a job')
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  const sealed = sealForInsert(
    input.payerAgentId,
    {
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      testCode: null,
      deliverableKind: 'text',
    },
    nanoid(),
  )
  const specHash = sealed.specHash
  await db.insert(jobSpec).values({
    ...sealed,
    requesterAgentId: input.payerAgentId,
    autoApprove: input.autoApprove ?? true,
    parentSpecHash: input.parentSpecHash ?? null,
    officeOwnerId: input.officeOwnerId ?? null,
  })

  if (input.lane) {
    const { setJobLane } = await import('@/lib/job-lane-server')
    await setJobLane(specHash, input.lane)
  }

  const { collectPostingFee } = await import('@/lib/platform-fee')
  await collectPostingFee(input.payerAgentId, input.bountyUsd, `"${input.title}"`)

  const { postJob, readJobs } = await import('@/lib/onchain/labor')
  const txHash = await postJob(input.payerAgentId, input.bountyUsd, 0, specHash, input.deliveryWindowSec)
  const { logPlatformEvent } = await import('@/lib/platform-feed')
  await logPlatformEvent('JOB_POSTED', `"${input.title.slice(0, 80)}" — $${input.bountyUsd} bounty`).catch(() => {})

  if (input.reserveForAgentId) {
    const { reserveJobForAgent } = await import('@/lib/job-reservation')
    await reserveJobForAgent(specHash, input.reserveForAgentId)
  }

  // The id the chain gave it, read fresh. A miss here is not a failure — the
  // job exists and every reader resolves by specHash; the id is a convenience
  // for people and for status lines.
  let onchainJobId: number | null = null
  try {
    const jobs = await readJobs({ maxAgeMs: 0 })
    const mine = jobs.find((j) => j.specHash.toLowerCase() === specHash.toLowerCase())
    if (mine) {
      onchainJobId = mine.id
      await db.update(jobSpec).set({ onchainJobId: mine.id }).where(eq(jobSpec.specHash, specHash))
    }
  } catch {
    /* resolved lazily by the next reader */
  }
  return { specHash, txHash, onchainJobId }
}
