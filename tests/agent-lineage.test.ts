/**
 * The selection rules (lib/agent-lineage.ts). These decide that an agent
 * should be copied or retired, so every branch is a case here — including
 * the three that exist only to stop a wrong irreversible call: an unreadable
 * balance, a newborn inside its grace period, and a parent that cannot
 * afford to breed.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIFECYCLE_POLICY,
  MAX_GENOME_SKILLS,
  MAX_GENOME_INSTRUCTION_CHARS,
  applyMutation,
  buildLineage,
  decideLifecycle,
  scoreFitness,
  type AgentGenome,
} from '@/lib/agent-lineage'

const DAY = 24 * 60 * 60 * 1000
const genome = (over: Partial<AgentGenome> = {}): AgentGenome => ({
  customInstructions: 'Write clearly.',
  skillSlugs: ['research'],
  connector: null,
  model: null,
  ...over,
})
const outcomes = (passed: number, failed: number) => [
  ...Array.from({ length: passed }, () => ({ at: new Date(), passed: true })),
  ...Array.from({ length: failed }, () => ({ at: new Date(), passed: false })),
]

describe('scoreFitness', () => {
  it('counts real verdicts', () => {
    expect(scoreFitness(outcomes(4, 1))).toEqual({ passed: 4, failed: 1, total: 5, passRate: 0.8 })
  })

  it('an ungraded agent has no pass rate, not a zero one', () => {
    expect(scoreFitness([])).toEqual({ passed: 0, failed: 0, total: 0, passRate: null })
  })
})

describe('decideLifecycle', () => {
  const alive = { earnedUsd: 1, ageMs: 30 * DAY }

  it('replicates a proven, funded agent and names the seed', () => {
    expect(
      decideLifecycle({ fitness: scoreFitness(outcomes(9, 1)), heldUsd: 2, ...alive }),
    ).toEqual({ action: 'replicate', why: 'thriving', seedUsd: DEFAULT_LIFECYCLE_POLICY.seedUsd })
  })

  it('holds a proven agent that cannot afford to breed without dipping into its reserve', () => {
    const justUnder = DEFAULT_LIFECYCLE_POLICY.seedUsd + DEFAULT_LIFECYCLE_POLICY.reserveUsd - 0.01
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(9, 1)), heldUsd: justUnder, ...alive })).toEqual({
      action: 'hold',
      why: 'no-surplus',
    })
  })

  it('retires an agent whose graded work mostly fails', () => {
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(1, 9)), heldUsd: 5, ...alive })).toEqual({
      action: 'retire',
      why: 'outcompeted',
    })
  })

  it('never decides anything on an unreadable balance', () => {
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(1, 9)), heldUsd: null, ...alive })).toEqual({
      action: 'hold',
      why: 'unreadable',
    })
  })

  it('will not judge quality on thin evidence', () => {
    // Four graded jobs, all failed — still under minGraded, still no verdict.
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(0, 4)), heldUsd: 5, ...alive })).toEqual({
      action: 'hold',
      why: 'insufficient-evidence',
    })
  })

  it('retires a broke, unearning agent past its grace period', () => {
    expect(decideLifecycle({ fitness: scoreFitness([]), heldUsd: 0, earnedUsd: 0, ageMs: 30 * DAY })).toEqual({
      action: 'retire',
      why: 'starved',
    })
  })

  it('spares a broke newborn inside its grace period', () => {
    expect(decideLifecycle({ fitness: scoreFitness([]), heldUsd: 0, earnedUsd: 0, ageMs: 1 * DAY })).toEqual({
      action: 'hold',
      why: 'insufficient-evidence',
    })
  })

  it('does not starve an agent that is broke but still earning', () => {
    expect(decideLifecycle({ fitness: scoreFitness([]), heldUsd: 0, earnedUsd: 3, ageMs: 30 * DAY })).toEqual({
      action: 'hold',
      why: 'insufficient-evidence',
    })
  })

  it('calls a failing broke agent outcompeted, not starved — that is what its lineage should learn', () => {
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(1, 9)), heldUsd: 0, earnedUsd: 0, ageMs: 30 * DAY })).toEqual({
      action: 'retire',
      why: 'outcompeted',
    })
  })

  it('holds a merely adequate agent — neither good enough to copy nor bad enough to drop', () => {
    expect(decideLifecycle({ fitness: scoreFitness(outcomes(6, 4)), heldUsd: 5, ...alive })).toEqual({
      action: 'hold',
      why: 'healthy',
    })
  })

  it('takes a caller policy override', () => {
    expect(
      decideLifecycle({
        fitness: scoreFitness(outcomes(6, 4)),
        heldUsd: 5,
        ...alive,
        policy: { replicatePassRate: 0.6 },
      }).action,
    ).toBe('replicate')
  })
})

describe('the copied skill cap', () => {
  it('never drifts from the installer\'s own limit', async () => {
    // MAX_GENOME_SKILLS is copied rather than imported so lib/agent-lineage.ts
    // stays free of pg and importable from a client component. This is the
    // pin that makes the copy safe.
    const { MAX_INSTALLED_SKILLS } = await import('@/lib/agent-skills')
    expect(MAX_GENOME_SKILLS).toBe(MAX_INSTALLED_SKILLS)
  })
})

describe('applyMutation', () => {
  it('adds a skill', () => {
    expect(applyMutation(genome(), { kind: 'add-skill', slug: 'seo' }).skillSlugs).toEqual(['research', 'seo'])
  })

  it('is a no-op rather than a duplicate when the skill is already there', () => {
    expect(applyMutation(genome(), { kind: 'add-skill', slug: 'research' }).skillSlugs).toEqual(['research'])
  })

  it('refuses to exceed the installer’s own slot cap', () => {
    const full = genome({ skillSlugs: Array.from({ length: MAX_GENOME_SKILLS }, (_, i) => `s${i}`) })
    expect(applyMutation(full, { kind: 'add-skill', slug: 'one-more' }).skillSlugs).toHaveLength(MAX_GENOME_SKILLS)
  })

  it('drops a skill, and ignores dropping one that is absent', () => {
    expect(applyMutation(genome(), { kind: 'drop-skill', slug: 'research' }).skillSlugs).toEqual([])
    expect(applyMutation(genome(), { kind: 'drop-skill', slug: 'nope' }).skillSlugs).toEqual(['research'])
  })

  it('appends a directive to the instructions', () => {
    expect(applyMutation(genome(), { kind: 'refine-instructions', directive: 'Cite sources.' }).customInstructions).toBe(
      'Write clearly.\nCite sources.',
    )
  })

  it('caps inherited instructions so a lineage cannot grow an unbounded prompt', () => {
    const long = genome({ customInstructions: 'x'.repeat(MAX_GENOME_INSTRUCTION_CHARS) })
    expect(applyMutation(long, { kind: 'refine-instructions', directive: 'more' }).customInstructions).toHaveLength(
      MAX_GENOME_INSTRUCTION_CHARS,
    )
  })

  it('an empty directive changes nothing', () => {
    expect(applyMutation(genome(), { kind: 'refine-instructions', directive: '   ' }).customInstructions).toBe(
      'Write clearly.',
    )
  })

  it('never mutates the parent genome in place — heredity copies, it does not move', () => {
    const parent = genome()
    applyMutation(parent, { kind: 'add-skill', slug: 'seo' })
    expect(parent.skillSlugs).toEqual(['research'])
  })
})

describe('buildLineage', () => {
  it('computes generation depth from the founder', () => {
    const { depthOf, maxDepth, childrenOf } = buildLineage([
      { childAgentId: 'founder', parentAgentId: null },
      { childAgentId: 'kid', parentAgentId: 'founder' },
      { childAgentId: 'grandkid', parentAgentId: 'kid' },
    ])
    expect(depthOf.get('founder')).toBe(0)
    expect(depthOf.get('grandkid')).toBe(2)
    expect(maxDepth).toBe(2)
    expect(childrenOf.get('founder')).toEqual(['kid'])
  })

  it('terminates on a corrupt cycle instead of hanging the sweep', () => {
    const { depthOf } = buildLineage([
      { childAgentId: 'a', parentAgentId: 'b' },
      { childAgentId: 'b', parentAgentId: 'a' },
    ])
    expect(depthOf.get('a')).toBeLessThanOrEqual(2)
  })

  it('treats an orphan (parent row never written) as a founder', () => {
    const { depthOf } = buildLineage([{ childAgentId: 'orphan', parentAgentId: 'ghost' }])
    expect(depthOf.get('orphan')).toBe(1)
  })
})
