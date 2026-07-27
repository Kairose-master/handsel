/**
 * The rising-price tick: walk unclaimed jobs up toward their ceiling until
 * somebody takes one.
 *
 * ## Why a raise is a cancel-and-repost
 *
 * The LaborMarket contract escrows a job's bounty at postJob and pays that
 * exact amount at approveJob — there is no partial release and no top-up. So
 * a bounty cannot be edited in place: raising it means cancelling the old job
 * (which refunds the requester in full) and posting a fresh one at the higher
 * price. That is only safe while the job is still **Open**, because
 * cancelling a job somebody has already committed to would destroy their
 * work, so every raise re-checks live on-chain status first.
 *
 * This reuses the repost machinery the failed-grading path already relies on,
 * including `parentSpecHash`, so anything following the work — a delegation,
 * a watcher — follows it to the new job id.
 *
 * Best-effort and idempotent, like the other sweeps: safe to call from a hot
 * read path, and a crash mid-flight leaves either the old job or the new one
 * standing, never both.
 */
import { db } from '@/lib/db'
import { jobSpec } from '@/lib/db/schema'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'
import { nextPriceRaise } from '@/lib/market-price'
import { retry, retryRpc } from '@/lib/labor-settle'

const RAISE_SWEEP_COOLDOWN_MS = 60_000

/**
 * Exactly the columns a raise copies into its replacement row — no more.
 *
 * `raiseJobPrice` used to take a whole `jobSpec.$inferSelect`, which forced
 * its caller to `db.select()` with no column list, which asks Postgres for
 * every column schema.ts declares whether or not that column's migration has
 * run yet. That is the failure that has taken the public job feed down twice.
 * Naming the fields here makes the sweep's projection explicit and keeps a
 * newly-declared column from breaking price raises before it exists.
 */
export const RAISE_SPEC_COLUMNS = {
  specHash: jobSpec.specHash,
  title: jobSpec.title,
  description: jobSpec.description,
  acceptanceCriteria: jobSpec.acceptanceCriteria,
  requesterAgentId: jobSpec.requesterAgentId,
  attachmentUrl: jobSpec.attachmentUrl,
  attachmentName: jobSpec.attachmentName,
  testCode: jobSpec.testCode,
  deliverableKind: jobSpec.deliverableKind,
  requiredCapabilities: jobSpec.requiredCapabilities,
  repoFullName: jobSpec.repoFullName,
  baseBranch: jobSpec.baseBranch,
  // Selected because the replacement row has to carry it: it is the key the
  // GitHub webhook cancels a bounty by. Narrowing the select is what keeps a
  // column shipped ahead of its migration from breaking this reader — and the
  // same narrowing is why a field can go missing here as quietly as it went
  // missing from the insert.
  issueNumber: jobSpec.issueNumber,
  autoApprove: jobSpec.autoApprove,
  failedWorkerIds: jobSpec.failedWorkerIds,
  repostCount: jobSpec.repostCount,
  onchainJobId: jobSpec.onchainJobId,
  pricing: jobSpec.pricing,
  createdAt: jobSpec.createdAt,
} as const

export type RaisableSpec = {
  [K in keyof typeof RAISE_SPEC_COLUMNS]: typeof jobSpec.$inferSelect[K]
}

/** Raise one Open job to `nextUsd`. Returns the new on-chain job id, or null
 *  if the raise did not happen (which is always a safe outcome). */
