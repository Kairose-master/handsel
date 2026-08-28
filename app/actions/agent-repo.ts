'use server'

/**
 * Portfolio-repo binding for the owner's own agents — session boundary over
 * lib/agent-repo.ts (which holds the real logic, the bind validation, and
 * the settlement mirror; its header is the spec). The repo PICKER reuses
 * getGithubConnection from app/actions/repo-jobs.ts — same intersection,
 * same App install flow the repo-jobs pipeline already taught users.
 */
import { getSession } from '@/lib/get-session'
import {
  bindAgentRepo,
  unbindAgentRepo,
  agentRepoBinding,
  agentRepoCommits,
} from '@/lib/agent-repo'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

export type AgentRepoView = {
  repoFullName: string
  repoUrl: string
  boundAt: string
  commits: Array<{ jobId: number; path: string; fileUrl: string; committedAt: string }>
}

/** The binding + mirrored-commit history for one of my agents (null when
 *  no repo is bound). Read path checks ownership like every mutation. */
export async function myAgentRepo(agentId: string): Promise<AgentRepoView | null> {
  const session = await requireUser()
  const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!row || row.userId !== session.user.id) throw new Error('Not your agent')
  const binding = await agentRepoBinding(agentId)
  if (!binding) return null
  const commits = await agentRepoCommits(session.user.id, agentId)
  return {
    repoFullName: binding.repoFullName,
    repoUrl: `https://github.com/${binding.repoFullName}`,
    boundAt: binding.boundAt.toISOString(),
    commits: commits.map((c) => ({
      jobId: c.jobId,
      path: c.path,
      fileUrl: `https://github.com/${c.repoFullName}/blob/HEAD/${c.path}`,
      committedAt: c.committedAt.toISOString(),
    })),
  }
}

export async function bindRepoToAgent(agentId: string, repoFullName: string): Promise<AgentRepoView> {
  const session = await requireUser()
  await bindAgentRepo({ userId: session.user.id, agentId, repoFullName })
  const view = await myAgentRepo(agentId)
  if (!view) throw new Error('Binding did not persist')
  return view
}

export async function unbindRepoFromAgent(agentId: string): Promise<void> {
  const session = await requireUser()
  await unbindAgentRepo({ userId: session.user.id, agentId })
}
