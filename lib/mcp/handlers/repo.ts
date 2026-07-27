/**
 * MCP tools — repo.
 *
 * GitHub repo jobs: a diff becomes a PR, CI grades it, merge pays.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'

export async function handleRepo(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth, origin } = ctx
  switch (name) {
    case 'github_status': {
      const { githubConnectionFor } = await import('@/lib/github-identity')
      const conn = await githubConnectionFor(auth.userId)
      if (!conn.loginEnabled) {
        return toolText(id, 'This deployment has no GitHub App configured, so repo jobs are unavailable here.', true)
      }
      const connectUrl = `${origin}/api/github/oauth/start?next=/jobs`
      if (!conn.connected) {
        return toolText(
          id,
          'Your Ledgermind account is not linked to GitHub yet.\n\n' +
            `Link it here (opens in a browser, one click): ${connectUrl}\n\n` +
            'Once linked I can list your repositories and post jobs against them without you typing owner/name.',
        )
      }
      if (conn.error) {
        return toolText(id, `Connected as ${conn.login}, but: ${conn.error}\nReconnect: ${connectUrl}`, true)
      }
      if (conn.repos.length === 0) {
        return toolText(
          id,
          `Connected as ${conn.login}, but the Ledgermind GitHub App is not installed on any of your repositories.\n\n` +
            `Install it on the repo you want worked: ${conn.installUrl}\n` +
            'The App is what opens the pull request from a worker\'s diff — without it a job cannot be delivered.',
        )
      }
      const list = conn.repos
        .slice(0, 50)
        .map((r) => `  ${r.fullName}${r.private ? ' (private)' : ''} — default branch ${r.defaultBranch}`)
        .join('\n')
      return toolText(
        id,
        `Connected as ${conn.login}. ${conn.repos.length} repositor${conn.repos.length === 1 ? 'y is' : 'ies are'} ready for repo jobs:\n\n${list}\n\n` +
          `Post one with post_repo_job. Install on more: ${conn.installUrl}`,
      )
    }
    case 'repo_job_status': {
      const { jobSpec } = await import('@/lib/db/schema')
      const mine = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const myIds = new Set(mine.map((a) => a.id))
      if (myIds.size === 0) return toolText(id, 'No agents on this account yet.')

      const specs = (await db.select().from(jobSpec))
        .filter((sp) => sp.repoFullName && sp.requesterAgentId && myIds.has(sp.requesterAgentId))
        .filter((sp) => (args.job_id === undefined ? true : sp.onchainJobId === Number(args.job_id)))
      if (specs.length === 0) {
        return toolText(id, args.job_id === undefined ? 'You have no GitHub repo jobs yet — post one with post_repo_job.' : `No repo job #${args.job_id} on this account.`)
      }

      const { readJobs } = await import('@/lib/onchain/labor')
      const chain = await readJobs().catch(() => [])
      const statusById = new Map(chain.map((j) => [j.id, j.status]))

      const lines = specs.map((sp) => {
        const onchain = sp.onchainJobId === null ? 'not posted' : (statusById.get(sp.onchainJobId) ?? 'unknown')
        const pr = sp.prNumber ? `https://github.com/${sp.repoFullName}/pull/${sp.prNumber}` : null
        const ci =
          sp.ciStatus === 'success'
            ? 'CI passed'
            : sp.ciStatus === 'failure'
              ? 'CI FAILED'
              : sp.ciStatus === 'pending'
                ? 'CI running'
                : sp.ciStatus === 'merged'
                  ? 'merged (CI result predates this record)' // legacy rows: the merge used to overwrite the CI outcome
                  : 'no CI result yet'
        return [
          `#${sp.onchainJobId ?? '?'} ${sp.title}`,
          `   repo    ${sp.repoFullName} @ ${sp.baseBranch ?? 'default'}`,
          `   escrow  ${onchain}`,
          pr ? `   PR      ${pr} — ${ci}` : '   PR      not opened yet (no diff submitted, or the diff did not apply)',
        ].join('\n')
      })
      return toolText(
        id,
        `${lines.join('\n\n')}\n\nMerging a pull request is what releases its escrow — CI passing alone never moves money.`,
      )
    }
    case 'check_repo_access': {
      const repo = String(args.repo ?? '').trim()
      const { checkRepoAccess } = await import('@/app/actions/repo-jobs')
      const access = await checkRepoAccess(repo)
      return toolText(
        id,
        access.ok
          ? `${access.reason}\nYou can post a repo job here with post_repo_job.`
          : `Not usable yet: ${access.reason}\n\nInstall the Ledgermind GitHub App on ${repo} (the repo owner does this once) and try again.`,
        !access.ok,
      )
    }
    case 'post_repo_job': {
      const repo = String(args.repo ?? '').trim()
      const bounty = Number(args.bounty_usd)
      if (!repo || !Number.isFinite(bounty) || bounty <= 0) return toolText(id, 'repo and a positive bounty_usd are required.', true)
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      const requester = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress)
      if (!requester) return toolText(id, 'No provisioned agent to escrow the bounty — create_worker_agent adds one.', true)

      try {
        // The agent was just proven to belong to auth.userId above, so the
        // authorization this call requires is already established. Calling the
        // server ACTION here would fail every time: it re-checks getSession(),
        // and an MCP request carries a bearer token, never a browser session.
        const { postRepoJob } = await import('@/lib/repo-job-post')
        const res = await postRepoJob({
          requesterAgentId: requester.id,
          repoFullName: repo,
          baseBranch: args.base_branch ? String(args.base_branch) : undefined,
          title: String(args.title ?? ''),
          brief: String(args.brief ?? ''),
          issueUrl: args.issue_url ? String(args.issue_url) : undefined,
          criteria: args.criteria ? String(args.criteria) : undefined,
          bountyUsd: bounty,
          pricing:
            args.price_ceiling_usd === undefined
              ? null
              : {
                  ceilingUsd: Number(args.price_ceiling_usd),
                  stepUsd: args.price_step_usd === undefined ? undefined : Number(args.price_step_usd),
                  stepMinutes: args.price_step_minutes === undefined ? undefined : Number(args.price_step_minutes),
                },
        })
        return toolText(
          id,
          `Posted a GitHub job on ${res.repoFullName} (base ${res.baseBranch}), $${bounty} escrowed by ${requester.name}.\n\n` +
            'A worker will submit a unified diff; the platform opens the pull request from it and your own CI grades it. ' +
            'Merging the PR pays the worker; closing it unmerged refunds you and reposts the job.' +
            (res.pricing ? `\n\nRising price: if nobody claims it, the bounty steps up $${res.pricing.stepUsd} every ${res.pricing.stepMinutes}m to a ceiling of $${res.pricing.ceilingUsd}. The first claim sets the clearing price.` : ''),
        )
      } catch (error) {
        return toolText(id, error instanceof Error ? error.message : String(error), true)
      }
    }
    default:
      return null
  }
}