export async function raiseJobPrice(
  spec: RaisableSpec,
  nextUsd: number,
): Promise<number | null> {
  if (!spec.requesterAgentId || spec.onchainJobId === null || !spec.pricing) return null

  const { readJobs, cancelJob, postJob } = await import('@/lib/onchain/labor')
  const jobs = await retryRpc(() => readJobs({ maxAgeMs: 0 }))
  const job = jobs.find((j) => j.id === spec.onchainJobId)
  // Re-check under fresh state: a worker may have claimed it in the seconds
  // since the sweep decided. Cancelling then would throw away real work.
  if (!job || job.status !== 'Open') return null

  const { keccak256, toHex } = await import('viem')
  const newSpecHash = keccak256(
    toHex(JSON.stringify({ title: spec.title, agent: spec.requesterAgentId, price: nextUsd, nonce: nanoid() })),
  )

  // 1. Write the INTENT down before any money moves. The cancel below can
  //    land while its receipt never arrives, and if the replacement row
  //    were inserted afterwards there would be no trace at all: escrow
  //    refunded, job gone from the market, nobody able to tell it was ever
  //    supposed to come back. With the row first, an unfinished raise is a
  //    visible orphan (pricing set, no onchainJobId) that resumeOrphanedRaises
  //    finishes on a later pass.
  await db.insert(jobSpec).values({
    specHash: newSpecHash,
    title: spec.title,
    description: spec.description,
    acceptanceCriteria: spec.acceptanceCriteria,
    requesterAgentId: spec.requesterAgentId,
    attachmentUrl: spec.attachmentUrl,
    attachmentName: spec.attachmentName,
    testCode: spec.testCode,
    deliverableKind: spec.deliverableKind,
    requiredCapabilities: spec.requiredCapabilities,
    repoFullName: spec.repoFullName,
    baseBranch: spec.baseBranch,
    issueNumber: spec.issueNumber, // the cancel key — see lib/labor-settle.ts
    autoApprove: spec.autoApprove,
    failedWorkerIds: spec.failedWorkerIds,
    repostCount: spec.repostCount, // a price raise is not a failed attempt
    parentSpecHash: spec.specHash,
    pricing: { ...spec.pricing, raises: (spec.pricing.raises ?? 0) + 1, pendingUsd: nextUsd, pendingMinScore: job.minScore },
  })

  // 2. Refund the old escrow, then 3. post the replacement. Cancel first so
  //    the requester never needs headroom for both at once; the orphan row
  //    above is what makes that ordering safe.
  await retryRpc(() => cancelJob(spec.requesterAgentId!, spec.onchainJobId!))
  await retry(() => postJob(spec.requesterAgentId!, nextUsd, job.minScore, newSpecHash))

  let newJobId: number | null = null
  try {
    const fresh = await retryRpc(() => readJobs({ maxAgeMs: 0 }))
    const posted = fresh.find((j) => j.specHash.toLowerCase() === newSpecHash.toLowerCase())
    if (posted) {
      newJobId = posted.id
      await db.update(jobSpec).set({ onchainJobId: posted.id }).where(eq(jobSpec.specHash, newSpecHash))
    }
  } catch (e) {
    console.error('[price-raise] onchainJobId backfill failed (non-fatal):', e)
  }

  await logPlatformEvent(
    'JOB_PRICE_RAISED',
    `"${spec.title}" went unclaimed — bounty raised to $${nextUsd}${newJobId ? ` (now job #${newJobId})` : ''}`,
  )
  return newJobId
}

/** A raise that wrote its intent but never got its replacement on-chain.
 *  Pure so the recovery rule is testable: a replacement row (it has a
 *  parent) with a price plan and no on-chain id, left alone long enough
 *  that an in-flight post would have finished. */
export function isOrphanedRaise(
  now: Date,
  spec: { parentSpecHash: string | null; pricing: unknown; onchainJobId: number | null; createdAt: Date },
  minAgeMs = 5 * 60_000,
): boolean {
  if (!spec.parentSpecHash || !spec.pricing) return false
  if (spec.onchainJobId !== null) return false
  return now.getTime() - new Date(spec.createdAt).getTime() > minAgeMs
}

/**
 * The parent states in which a replacement is genuinely owed.
 *
 * `resumeOrphanedRaises` posts a job on the strength of a row saying one was
 * intended. That is only safe if the ORIGINAL escrow actually came back:
 *
 * - `Cancelled` / `Refunded` — the refund landed, the market is short one
 *   job, post the replacement. This is the case the recovery exists for.
 * - `Open` / `Accepted` / `Submitted` — the cancel never happened (it
 *   reverted, or a worker claimed the job first). The original is still
 *   live and possibly being worked; posting the replacement escrows the
 *   same task twice from the same wallet.
 * - `Completed` — somebody already got paid for it. A replacement here buys
 *   the work a second time.
 * - Parent unknown to the chain — no evidence either way, so do nothing
 *   (invariant 5).
 *
 * Pure, because this is the rule that decides whether money moves.
 */
export const RESUMABLE_PARENT_STATUSES = ['Cancelled', 'Refunded'] as const

export function isRaiseResumable(parentStatus: string | undefined | null): boolean {
  return typeof parentStatus === 'string' && (RESUMABLE_PARENT_STATUSES as readonly string[]).includes(parentStatus)
}

/**
 * Finish raises that died between the refund and the repost.
 *
 * The old escrow is already returned by that point, so the only thing
 * missing is the replacement listing — post it and the work rejoins the
 * market instead of vanishing. Idempotent: the on-chain post is keyed by
 * specHash, so a row that actually did get posted is detected and merely
 * backfilled rather than posted twice.
 */
export async function resumeOrphanedRaises(now = new Date()): Promise<number> {
  let resumed = 0
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) return 0

    // Both halves of this query matter, and I got both wrong when I first
    // wrote it: it selected EVERY column and filtered in JavaScript.
    //
    // Selecting every column is the schema-ahead-of-migration trap that has
    // taken the public task feed down once already — drizzle asks Postgres
    // for each column schema.ts declares, so a new column breaks this reader
    // the moment it ships, before its migration runs. And this step is
    // marked `fast`, so it runs on every traffic tick: a full table scan,
    // every five minutes anyone is looking, to find rows that are almost
    // always zero.
    //
    // Push both the predicate and the projection into SQL. The pure
    // isOrphanedRaise still decides the age rule, which is the part worth
    // testing.
    const candidates = await db
      .select({
        specHash: jobSpec.specHash,
        title: jobSpec.title,
        requesterAgentId: jobSpec.requesterAgentId,
        pricing: jobSpec.pricing,
        parentSpecHash: jobSpec.parentSpecHash,
        onchainJobId: jobSpec.onchainJobId,
        createdAt: jobSpec.createdAt,
      })
      .from(jobSpec)
      .where(and(isNotNull(jobSpec.parentSpecHash), isNull(jobSpec.onchainJobId)))
    const orphans = candidates.filter((s) => isOrphanedRaise(now, s))
    if (orphans.length === 0) return 0

    const { postJob } = await import('@/lib/onchain/labor')
    const { readJobsOrUnknown } = await import('@/lib/onchain/labor-read')
    const jobs = await readJobsOrUnknown({ maxAgeMs: 0 })
    // Posting escrowed jobs on the strength of intent rows requires knowing
    // what actually happened on-chain. Unknown ⇒ resume nothing.
    if (jobs === null) return 0
    const byHash = new Map(jobs.map((j) => [j.specHash.toLowerCase(), j]))

    // Parent lineage, so each orphan can be checked against the fate of the
    // job it was meant to replace.
    const parentHashes = [...new Set(orphans.map((o) => o.parentSpecHash!).filter(Boolean))]
    const parentRows = parentHashes.length > 0
      ? await db
          .select({ specHash: jobSpec.specHash, onchainJobId: jobSpec.onchainJobId })
          .from(jobSpec)
          .where(inArray(jobSpec.specHash, parentHashes))
      : []
    const parentJobIdByHash = new Map(parentRows.map((p) => [p.specHash.toLowerCase(), p.onchainJobId]))
    const statusById = new Map(jobs.map((j) => [j.id, j.status]))

    for (const orphan of orphans.slice(0, 3)) {
      try {
        // It may already be on-chain and simply unlinked — never post twice.
        const existing = byHash.get(orphan.specHash.toLowerCase())
        if (existing) {
          await db.update(jobSpec).set({ onchainJobId: existing.id }).where(eq(jobSpec.specHash, orphan.specHash))
          continue
        }

        // The intent row proves a replacement was WANTED, not that the
        // original escrow ever came back. If the cancel reverted — because a
        // worker claimed the job in the same second, or two instances raced
        // the same raise — the parent is still live, and posting here would
        // escrow the same task twice from one wallet.
        const parentJobId = parentJobIdByHash.get(orphan.parentSpecHash!.toLowerCase())
        const parentStatus = parentJobId === null || parentJobId === undefined ? undefined : statusById.get(parentJobId)
        if (!isRaiseResumable(parentStatus)) {
          console.warn(
            `[price-raise] orphan ${orphan.specHash} left alone — parent job ${parentJobId ?? '(unlinked)'} is ${parentStatus ?? 'unknown'}, so its escrow was never returned`,
          )
          continue
        }
        const plan = orphan.pricing as { raises?: number; pendingUsd?: number; pendingMinScore?: number } | null
        const bountyUsd = plan?.pendingUsd
        if (!orphan.requesterAgentId || typeof bountyUsd !== 'number' || bountyUsd <= 0) continue
        await retry(() => postJob(orphan.requesterAgentId!, bountyUsd, Math.round(plan?.pendingMinScore ?? 0), orphan.specHash as `0x${string}`))
        await logPlatformEvent(
          'JOB_PRICE_RAISED',
          `"${orphan.title}" — an interrupted price raise was completed; the job is back on the market at $${bountyUsd}${plan?.raises ? ` (raise ${plan.raises})` : ''}`,
        ).catch(() => {})
        resumed++
      } catch (error) {
        console.error(`[price-raise] resuming orphaned raise ${orphan.specHash} failed:`, error)
      }
    }
  } catch (error) {
    console.error('[price-raise] orphan resume failed:', error)
  }
  return resumed
}

