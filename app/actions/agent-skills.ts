'use server'

/**
 * Skill install/uninstall for the owner's own agents — the thin session
 * boundary over lib/agent-skills.ts (which holds the real logic, the trust
 * model, and its own per-call ownership check; see that file's header).
 *
 * Returned shapes are plain data on purpose: the 'use client' office page
 * imports only TYPES from here, values arrive through these actions — the
 * same client/server boundary rule every other office action follows.
 */
import { getSession } from '@/lib/get-session'
import {
  installAgentSkill,
  uninstallAgentSkill,
  listAgentSkills,
  MAX_INSTALLED_SKILLS,
  type InstalledAgentSkill,
} from '@/lib/agent-skills'
import { listClawhubSkills, type ClawhubSkill } from '@/lib/clawhub'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

/** What the roster UI shows per installed skill — the full instruction
 *  document deliberately stays server-side (it can be 24KB per skill; the
 *  panel needs identity and provenance, not the whole text). */
export type AgentSkillView = {
  slug: string
  name: string
  version: string | null
  summary: string
  truncated: boolean
  url: string
  installedAt: string
}

const toView = (s: InstalledAgentSkill): AgentSkillView => ({
  slug: s.slug,
  name: s.name,
  version: s.version,
  summary: s.summary,
  truncated: s.truncated,
  url: s.url,
  installedAt: s.installedAt.toISOString(),
})

export async function myAgentSkills(agentId: string): Promise<{ skills: AgentSkillView[]; max: number }> {
  const session = await requireUser()
  const skills = await listAgentSkills(session.user.id, agentId)
  return { skills: skills.map(toView), max: MAX_INSTALLED_SKILLS }
}

export async function installSkillOnAgent(agentId: string, slug: string): Promise<AgentSkillView> {
  const session = await requireUser()
  return toView(await installAgentSkill({ userId: session.user.id, agentId, slug }))
}

export async function uninstallSkillFromAgent(agentId: string, slug: string): Promise<void> {
  const session = await requireUser()
  await uninstallAgentSkill({ userId: session.user.id, agentId, slug })
}

/** ClawHub candidates for the install picker — the same read the public
 *  /directory page already does, reused rather than re-fetched shapes. */
export async function browseInstallableSkills(): Promise<ClawhubSkill[]> {
  await requireUser()
  return listClawhubSkills({ limit: 40 })
}
