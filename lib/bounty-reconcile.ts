/**
 * The sweep for a bounty whose issue is gone.
 *
 * ## Why this exists
 *
 * A labelled issue escrows money; removing the label or closing the issue is
 * supposed to give it back. That refund was **one webhook delivery**. It fires
 * once, GitHub does not redeliver a `closed` event because the handler
 * answered 200, and two of the handler's exits are silent:
 *
 *   - `specsForIssue` returns nothing  → `ignored`, no comment
 *   - `readJobsOrUnknown` returns null → `deferred`, no comment
 *
 * Job #327 hit the first one for a real reason (a repost had dropped its
 * `issue_number`, fixed separately). But the second needs no defect at all —
 * one RPC hiccup at the moment the issue closes produces the same stranded
 * escrow with every line of code behaving exactly as written. The handler's
 * own comment says it leaves the case "to the escrow sweeps." There were no
 * escrow sweeps for this. That sentence was the whole bug.
 *
 * Nothing on-chain rescues it either: `cancelJob` on an `Open` job is
 * requester-only, so none of LaborMarketV2's three permissionless timeouts
 * reach a job nobody ever claimed. The escrow is not frozen — the owner can
 * always cancel by hand — but nothing automatic ever notices, and "the owner
 * eventually notices" is not a mechanism.
 *
 * ## What it does
 *
 * Asks GitHub, for every Open bounty job, whether its issue still wants it.
 * Closed issue, or bounty label removed ⇒ cancel and refund.
 *
 * ## What it refuses to do
 *
 * Act on missing evidence. A GitHub read that fails is not a closed issue; a
 * chain read that fails is not an absent job. Both mean **do nothing and come
 * back** — this sweep spends the requester's money, and the failure it must
 * never have is cancelling a live bounty because an API was briefly down. That
 * is `docs/failure-modes.md` invariant 5, and §12 is what it looks like when
 * an empty result from a failed read gets treated as an empty world.
 */

/** Everything the decision needs, and nothing that requires I/O to evaluate. */
export type BountyFact = {
  /** GitHub issue state, or null if it could not be read. */
  issueState: 'open' | 'closed' | null
  /** Whether a bounty label is still on the issue; null if unread. */
  hasBountyLabel: boolean | null
  /** On-chain status of the job, or null if the chain could not be read. */
  jobStatus: string | null
  /** Age of the spec row. A bounty posted seconds ago is not abandoned. */
  ageMs: number
}

/** Every outcome is named. A sweep that reports "0 cancelled" without saying
 *  why examined nothing is indistinguishable from a sweep that is broken —
 *  which is the lesson `docs/failure-modes.md` §18 was written for. */
export type BountyReason =
  | 'chain-unreadable'
  | 'not-open'
  | 'too-new'
  | 'issue-unreadable'
  | 'issue-closed'
  | 'label-removed'
  | 'still-wanted'

export type BountyVerdict = { cancel: boolean; reason: BountyReason }

/**
 * How long a bounty is left alone after its spec row appears.
 *
 * The posting webhook holds a two-minute lock across a ~30s on-chain round
 * trip, and a user who mislabels and relabels does it in seconds. Reading
 * GitHub inside that window risks cancelling a bounty that is mid-flight.
 * Being late here costs nothing but a delay; being early spends someone's
 * money on a race.
 */
export const RECONCILE_GRACE_MS = 30 * 60_000

/**
 * Should this bounty's escrow be returned?
 *
 * Ordered so the cheap refusals come first and every `false` carries a reason
 * distinguishable from every other `false`.
 */
export function decideBountyCancel(fact: BountyFact): BountyVerdict {
  // Unknown chain state is not "no job". §12: an empty result from a failed
  // read is not an empty world, and here acting on one would cancel blind.
  if (fact.jobStatus === null) return { cancel: false, reason: 'chain-unreadable' }

  // A claimed job is a worker's committed work. A label cannot destroy it —
  // the same rule the webhook's cancel path already enforces, and the reason
  // this sweep is not simply "refund anything whose issue is gone".
  if (fact.jobStatus !== 'Open') return { cancel: false, reason: 'not-open' }

  if (fact.ageMs < RECONCILE_GRACE_MS) return { cancel: false, reason: 'too-new' }

  // A 404 from GitHub means the App lost access, or the repo went private, or
  // the network hiccuped. It does not mean the issue was closed, and treating
  // it that way would refund every bounty in a repo the moment an install
  // token expired.
  if (fact.issueState === null || fact.hasBountyLabel === null) {
    return { cancel: false, reason: 'issue-unreadable' }
  }

  if (fact.issueState === 'closed') return { cancel: true, reason: 'issue-closed' }
  if (!fact.hasBountyLabel) return { cancel: true, reason: 'label-removed' }
  return { cancel: false, reason: 'still-wanted' }
}

/** Human-readable, for the ops line and the issue comment. */
export function explainBountyReason(reason: BountyReason): string {
  switch (reason) {
    case 'chain-unreadable':
      return 'chain state unknown — nothing cancelled'
    case 'not-open':
      return 'already claimed — a label cannot destroy committed work'
    case 'too-new':
      return 'posted too recently to judge'
    case 'issue-unreadable':
      return 'GitHub unreadable — nothing cancelled'
    case 'issue-closed':
      return 'the issue was closed'
    case 'label-removed':
      return 'the bounty label was removed'
    case 'still-wanted':
      return 'the issue is open and still labelled'
  }
}