/**
 * Sweep every Open job carrying a rising-price plan and raise the ones that
 * have waited long enough. Throttled; failures are logged, never thrown.
 */
export async function sweepPriceRaises(): Promise<number> {
  await (await import('@/lib/db/ensure-columns')).ensureJobSpecColumns()

  // A CROSS-INSTANCE lease, not a module-level timestamp. This sweep is
  // called straight from the jobs page's after() block, so on a warm fleet
  // several lambdas reach it at once, each with its own clock and each
  // convinced it is due. Two of them raising the same job is the double-
  // escrow race described in lib/ops-lease.ts.
  const { acquireOpsLease } = await import('@/lib/ops-lease')
  if (!(await acquireOpsLease('price-raise-sweep', RAISE_SWEEP_COOLDOWN_MS))) return 0

  const now = Date.now()

  let raised = 0
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) return 0

    const specs = await db
      .select(RAISE_SPEC_COLUMNS)
      .from(jobSpec)
      .where(and(isNotNull(jobSpec.pricing), isNotNull(jobSpec.onchainJobId)))
    if (specs.length === 0) return 0

    const { readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs().catch(() => [])
    const openById = new Map(jobs.filter((j) => j.status === 'Open').map((j) => [j.id, j]))

    for (const spec of specs) {
      const job = openById.get(spec.onchainJobId!)
      if (!job) continue // claimed, completed or cancelled — nothing to raise
      const ageMinutes = (now - new Date(spec.createdAt).getTime()) / 60_000
      const decision = nextPriceRaise({ currentUsd: job.bounty, ageMinutes, plan: spec.pricing })
      if (!decision.shouldRaise) continue
      try {
        console.log(`[price-raise] job #${spec.onchainJobId}: ${decision.reason}`)
        if (await raiseJobPrice(spec, decision.nextUsd)) raised++
      } catch (error) {
        console.error(`[price-raise] raise of job #${spec.onchainJobId} failed:`, error)
      }
    }
  } catch (error) {
    console.error('[price-raise] sweep failed:', error)
  }
  return raised
}
