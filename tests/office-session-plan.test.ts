/**
 * Planning: the default plan a session gets without a model, and the
 * mapping from the delegation planner's JSON onto session tasks.
 */
import { describe, expect, it } from 'vitest'
import { defaultAcceptanceCriteria, defaultPlan, planFromSubtasks, taskIdFor, titleFromGoal } from '@/lib/office-session-plan'
import { DEFAULT_WORKSPACE_GRANT } from '@/lib/office-session'

const ws = { workdir: '/w', ...DEFAULT_WORKSPACE_GRANT }

describe('defaultPlan', () => {
  it('a local coding session is one coding task verified by the command and a review', () => {
    const plan = defaultPlan({ goal: 'Fix the token refresh bug\n\nIt 500s on expiry.', kind: 'local_coding', wave: 1, verifyCommand: 'npm test', workspace: ws, workerAgentId: 'w1' })
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ id: 'w1-fix-the-token-refresh-bug', kind: 'coding', settlement: 'internal', bountyUsd: 0, assignedWorkerId: 'w1', riskTier: 'E2' })
    expect(plan[0].verify).toEqual({ command: 'npm test', independentReview: true })
    expect(plan[0].acceptanceCriteria).toBeTruthy()
    expect(plan[0].acceptanceCriteria).toContain('`npm test` exits 0')
    expect(plan[0].acceptanceCriteria).toContain('No new dependency')
    expect(plan[0].brief).toContain('It 500s on expiry.')
  })

  it('a text session without a workspace is a text task with no command', () => {
    const plan = defaultPlan({ goal: 'Summarise the week', kind: 'one_shot', wave: 3, verifyCommand: null, workspace: null, workerAgentId: null })
    expect(plan[0]).toMatchObject({ id: 'w3-summarise-the-week', kind: 'text', riskTier: 'E0' })
    expect(plan[0].verify?.command).toBeNull()
  })

  it('titles are cut at a word boundary; ids are unique and safe', () => {
    const long = 'a'.repeat(50) + ' ' + 'b'.repeat(50)
    expect(titleFromGoal(long).endsWith('…')).toBe(true)
    expect(titleFromGoal(long).length).toBeLessThanOrEqual(81)
    const taken = new Set<string>()
    expect(taskIdFor('Fix it!', 1, taken)).toBe('w1-fix-it')
    expect(taskIdFor('Fix it!', 1, taken)).toBe('w1-fix-it-2')
    expect(taskIdFor('../../etc', 2, taken)).toBe('w2-etc')
    expect(defaultAcceptanceCriteria({ verifyCommand: null, workspace: null })).toContain('Existing tests')
  })
})

describe('planFromSubtasks', () => {
  it('maps titles to ids, dependsOn and reviewOf to dependencies, drops integration steps, keeps bounties as escrow', () => {
    const tasks = planFromSubtasks(
      [
        { title: 'Research', description: 'r', acceptanceCriteria: 'c', bountyUsd: 2 },
        { title: 'Write', description: 'w', acceptanceCriteria: 'c', bountyUsd: 3, dependsOn: ['Research'] },
        { title: 'Review write', description: 'rv', acceptanceCriteria: 'c', bountyUsd: 1, reviewOf: 'Write' },
        { title: 'Integration', description: 'i', acceptanceCriteria: 'c', bountyUsd: 0, isIntegration: true },
      ],
      1,
    )
    expect(tasks.map((t) => t.id)).toEqual(['w1-research', 'w1-write', 'w1-review-write'])
    expect(tasks[1].dependsOn).toEqual(['w1-research'])
    expect(tasks[2]).toMatchObject({ kind: 'review', dependsOn: ['w1-write'], settlement: 'escrow', bountyUsd: 1 })
    expect(tasks.every((t) => t.settlement === 'escrow')).toBe(true)
  })
})
