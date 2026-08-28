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
import {
  evaluateSkillWindows,
  gradedOutcomeFromEvent,
  GRADED_EVENTS,
  type SkillEval,
  type GradedOutcome,
} from '@/lib/skill-eval'
import { db } from '@/lib/db'
import { agentEvent } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

/** What the roster UI shows per installed skill — the full instruction
 *  document deliberately stays server-side (it can be 24KB per skill; the
 *  panel needs identity and provenance, not the whole text). `eval` is
 *  lib/skill-eval.ts's before/after window comparison of independently
 *  graded outcomes — correlation only, delta gated on sample size; that
 *  file's header carries the caveats the UI repeats. */
export type AgentSkillView = {
  slug: string
  name: string
  version: string | null
  summary: string
  truncated: boolean
  url: string
  installedAt: string
  eval: SkillEval | null
}

const toView = (s: InstalledAgentSkill, evalResult: SkillEval | null = null): AgentSkillView => ({
  slug: s.slug,
  name: s.name,
  version: s.version,
  summary: s.summary,
  truncated: s.truncated,
  url: s.url,
  installedAt: s.installedAt.toISOString(),
  eval: evalResult,
})

/** The agent's independently graded outcomes, once — every skill's window
 *  split reuses the same list. Failure degrades to "no eval", never to a
 *  broken skills panel. */
async function gradedOutcomesFor(agentId: string): Promise<GradedOutcome[]> {
  try {
    const rows = await db
      .select({ eventType: agentEvent.eventType, createdAt: agentEvent.createdAt })
      .from(agentEvent)
      .where(and(eq(agentEvent.agentId, agentId), inArray(agentEvent.eventType, [...GRADED_EVENTS])))
    return rows
      .map((r) => gradedOutcomeFromEvent(r.eventType, r.createdAt))
      .filter((o): o is GradedOutcome => o !== null)
  } catch (error) {
    console.error('[agent-skills] graded-outcome read failed (skills shown without eval):', error)
    return []
  }
}

export async function myAgentSkills(agentId: string): Promise<{ skills: AgentSkillView[]; max: number }> {
  const session = await requireUser()
  const skills = await listAgentSkills(session.user.id, agentId)
  const outcomes = skills.length > 0 ? await gradedOutcomesFor(agentId) : []
  return {
    skills: skills.map((s) => toView(s, evaluateSkillWindows(s.installedAt, outcomes))),
    max: MAX_INSTALLED_SKILLS,
  }
}

export async function installSkillOnAgent(agentId: string, slug: string): Promise<AgentSkillView> {
  const session = await requireUser()
  const installed = await installAgentSkill({ userId: session.user.id, agentId, slug })
  return toView(installed, evaluateSkillWindows(installed.installedAt, await gradedOutcomesFor(agentId)))
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
