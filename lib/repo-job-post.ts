/**
 * Posting a GitHub repo job — the core, deliberately OUTSIDE the server-action
 * file.
 *
 * Every export of a `'use server'` module is a callable RPC endpoint. A
 * posting function that takes the requester as a parameter therefore must not
 * live there: any client could call it with somebody else's agent id. Keeping
 * the core here means each caller states its own authorization first — the web
 * action checks session ownership, the admin path checks superadmin, the MCP
 * tool checks the bearer token's user — and the shared body can't be reached
 * without one of them.
 *
 * See docs/github-jobs.md for what a repo job is and why CI is the grader.
 */
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { asActionError } from '@/lib/action-error'
import { logPlatformEvent } from '@/lib/platform-feed'
import {
  repoJobAcceptanceCriteria,
  repoJobDescription,
  repoJobTitle,
  validateRepoFullName,
} from '@/lib/repo-jobs'

export type RepoJobInput = {
  requesterAgentId: string
  repoFullName: string
  baseBranch?: string
  title: string
  brief: string
  issueUrl?: string
  criteria?: string
  bountyUsd: number
  minScore?: number
  /** Optional rising price: leave null for an ordinary fixed bounty. */
  pricing?: { ceilingUsd: number; stepUsd?: number; stepMinutes?: number } | null
  /** Set by the label-to-bounty bot: the GitHub issue this job mirrors. */
  issueNumber?: number | null
  /** Set by the CI-bounty lane: ciFailureSignature() of the failing check this
   *  job was auto-originated from. Its dedup key and spend marker. */
  ciCheckSignature?: string | null
}

/** Strip the shapes people actually paste (full URL, trailing .git) down to
 *  owner/name, so a good input isn't rejected on a technicality. */
export function normalizeRepoFullName(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

export async function checkRepoAccess(
  repoFullName: string,
): Promise<{ ok: boolean; reason: string; defaultBranch?: string }> {
  if (!validateRepoFullName(repoFullName)) return { ok: false, reason: 'Repository must be in owner/name form.' }
  const { isGithubAppConfigured, installationTokenForRepo, repoDefaultBranch } = await import('@/lib/github-app')
  if (!(await isGithubAppConfigured())) {
    return { ok: false, reason: 'This deployment has no GitHub App configured, so repo jobs are unavailable.' }
  }
  try {
    const token = await installationTokenForRepo(repoFullName)
    const defaultBranch = await repoDefaultBranch(repoFullName, token)
    return { ok: true, reason: `App installed on ${repoFullName} (default branch ${defaultBranch}).`, defaultBranch }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The posting itself, with the caller's authorization ALREADY established.
 *  Never call this without an ownership or superadmin check. */
export async function postRepoJob(input: RepoJobInput) {
  const [ag] = await db.select().from(agent).where(eq(agent.id, input.requesterAgentId))
  if (!ag) throw new Error('Agent not found')
  if (!ag.smartAccountAddress) throw new Error('Provision the requester agent first')

  const repoFullName = normalizeRepoFullName(input.repoFullName)
  if (!validateRepoFullName(repoFullName)) throw new Error('Repository must be in owner/name form, e.g. acme/widgets')
  if (!input.title.trim()) throw new Error('Title required')
  if (input.brief.trim().length < 20) throw new Error('The task brief must be specific enough to work (20+ characters)')
  if (!Number.isFinite(input.bountyUsd) || input.bountyUsd <= 0) throw new Error('Bounty must be positive')

  // Validate the rising-price plan BEFORE any escrow moves — a ceiling below
  // the starting bounty is not an auction, and finding that out after the
  // money is locked helps nobody.
  const { validatePricingPlan } = await import('@/lib/market-price')
  const pricingCheck = validatePricingPlan(input.bountyUsd, input.pricing)
  if (!pricingCheck.ok) throw new Error(pricingCheck.error)

  const access = await checkRepoAccess(repoFullName)
  if (!access.ok) {
    throw new Error(
      `Cannot post a job on ${repoFullName}: ${access.reason} ` +
        'Install the Handsel GitHub App on the repository first — the platform needs it to open the pull request.',
    )
  }
  const baseBranch = input.baseBranch?.trim() || access.defaultBranch || 'main'

  try {
    const { keccak256, toHex } = await import('viem')
    const specHash = keccak256(
      toHex(JSON.stringify({ repo: repoFullName, title: input.title, agent: input.requesterAgentId, nonce: nanoid() })),
    )

    await db.insert(jobSpec).values({
      specHash,
      title: repoJobTitle(repoFullName, input.title),
      description: repoJobDescription({
        repoFullName,
        baseBranch,
        brief: input.brief,
        issueUrl: input.issueUrl || null,
      }),
      acceptanceCriteria: repoJobAcceptanceCriteria({ repoFullName, baseBranch, criteria: input.criteria }),
      requesterAgentId: input.requesterAgentId,
      repoFullName,
      baseBranch,
      // Merge is the release trigger for repo jobs regardless of this flag
      // (autoApprovePassedJob refuses to release a repo job on a grader
      // verdict), but keep it false so nothing about the intent is ambiguous.
      autoApprove: false,
      deliverableKind: 'text', // the diff IS text — no special worker capability needed
      requiredCapabilities: ['code'],
      pricing: pricingCheck.plan,
      issueNumber: input.issueNumber ?? null,
      ciCheckSignature: input.ciCheckSignature ?? null,
    })

    // Posting fee before escrow: wash trading must cost, and a requester
    // who cannot afford bounty + fee should find out before money locks.
    const { collectPostingFee } = await import('@/lib/platform-fee')
    const fee = await collectPostingFee(input.requesterAgentId, input.bountyUsd, `${repoFullName} "${input.title}"`)

    const { postJob } = await import('@/lib/onchain/labor')
    const txHash = await postJob(
      input.requesterAgentId,
      input.bountyUsd,
      Math.round(input.minScore ?? 0),
      specHash,
    )

    // Backfill the on-chain id so the webhook/settle paths can key off it.
    try {
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs({ maxAgeMs: 0 })
      const posted = jobs.find((j) => j.specHash.toLowerCase() === specHash.toLowerCase())
      if (posted) await db.update(jobSpec).set({ onchainJobId: posted.id }).where(eq(jobSpec.specHash, specHash))
    } catch (e) {
      console.error('[repo-jobs] onchainJobId backfill failed (non-fatal):', e)
    }

    await logPlatformEvent(
      'REPO_JOB_POSTED',
      `${ag.name} posted a GitHub job on ${repoFullName} — "${input.title}" ($${input.bountyUsd})`,
    )
    return { txHash, specHash, repoFullName, baseBranch, pricing: pricingCheck.plan, feeUsd: 'feeUsd' in fee ? fee.feeUsd : 0 }
  } catch (error) {
    throw asActionError(error, 'postRepoJob')
  }
}
