/**
 * Turning a red check into a funded job — the decision, in one pure function.
 *
 * The repo-jobs lane already grades: a worker's PR runs the repository's own
 * CI, and green CI releases the escrow. What it did not do is *originate* work
 * from CI. This does: a failing check on a commit that is not already a Handsel
 * job becomes a bounty to fix it. The failing check's name is the acceptance
 * criterion, so — uniquely among job kinds — nobody has to write a spec, and
 * the grader is free: the same check going green on the fix PR is the verdict,
 * which the existing `handleCheck` success path already settles.
 *
 * **The whole risk here is money, and the whole defence is this file.** A red
 * check that automatically escrows real USDC with no one having asked is not a
 * feature, it is an unauthorised spend. So the authority to fund is explicit,
 * per-repo, and capped, and `decideAutoBounty` is the single place that says
 * yes. Everything it can say no to, it says no to by default:
 *
 *   - no policy for this repo            → the repo never opted in
 *   - policy disabled                    → opted out, reversibly
 *   - the check is on a Handsel job PR    → that is grading, not origination
 *   - the check did not actually fail     → success/cancelled/skipped are not defects
 *   - an open bounty already covers it    → one red check is one job, not many
 *   - the day's cap is spent              → a bounded blast radius, per §15
 *
 * Only the last branch spends. It is pure so the interesting cases are tested
 * against constructed inputs rather than discovered on a live repo's wallet.
 */

/** A repo owner's standing authorisation: "pay to fix my red checks, from this
 *  agent, this much each, up to this much a day." The entire money surface. */
export type CiBountyPolicy = {
  repoFullName: string
  /** Whose escrow funds the bounty. Resolved to a smart account at post time. */
  funderAgentId: string
  /** Fixed bounty per failing check. Not an auction — a red check is not worth
   *  arguing over, and a per-post amount is a number a repo owner can reason
   *  about. */
  bountyUsd: number
  /** The blast radius. A flaky suite can fail a hundred times in an afternoon;
   *  without this, that is a hundred escrows. */
  dailyCapUsd: number
  enabled: boolean
}

/** The CI conclusions that mean "the work is broken", and nothing else. A
 *  `cancelled` run is not a defect; a `skipped` one graded nothing. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out'])

export function isFailingConclusion(conclusion: string | null | undefined): boolean {
  return FAILING_CONCLUSIONS.has(String(conclusion ?? ''))
}

/**
 * The dedup key for a failing check.
 *
 * Deliberately at **check-name** granularity, not per-commit: the same check
 * failing on tomorrow's commit is the same defect, and stacking a fresh bounty
 * on every push would drain the cap on one broken test. Normalised so
 * `CI / test (18.x)` and `ci / test (18.x)` collapse to one key.
 *
 * The cost of this coarseness, stated because it is a real cut: two genuinely
 * different failures in one check (a lint error and a type error both under
 * "CI") share a bounty, and the first fix closes it. That is the right default
 * for v1 — finer granularity needs log parsing this does not do — and it errs
 * toward *fewer* escrows, which is the safe direction for money.
 */
