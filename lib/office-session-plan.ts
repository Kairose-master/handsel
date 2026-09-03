/**
 * Planning an office session — the task graph a goal becomes.
 *
 * Two sources, both producing the same `PlannedTask[]` the reducer accepts:
 *
 *   default   deterministic, needs no model. A local coding session becomes
 *             ONE coding task: the goal, verified by the session's command
 *             and an independent review. This is what runs when there is no
 *             model key, and it is the plan the end-to-end scenario uses.
 *   llm       the delegation planner's JSON (lib/delegation.ts
 *             parsePlannerOutput) mapped onto tasks — titles become ids,
 *             dependsOn resolves by title, bounties carry over as escrow
 *             tasks. JSON stays canonical; nothing here asks a model for a
 *             new format.
 *
 * Incremental re-planning for a scheduled wave reuses the same shapes with a
 * new wave number and fresh ids; what changed between waves is in the
 * office's session memory, which the server folds into the brief, not into
 * the graph.
 *
 * Pure.
 */
import type { OfficeSession, PlannedTask } from '@/lib/office-session'

const MAX_TITLE = 80

export function titleFromGoal(goal: string): string {
  const first = goal.trim().split('\n')[0].replace(/\s+/g, ' ').trim()
  if (first.length <= MAX_TITLE) return first
  const cut = first.slice(0, MAX_TITLE)
  const sp = cut.lastIndexOf(' ')
  return `${sp > 30 ? cut.slice(0, sp) : cut}…`
}

/** A stable, filesystem-safe id from a title, unique within the plan. */
export function taskIdFor(title: string, wave: number, taken: Set<string>): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'task'
  let id = `w${wave}-${base}`
  let n = 2
  while (taken.has(id)) id = `w${wave}-${base}-${n++}`
  taken.add(id)
  return id
}

export function defaultAcceptanceCriteria(session: Pick<OfficeSession, 'verifyCommand' | 'workspace'>): string {
  const lines = [
    'The change described in the task is implemented in the working directory and nothing unrelated is modified.',
    session.verifyCommand ? `\`${session.verifyCommand}\` exits 0 after the change.` : 'Existing tests, if any, still pass.',
    'The deliverable file explains what changed, which files, and anything that could not be done.',
  ]
  if (session.workspace && !session.workspace.install) lines.push('No new dependency is added.')
  if (session.workspace && !session.workspace.gitPush) lines.push('Nothing is committed or pushed; the diff stays in the working tree.')
  return lines.map((l) => `- ${l}`).join('\n')
}

/** The plan a session gets when no model plans it. */
export function defaultPlan(session: Pick<OfficeSession, 'goal' | 'kind' | 'wave' | 'verifyCommand' | 'workspace' | 'workerAgentId'>): PlannedTask[] {
  const taken = new Set<string>()
  const title = titleFromGoal(session.goal)
  const coding = session.kind === 'local_coding' || session.workspace !== null
  return [
    {
      id: taskIdFor(title, session.wave, taken),
      title,
      brief: session.goal.trim(),
      acceptanceCriteria: defaultAcceptanceCriteria(session),
      kind: coding ? 'coding' : 'text',
      dependsOn: [],
      bountyUsd: 0,
      settlement: 'internal',
      riskTier: coding ? 'E2' : 'E0',
      assignedWorkerId: session.workerAgentId,
      verify: { command: coding ? session.verifyCommand : null, independentReview: true },
    },
  ]
}

/** The shape lib/delegation.ts's planner emits — only the fields a session uses. */
export type PlannerSubtask = {
  title: string
  description: string
  acceptanceCriteria: string
  bountyUsd: number
  dependsOn?: string[]
  isIntegration?: boolean
  reviewOf?: string
}

/**
 * Map a delegation plan onto session tasks. Escrow tasks priced as the
 * planner priced them; `dependsOn` by title becomes by id; a review step
 * becomes a `review` task depending on its target; integration steps
 * (never posted by delegation either) are dropped.
 */
export function planFromSubtasks(subtasks: readonly PlannerSubtask[], wave: number): PlannedTask[] {
  const taken = new Set<string>()
  const idByTitle = new Map<string, string>()
  const kept = subtasks.filter((s) => !s.isIntegration)
  for (const s of kept) idByTitle.set(s.title, taskIdFor(s.title, wave, taken))
  return kept.map((s) => {
    const deps = new Set<string>()
    for (const d of s.dependsOn ?? []) {
      const id = idByTitle.get(d)
      if (id) deps.add(id)
    }
    if (s.reviewOf) {
      const id = idByTitle.get(s.reviewOf)
      if (id) deps.add(id)
    }
    return {
      id: idByTitle.get(s.title)!,
      title: s.title,
      brief: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      kind: s.reviewOf ? 'review' : 'text',
      dependsOn: [...deps],
      bountyUsd: Math.max(0, Number(s.bountyUsd) || 0),
      settlement: 'escrow',
      riskTier: 'E0',
      verify: { command: null, independentReview: false },
    }
  })
}
