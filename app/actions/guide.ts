'use server'

/**
 * The guide, as something you can act on rather than read.
 *
 * The checklist half of this was already honest: every step's "done" is a
 * real query, so it checks itself off as the account genuinely does things
 * and cannot drift out of sync with reality, because it IS reality.
 *
 * What it could not do was the step. Each one ended in a link that took you
 * somewhere else, and a guide you have to leave in order to follow is a
 * table of contents. So the actions the steps describe are exposed here and
 * run from inside the guide — every one a thin pass-through to the SAME
 * function the dedicated page calls, never a second implementation. A guide
 * that provisions an account slightly differently from the profile page is
 * worse than no guide, because what it taught you is then wrong.
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, agentEvent, agentTask } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { getApiKeyStatus } from '@/app/actions/settings'
import { createAgent } from '@/app/actions/agents'
import { provisionSmartAccount } from '@/app/actions/onchain'
import { setAutoMine } from '@/app/actions/mining'
import { origin } from '@/lib/origin'

/** Just enough about each agent for the inline controls to target one. */
export type GuideAgent = {
  id: string
  name: string
  provisioned: boolean
  autoMine: boolean
  runtimeType: string
  /** Null until a local worker has polled at least once. */
  lastPollAt: number | null
}

/** `runtimeType` is nullable on rows registered before it existed; those
 *  predate every runtime that is not the platform's own. */
const PLATFORM_RUNTIME = 'platform'

export async function getGuideProgress() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')

  const agents = await db.select().from(agent).where(eq(agent.userId, session.user.id))
  const agentIds = agents.map((a) => a.id)

  const [tasks, jobEvents, keyStatus] = await Promise.all([
    agentIds.length > 0
      ? db.select({ id: agentTask.id }).from(agentTask).where(inArray(agentTask.agentId, agentIds)).limit(1)
      : Promise.resolve([]),
    agentIds.length > 0
      ? db
          .select({ id: agentEvent.id, eventType: agentEvent.eventType })
          .from(agentEvent)
          .where(inArray(agentEvent.agentId, agentIds))
      : Promise.resolve([] as { id: string; eventType: string }[]),
    getApiKeyStatus(),
  ])

  return {
    hasAgent: agents.length > 0,
    hasApiKey: keyStatus.hasKey,
    hasProvisioned: agents.some((a) => a.smartAccountAddress),
    hasRunTask: tasks.length > 0,
    hasLocalWorker: agents.some((a) => a.runtimeType === 'local' && a.lastPollAt !== null),
    hasAutoMine: agents.some((a) => a.autoMine),
    hasCompletedJob: jobEvents.some((e) => e.eventType === 'JOB_COMPLETED'),
    hasErc8004: agents.some((a) => a.erc8004Id),
    // Shipped with the progress rather than fetched separately: the inline
    // controls need an agent to act on, and a second round trip would let
    // the two halves of one screen disagree about which agents exist.
    agents: agents.map<GuideAgent>((a) => ({
      id: a.id,
      name: a.name,
      provisioned: Boolean(a.smartAccountAddress),
      autoMine: Boolean(a.autoMine),
      runtimeType: a.runtimeType ?? PLATFORM_RUNTIME,
      lastPollAt: a.lastPollAt ? a.lastPollAt.getTime() : null,
    })),
  }
}

/* ── The steps, performed ────────────────────────────────────────────────
   Each is a pass-through. What is added here is that they can be reached
   without leaving the page, not that they behave differently. */

export async function guideCreateAgent(name: string): Promise<{ id: string }> {
  return createAgent({ name, description: 'Created from the guide' })
}

export async function guideProvision(agentId: string) {
  // Registers ERC-8004 as a side effect when the registry is configured
  // (app/actions/onchain.ts), which is why the last step checks itself off
  // from this same button rather than having one of its own.
  return provisionSmartAccount(agentId)
}

export async function guideSetAutoMine(agentId: string, enabled: boolean) {
  return setAutoMine(agentId, enabled)
}

/**
 * Run one task on an agent, from the guide.
 *
 * `lib/agent-tasks.ts` takes the callback URL as an argument rather than
 * reading it, because the API route builds it from the incoming request. A
 * server action has no request to read, so it comes from the configured
 * origin — the same value every other server-initiated dispatch uses.
 */
export async function guideRunTask(agentId: string, task: string): Promise<{ taskId: string }> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const trimmed = task.trim()
  if (!trimmed) throw new Error('Write a task first')
  if (trimmed.length > 4000) throw new Error('Task must be 4000 characters or fewer')

  const [ag] = await db.select().from(agent).where(eq(agent.id, agentId))
  // Ownership checked HERE rather than left to the dispatcher: an agent id
  // is a value the browser sends, and "the other side checks it" is not a
  // property this side gets to assume.
  if (!ag || ag.userId !== session.user.id) throw new Error('Agent not found')

  const { runAgentTask } = await import('@/lib/agent-tasks')
  return runAgentTask({ agent: ag, task: trimmed, callbackUrl: `${origin()}/api/runtime/callback` })
}

/** The state of a task the guide started, for the inline result panel. */
export async function guideTaskState(taskId: string) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const [row] = await db.select().from(agentTask).where(eq(agentTask.id, taskId))
  if (!row || row.userId !== session.user.id) return null
  return {
    status: row.status,
    // Trimmed on the server: this renders into a small panel, and shipping a
    // whole deliverable to draw a few lines of it is waste on a 2s poll.
    output: row.output ? row.output.slice(0, 1200) : null,
    error: row.error ?? null,
  }
}
