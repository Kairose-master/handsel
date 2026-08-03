/**
 * The label-to-bounty bot's pure logic.
 *
 * The whole requester funnel compressed to one gesture: put a `bounty:$15`
 * label on a GitHub issue and the platform does the rest — escrow, job
 * posting, worker attempts, PR, CI, and a comment trail on the issue. The
 * human's remaining job is the merge button, which is exactly the one act
 * the trust model requires a human for.
 *
 * Identity bridge: the GitHub account that ADDED the label, resolved through
 * github_identities (the sign-in built for the repo picker), decides whose
 * platform agent escrows the bounty. Not linked → the bot answers with the
 * link instructions instead — which turns every mislabeled issue into an
 * onboarding surface rather than a silent failure.
 */

/** Accepts `bounty:$15`, `bounty: $15`, `bounty:15`, `Bounty:$15.50`.
 *  Rejects zero, negatives, and nonsense. */
export function parseBountyLabel(labelName: string): number | null {
  const m = labelName.trim().match(/^bounty:\s*\$?(\d+(?:\.\d{1,2})?)$/i)
  if (!m) return null
  const usd = Number(m[1])
  if (!Number.isFinite(usd) || usd <= 0) return null
  return usd
}

/** Testnet sanity cap — a typo'd `bounty:$1500` should fail loudly, not
 *  escrow a fortune. Raise deliberately when real money raises the stakes. */
export const MAX_LABEL_BOUNTY_USD = 200

export function validateLabelBounty(usd: number): { ok: true } | { ok: false; reason: string } {
  if (usd < 1) return { ok: false, reason: 'Bounty labels start at $1.' }
  if (usd > MAX_LABEL_BOUNTY_USD) {
    return { ok: false, reason: `Bounty labels are capped at $${MAX_LABEL_BOUNTY_USD} for now.` }
  }
  return { ok: true }
}

/** The job brief is the issue itself — title, body, and a link back. Bodies
 *  are truncated at a size that keeps the brief readable on the board. */
export function briefFromIssue(input: { title: string; body: string | null; url: string }): string {
  const body = (input.body ?? '').trim()
  const truncated = body.length > 4000 ? `${body.slice(0, 4000)}\n\n[truncated — full text at the issue]` : body
  return [
    truncated || '(The issue has no description — the title and linked discussion are the spec.)',
    '',
    `Source issue: ${input.url}`,
    'Reference the issue number in your summary so the PR links back to it.',
  ].join('\n')
}

/**
 * What the bot comments on the issue after posting. Public text — every
 * bountied issue doubles as the product explaining itself.
 *
 * `realMoney` is not decoration. "$1 bounty escrowed" reads exactly the same
 * whether a real dollar moved or a freely-minted testnet token did, and the
 * comment is the only thing most people will ever read about that job. A repo
 * owner deciding whether to merge, and a worker deciding whether the work is
 * worth doing, are both answering a question this sentence has to settle.
 *
 * It became load-bearing the day a repo turned out to have TWO markets' Apps
 * installed: the testnet one answered first, and its comment was
 * indistinguishable from the mainnet one's (failure-modes §23). The deployment
 * cannot tell that another market also heard the label — but it can always
 * tell whether its OWN money is real, and saying so makes the mix-up visible
 * in the one place a human is already looking.
 */
export function bountyPostedComment(input: {
  bountyUsd: number
  jobId: number | null
  origin: string
  realMoney: boolean
}): string {
  const jobRef = input.jobId !== null ? `job #${input.jobId}` : 'a job'
  const money = input.realMoney
    ? `**$${input.bountyUsd} in real USDC**`
    : `**$${input.bountyUsd} in testnet tokens (no real value)**`
  return (
    `💰 ${money} escrowed on this issue as ${jobRef} on [Handsel](${input.origin}).\n\n` +
    `An AI worker will claim it, and a pull request referencing this issue will follow. ` +
    `The repository's own CI grades the work; **merging the PR releases the escrow, closing it unmerged refunds the poster.** ` +
    `Remove the label while the job is unclaimed to cancel and refund.` +
    (input.realMoney
      ? ''
      : `\n\nThis is a sandbox deployment. If you expected a real bounty, a different market's App answered — check which Handsel Apps are installed on this repository.`)
  )
}

export function notLinkedComment(origin: string): string {
  return (
    `I found a bounty label, but the GitHub account that added it isn't linked to a Handsel account yet, ` +
    `so there's no wallet to escrow from.\n\n` +
    `Link it here (one click): ${origin}/api/github/oauth/start?next=/jobs — then re-add the label.`
  )
}

/** Idempotency + cancel lookups key on this: one job per (repo, issue). */
export function issueNumberOf(payload: { issue?: { number?: number } }): number | null {
  const n = payload.issue?.number
  return Number.isInteger(n) && n! > 0 ? n! : null
}

/** The bounty label present on an issue right now, if any. */
export function bountyLabelOn(labels: Array<{ name?: string }> | undefined): number | null {
  for (const label of labels ?? []) {
    const usd = parseBountyLabel(label.name ?? '')
    if (usd !== null) return usd
  }
  return null
}

/**
 * One GitHub issue can own several job specs over its life — label, cancel,
 * re-label; or a failed grade that auto-reposted. Both webhook decisions that
 * follow ("is a job already live for this issue?" and "which job does an
 * unlabel refund?") therefore have to be answered against LIVE CHAIN STATE,
 * never against whichever spec row the database happened to return first.
 *
 * Taking the first row was two separate money bugs. A stale row that reads as
 * dead let a second `bounty:$N` label escrow the same issue twice. And an
 * unlabel that matched a stale row "cancelled" a long-finished job id while
 * the real escrow stayed locked — with the label now gone, nothing left would
 * ever release it.
 *
 * `candidates` is expected newest-first, so among several live jobs the most
 * recent wins; correctness does not depend on the order, only the tie-break.
 */
export const LIVE_JOB_STATUSES = ['Open', 'Accepted', 'Submitted'] as const

export function pickIssueJob<T extends { onchainJobId: number | null }>(
  candidates: readonly T[],
  statusOf: (jobId: number) => string | undefined,
  allowed: readonly string[] = LIVE_JOB_STATUSES,
): { spec: T; jobId: number } | null {
  for (const spec of candidates) {
    if (spec.onchainJobId === null) continue
    const status = statusOf(spec.onchainJobId)
    if (status !== undefined && allowed.includes(status)) return { spec, jobId: spec.onchainJobId }
  }
  return null
}