export type ReconcileReport = {
  examined: number
  cancelled: number
  /** Count per reason, so a quiet pass still says what it saw. */
  reasons: Partial<Record<BountyReason, number>>
  failed?: number
}

/**
 * Run the sweep. Never throws into the ops cycle.
 *
 * GitHub is only consulted for jobs that are Open on-chain and past the grace
 * window, which bounds the API cost to the number of live bounties rather than
 * the size of the spec table.
 */
export async function reconcileBounties(): Promise<ReconcileReport | string> {
  const { db } = await import('@/lib/db')
  const { jobSpec } = await import('@/lib/db/schema')
  const { and, isNotNull } = await import('drizzle-orm')

  let specs
  try {
    specs = await db
      .select({
        specHash: jobSpec.specHash,
        repoFullName: jobSpec.repoFullName,
        issueNumber: jobSpec.issueNumber,
        onchainJobId: jobSpec.onchainJobId,
        requesterAgentId: jobSpec.requesterAgentId,
        createdAt: jobSpec.createdAt,
      })
      .from(jobSpec)
      .where(and(isNotNull(jobSpec.repoFullName), isNotNull(jobSpec.issueNumber), isNotNull(jobSpec.onchainJobId)))
  } catch (error) {
    return `spec read failed: ${error instanceof Error ? error.message : String(error)}`
  }
  if (specs.length === 0) return { examined: 0, cancelled: 0, reasons: {} }

  const { readJobsOrUnknown } = await import('@/lib/onchain/labor-read')
  const jobs = await readJobsOrUnknown({ maxAgeMs: 0 })
  const statusById = jobs === null ? null : new Map(jobs.map((j) => [j.id, j.status]))

  const report: ReconcileReport = { examined: 0, cancelled: 0, reasons: {} }
  const note = (reason: BountyReason) => {
    report.reasons[reason] = (report.reasons[reason] ?? 0) + 1
  }

  const now = Date.now()
  for (const spec of specs) {
    report.examined++
    const jobStatus = statusById?.get(spec.onchainJobId!) ?? null
    const ageMs = now - new Date(spec.createdAt).getTime()

    // Decide once WITHOUT GitHub. Most rows stop here (settled, claimed, or
    // too new), so the API is only touched for the few that could actually be
    // cancelled.
    const provisional = decideBountyCancel({ issueState: null, hasBountyLabel: null, jobStatus, ageMs })
    if (provisional.reason !== 'issue-unreadable') {
      note(provisional.reason)
      continue
    }

    const issue = await readIssue(spec.repoFullName!, spec.issueNumber!)
    const verdict = decideBountyCancel({
      issueState: issue?.state ?? null,
      hasBountyLabel: issue?.hasBountyLabel ?? null,
      jobStatus,
      ageMs,
    })
    if (!verdict.cancel) {
      note(verdict.reason)
      continue
    }

    if (!spec.requesterAgentId) {
      note('issue-unreadable') // no requester to cancel as; nothing this sweep can do
      continue
    }

    try {
      const { cancelJob } = await import('@/lib/onchain/labor')
      await cancelJob(spec.requesterAgentId, spec.onchainJobId!)
      report.cancelled++
      note(verdict.reason)
      console.log(
        `[bounty-reconcile] cancelled job #${spec.onchainJobId} on ${spec.repoFullName}#${spec.issueNumber} — ` +
          explainBountyReason(verdict.reason),
      )
      const { commentOnPr } = await import('@/lib/github-app')
      await commentOnPr(
        spec.repoFullName!,
        spec.issueNumber!,
        `↩️ Bounty cancelled and the escrow refunded — ${explainBountyReason(verdict.reason)}, and the job was still unclaimed.`,
      ).catch(() => {}) // a closed issue in an uninstalled repo still deserves the refund
    } catch (error) {
      // A cancel whose receipt never arrived was still accepted by the bundler
      // and usually lands. Counting it as failed would make the next pass try
      // again, which is harmless — the second cancel reverts on a job that is
      // no longer Open.
      report.failed = (report.failed ?? 0) + 1
      console.error(`[bounty-reconcile] cancel of job #${spec.onchainJobId} failed:`, error)
    }
  }

  return report
}

/** GitHub issue state + whether a bounty label survives on it. Null on any
 *  failure, because "I could not read it" must stay distinguishable from "it
 *  is closed" all the way to the decision. */
async function readIssue(
  repoFullName: string,
  issueNumber: number,
): Promise<{ state: 'open' | 'closed'; hasBountyLabel: boolean } | null> {
  try {
    const { installationTokenForRepo } = await import('@/lib/github-app')
    const { bountyLabelOn } = await import('@/lib/bounty-label')
    const token = await installationTokenForRepo(repoFullName)
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ledgermind-bounty-reconcile',
      },
    })
    if (!res.ok) {
      console.warn(`[bounty-reconcile] GitHub ${res.status} for ${repoFullName}#${issueNumber} — leaving it alone`)
      return null
    }
    const issue = (await res.json()) as { state?: string; labels?: Array<{ name?: string }> }
    const state = issue.state === 'closed' ? 'closed' : 'open'
    return { state, hasBountyLabel: bountyLabelOn(issue.labels) !== null }
  } catch (error) {
    console.warn(`[bounty-reconcile] could not read ${repoFullName}#${issueNumber}:`, error)
    return null
  }
}