export function ciFailureSignature(repoFullName: string, checkName: string): string {
  const repo = repoFullName.trim().toLowerCase()
  const check = checkName.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${repo}::${check}`
}

export type AutoBountyInput = {
  policy: CiBountyPolicy | null
  conclusion: string | null | undefined
  /** True when the check belongs to a PR that is itself a Handsel repo job.
   *  Then the check is GRADING a submission, and originating a second bounty
   *  from it would pay to fix the fix. */
  isHandselJobPr: boolean
  /** True when an auto-bounty for this signature is already Open on-chain. */
  openBountyExists: boolean
  /** USDC already committed to auto-bounties for this repo since day start. */
  spentTodayUsd: number
}

export type AutoBountyDecision =
  | { post: true; bountyUsd: number }
  | { post: false; reason: string }

/**
 * The one authority that authorises an auto-bounty escrow.
 *
 * Order matters only for the message a skip returns; every guard is a hard no.
 * The cap check is last because it is the only one that depends on an amount,
 * and it is phrased against what a NEW post would spend — `spent + bounty > cap`
 * — so a policy whose bounty alone exceeds the remaining room is refused rather
 * than allowed to overshoot by one job. Same shape as the faucet's cap (§34).
 */
export function decideAutoBounty(input: AutoBountyInput): AutoBountyDecision {
  const { policy, conclusion, isHandselJobPr, openBountyExists, spentTodayUsd } = input

  if (!policy) return { post: false, reason: 'no CI-bounty policy for this repo' }
  if (!policy.enabled) return { post: false, reason: 'CI-bounty policy disabled' }
  if (!isFailingConclusion(conclusion)) return { post: false, reason: `conclusion "${conclusion}" is not a failure` }
  if (isHandselJobPr) return { post: false, reason: 'this check is grading a Handsel job, not a new defect' }
  if (openBountyExists) return { post: false, reason: 'an open bounty already covers this check' }

  if (!Number.isFinite(policy.bountyUsd) || policy.bountyUsd <= 0) {
    return { post: false, reason: 'policy bounty is not a positive amount' }
  }
  if (!Number.isFinite(policy.dailyCapUsd) || policy.dailyCapUsd <= 0) {
    return { post: false, reason: 'policy daily cap is not a positive amount' }
  }
  if (spentTodayUsd + policy.bountyUsd > policy.dailyCapUsd) {
    return {
      post: false,
      reason: `daily cap reached (spent $${spentTodayUsd} of $${policy.dailyCapUsd}, this would add $${policy.bountyUsd})`,
    }
  }

  return { post: true, bountyUsd: policy.bountyUsd }
}

/**
 * The brief a worker sees. The failing check IS the acceptance criterion, which
 * is the whole reason this job kind needs no human to write a spec.
 *
 * It tells the worker to fix the underlying defect, not to silence the check —
 * deleting the failing test would also turn CI green, and on the fix PR the
 * grader is that same CI, so the brief has to close the loophole the grader
 * cannot. A reviewer merges the PR, and merge is what releases escrow, so the
 * requester's own judgement remains the backstop against a fix that games the
 * signal.
 */
export function ciBountyBrief(input: {
  repoFullName: string
  checkName: string
  runUrl?: string | null
  headSha?: string | null
}): string {
  const { repoFullName, checkName, runUrl, headSha } = input
  const lines = [
    `The check "${checkName}" is failing on ${repoFullName}${headSha ? ` at ${headSha.slice(0, 8)}` : ''}.`,
    ``,
    `Open a pull request that makes it pass by fixing the underlying cause. Do NOT`,
    `make the check pass by deleting or weakening the test, skipping it, or removing`,
    `the assertion — the check is the grader, and a fix that games it will be caught`,
    `at review, where a human decides the merge that releases payment.`,
    runUrl ? `\nFailing run: ${runUrl}` : ``,
  ]
  return lines.filter((l) => l !== undefined).join('\n')
}

/** A repo owner's policy is only as safe as its numbers. Rejects the shapes
 *  that would make `decideAutoBounty` unable to protect anything. */
export function validateCiBountyPolicy(p: {
  bountyUsd: number
  dailyCapUsd: number
}): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(p.bountyUsd) || p.bountyUsd <= 0) return { ok: false, reason: 'Bounty must be a positive amount.' }
  if (!Number.isFinite(p.dailyCapUsd) || p.dailyCapUsd <= 0) return { ok: false, reason: 'Daily cap must be a positive amount.' }
  if (p.bountyUsd > p.dailyCapUsd) {
    return { ok: false, reason: 'The per-check bounty cannot exceed the daily cap — that would allow at most zero jobs.' }
  }
  return { ok: true }
}
