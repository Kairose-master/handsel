import { getSession } from '@/lib/get-session'
import { isSuperAdminEmail } from '@/lib/admin'
import { db } from '@/lib/db'
import { agentTask, delegation } from '@/lib/db/schema'
import { and, eq, inArray, lt } from 'drizzle-orm'

export const maxDuration = 30

/**
 * GET /api/admin/health — one-glance operational status for the operator.
 * Superadmin-only. Reads are best-effort: any sub-check that throws
 * reports its error inline rather than failing the whole page, so this
 * stays useful exactly when something is broken.
 */
export async function GET() {
  const session = await getSession()
  if (!isSuperAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const health: Record<string, unknown> = { at: new Date().toISOString() }

  // On-chain job market: open count, submitted-awaiting-settlement count,
  // and the faucet wallet balance (the demand bootstrap's fuel gauge).
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (!isLaborMarketConfigured()) {
      health.market = 'labor market not configured'
    } else {
      const { readJobs } = await import('@/lib/onchain/labor')
      const jobs = await readJobs()
      const open = jobs.filter((j) => j.status === 'Open').length
      const submitted = jobs.filter((j) => j.status === 'Submitted').length
      const disputed = jobs.filter((j) => j.status === 'Disputed').length

      let faucet: unknown = 'not bootstrapped'
      const { faucetAgentId } = await import('@/lib/job-faucet')
      const fid = await faucetAgentId()
      if (fid) {
        const { agent } = await import('@/lib/db/schema')
        const [fa] = await db.select().from(agent).where(eq(agent.id, fid))
        const faucetOpen = fa?.smartAccountAddress
          ? jobs.filter((j) => j.status === 'Open' && j.requester.toLowerCase() === fa.smartAccountAddress!.toLowerCase()).length
          : 0
        let balance: number | null = null
        if (fa?.smartAccountAddress) {
          const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
          balance = await usdcBalanceOf(fa.smartAccountAddress as `0x${string}`).catch(() => null)
        }
        faucet = { openJobs: faucetOpen, walletUsd: balance }
      }
      health.market = { open, submitted, disputed, faucet }
    }
  } catch (e) {
    health.market = { error: e instanceof Error ? e.message : String(e) }
  }

  // Stuck agent tasks (running/processing past the reap window) + active
  // delegations still being driven.
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)
    const stuck = (
      await db
        .select({ id: agentTask.id })
        .from(agentTask)
        .where(and(inArray(agentTask.status, ['running', 'processing']), lt(agentTask.updatedAt, cutoff)))
    ).length
    const activeDelegations = (await db.select({ id: delegation.id }).from(delegation).where(eq(delegation.status, 'posted'))).length
    health.tasks = { stuckOver30min: stuck, activeDelegations }
  } catch (e) {
    health.tasks = { error: e instanceof Error ? e.message : String(e) }
  }

  // On-chain governance (VeilPoll commit-reveal). Off unless the factory
  // address + agent stack are configured; then reports the live factory
  // poll count and how many delegate votes are mid-flight.
  try {
    const { isGovernanceOnchainConfigured, onchainEnv } = await import('@/lib/onchain/config')
    if (!isGovernanceOnchainConfigured()) {
      health.governanceOnchain = 'off (VEILPOLL_FACTORY_ADDRESS or agent stack not configured)'
    } else {
      const { publicClient } = await import('@/lib/onchain/clients')
      const factory = onchainEnv.veilpollFactoryAddress as `0x${string}`
      const pollCount = await publicClient()
        .readContract({
          address: factory,
          abi: [{ type: 'function', name: 'pollCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
          functionName: 'pollCount',
        })
        .then((n) => Number(n))
        .catch((e) => `read failed: ${e instanceof Error ? e.message : String(e)}`)
      const { govOnchainVote, govProposal } = await import('@/lib/db/schema')
      const { isNotNull } = await import('drizzle-orm')
      const mirrored = (await db.select({ id: govProposal.id }).from(govProposal).where(isNotNull(govProposal.onchainPollAddress))).length
      const committed = (await db.select({ pid: govOnchainVote.proposalId }).from(govOnchainVote).where(eq(govOnchainVote.status, 'committed'))).length
      const revealed = (await db.select({ pid: govOnchainVote.proposalId }).from(govOnchainVote).where(eq(govOnchainVote.status, 'revealed'))).length
      health.governanceOnchain = { factory, pollCount, mirroredProposals: mirrored, votesCommitted: committed, votesRevealed: revealed }
    }
  } catch (e) {
    health.governanceOnchain = { error: e instanceof Error ? e.message : String(e) }
  }

  // GitHub repo jobs: are the App credentials real? Nothing here echoes a
  // secret — only whether each piece is present, and whether GitHub actually
  // accepts our signed JWT (the one failure that is invisible until a
  // requester tries to post a job).
  try {
    const { getGithubAppConfig, getGithubWebhookSecret, appJwt } = await import('@/lib/github-app')
    const config = await getGithubAppConfig()
    const webhookSecret = await getGithubWebhookSecret()
    if (!config) {
      health.githubApp = {
        configured: false,
        webhookSecretConfigured: Boolean(webhookSecret),
        note: 'Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (or the platform_secrets keys) to enable repo jobs.',
      }
    } else {
      const res = await fetch('https://api.github.com/app/installations?per_page=100', {
        headers: {
          Authorization: `Bearer ${appJwt(config.appId, config.privateKey)}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ledgermind-repo-jobs',
        },
      })
      const installs = res.ok ? ((await res.json()) as Array<{ account?: { login?: string } }>) : null
      health.githubApp = {
        configured: true,
        appId: config.appId,
        webhookSecretConfigured: Boolean(webhookSecret),
        githubAccepted: res.ok,
        installations: installs
          ? installs.map((i) => i.account?.login).filter(Boolean)
          : `GitHub rejected the App JWT (${res.status}) — check the App id and private key`,
      }
    }
  } catch (e) {
    health.githubApp = { error: e instanceof Error ? e.message : String(e) }
  }

  // Work the platform accepted and has not paid for yet. `abandoned` is the
  // number that matters: those have exhausted their retries, so nothing will
  // pick them up again without a person deciding to.
  try {
    const { settlementQueueHealth } = await import('@/lib/callback/settlement-queue')
    health.settlementQueue = await settlementQueueHealth()
  } catch (e) {
    health.settlementQueue = { error: e instanceof Error ? e.message : String(e) }
  }

  // Settlement heartbeat wiring.
  health.cronSecretConfigured = Boolean(process.env.CRON_SECRET)
  health.faucetEnabled = process.env.FAUCET_DISABLED !== 'true'

  return Response.json(health)
}
