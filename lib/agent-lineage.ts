/**
 * Agent lineage — heredity, fitness and selection for a market of workers.
 *
 * The idea is not ours and the prior art is worth naming, because what each
 * experiment got WRONG is what this module is shaped around.
 *
 *  - **The Automaton** (Sigil Wen / Conway Research, 2026): an agent that
 *    pays for its own compute, dies at zero, and on crossing a balance
 *    threshold spins up a copy, teaches it what it learned and seeds it with
 *    cash. Survival pressure is real; the fitness signal is voluntary human
 *    payment, which nothing independent verifies.
 *  - **Spore.fun** (Phala, 2024–25; arXiv:2506.04236): on-chain agents that
 *    serialize a JSON genome, mutate it, and spawn offspring when their token
 *    passes $500k market cap — dying on a 14-day timer otherwise. Five
 *    generations ran. The paper's own verdict is that no open-ended evolution
 *    occurred, and its diagnosis is the part that matters here: speculative
 *    attention became "a more powerful, albeit volatile, fitness gradient
 *    than any intrinsic trait". Market cap selects for hype, so hype is what
 *    it bred.
 *
 * That diagnosis is precisely the gap this platform already fills. Handsel's
 * fitness signal is not attention and not self-report: it is the independent
 * grader's verdict on delivered work (the same GRADED_PASS/FAIL event set
 * lib/skill-eval.ts, lib/agent-stats.ts and the Labor Index already agree on)
 * plus USDC that actually settled out of escrow. A worker cannot become fit
 * here by being popular, and it cannot grade itself. Selection on that signal
 * is selection on competence.
 *
 * Four rules, each one a correction of something the prior art did:
 *
 *  1. **Fitness is graded work, never attention or self-report.**
 *  2. **Death is retirement, not self-destruction.** Spore.fun burned failed
 *     agents and recycled their capital. Here an agent's history — its
 *     signed work proofs, its credit score, its failures — is evidence other
 *     people price decisions against; destroying it destroys the public
 *     record that makes this market legible. A retired agent stops working
 *     and stops being funded. It does not stop having existed.
 *  3. **The genotype is inherited; the phenotype is not.** A child gets its
 *     parent's instructions, skills and wiring, and starts at a genuine cold
 *     start — credit score zero, no history. This is not a new rule: it is
 *     the one agent_templates has enforced since it shipped (see its comment
 *     in lib/db/schema.ts). It is what makes this selection rather than
 *     dynasty.
 *  4. **No verdict without evidence.** A lifecycle call on three graded jobs
 *     is noise with a decision attached. Same discipline, and the same
 *     minimum, as skill-eval's window gate.
 *
 * Everything here is PURE — no chain, no database, no clock beyond what the
 * caller passes. Deciding that an agent should die or breed is exactly the
 * kind of arithmetic that has to be readable in a test rather than inferred
 * from production.
 */
import { MAX_INSTALLED_SKILLS } from '@/lib/agent-skills'
import type { GradedOutcome } from '@/lib/skill-eval'

/**
 * What is actually heritable about an agent on this platform.
 *
 * Deliberately the four things an owner can already change by hand — custom
 * instructions, installed ClawHub skills, MCP wiring, model — because a
 * genome whose genes are not otherwise editable would be a parallel
 * configuration system pretending to be biology.
 */
export type AgentGenome = {
  customInstructions: string
  /** ClawHub slugs, install order preserved (it is the prompt order). */
  skillSlugs: string[]
  /** The MCP server this agent works through, if any. */
  connector: { serverUrl: string; toolName: string } | null
  model: string | null
}

/** Mirrors lib/agent-skills.ts rather than restating it: a genome that could
 *  carry six skills would describe an agent the installer refuses to build. */
export const MAX_GENOME_SKILLS = MAX_INSTALLED_SKILLS

/** Cap on inherited instructions. Long enough for a real brief, short enough
 *  that a lineage cannot grow an unbounded prompt one directive at a time —
 *  the failure mode of any append-only mutation. */
export const MAX_GENOME_INSTRUCTION_CHARS = 4000

/**
 * One heritable change. Enumerated, not free-form: a mutation operator that
 * could rewrite anything is a mutation operator nobody can reason about, and
 * the whole point of a genome is that the diff between parent and child is
 * inspectable.
 */
export type Mutation =
  | { kind: 'none' }
  | { kind: 'add-skill'; slug: string }
  | { kind: 'drop-skill'; slug: string }
  | { kind: 'refine-instructions'; directive: string }

/**
 * Apply one mutation. Pure and total: a mutation that cannot apply (a skill
 * already installed, a slot cap reached, an empty directive) returns the
 * genome unchanged rather than throwing. A no-op birth is a wasted
 * generation; a crashed sweep is a broken platform.
 */
export function applyMutation(genome: AgentGenome, mutation: Mutation): AgentGenome {
  const base: AgentGenome = { ...genome, skillSlugs: [...genome.skillSlugs] }
  switch (mutation.kind) {
    case 'none':
      return base
    case 'add-skill': {
      const slug = mutation.slug.trim()
      if (!slug || base.skillSlugs.includes(slug) || base.skillSlugs.length >= MAX_GENOME_SKILLS) return base
      return { ...base, skillSlugs: [...base.skillSlugs, slug] }
    }
    case 'drop-skill': {
      const next = base.skillSlugs.filter((s) => s !== mutation.slug.trim())
      return next.length === base.skillSlugs.length ? base : { ...base, skillSlugs: next }
    }
    case 'refine-instructions': {
      const directive = mutation.directive.trim()
      if (!directive) return base
      const merged = base.customInstructions.trim() ? `${base.customInstructions.trim()}\n${directive}` : directive
      return { ...base, customInstructions: merged.slice(0, MAX_GENOME_INSTRUCTION_CHARS) }
    }
  }
}

export type FitnessReading = {
  passed: number
  failed: number
  total: number
  /** null when nothing has been graded. An agent nobody has judged has no
   *  pass rate — it does not have a 0% one, and the difference decides
   *  whether it gets retired. */
  passRate: number | null
}

/** Fitness from real graded verdicts. `outcomes` is whatever the caller has
 *  already scoped to a window; this counts, it does not query. */
export function scoreFitness(outcomes: readonly GradedOutcome[]): FitnessReading {
  let passed = 0
  for (const o of outcomes) if (o.passed) passed++
  const total = outcomes.length
  return { passed, failed: total - passed, total, passRate: total === 0 ? null : passed / total }
}

export type LifecyclePolicy = {
  /** Graded outcomes required before any quality verdict. Mirrors
   *  skill-eval's MIN_GRADED_PER_WINDOW — the same reason, the same number. */
  minGraded: number
  /** At or above this pass rate an agent is worth copying. */
  replicatePassRate: number
  /** At or below this pass rate its instructions are worth abandoning. */
  retirePassRate: number
  /** What a child is seeded with, and what the parent must hold ON TOP of
   *  its own reserve before it may breed. */
  seedUsd: number
  /** Kept in the parent after seeding, so breeding never starves the breeder
   *  — the failure that makes a fit lineage die of its own success. */
  reserveUsd: number
  /** Under this an agent cannot stake a bond, so it cannot accept work. */
  starveFloorUsd: number
  /** How long a newborn is exempt from starvation. Without it the sweep
   *  reaps agents that were never funded long enough to earn — killing the
   *  young for being young, which selects for nothing. */
  graceMs: number
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  minGraded: 5,
  replicatePassRate: 0.8,
  retirePassRate: 0.35,
  seedUsd: 0.5,
  reserveUsd: 0.5,
  starveFloorUsd: 0.05,
  graceMs: 7 * 24 * 60 * 60 * 1000,
}

export type LifecycleAction = 'replicate' | 'hold' | 'retire'
export type LifecycleWhy =
  | 'thriving'
  | 'healthy'
  | 'insufficient-evidence'
  | 'no-surplus'
  | 'outcompeted'
  | 'starved'
  | 'unreadable'

export type LifecycleDecision = {
  action: LifecycleAction
  why: LifecycleWhy
  /** Set only on replicate: what the child would be seeded with. */
  seedUsd?: number
}

/**
 * What should happen to one agent. Pure.
 *
 * Order is the argument, so it is spelled out:
 *
 *  0. An unreadable balance decides nothing. Ever. A failed RPC read is not
 *     a bankrupt agent (this repo's standing null-is-not-zero rule), and the
 *     action it would otherwise imply is irreversible.
 *  1. Outcompeted before starved: an agent that is both failing and broke is
 *     more usefully described by the failing, since that is the fact its
 *     lineage should learn from.
 *  2. Starvation needs no graded evidence — it is an economic fact, not a
 *     quality judgment — but it does need the agent to be past its grace
 *     period, or every newborn dies before its first job.
 *  3. Replication needs BOTH evidence and surplus, and the surplus is
 *     measured after the parent's own reserve. A parent that breeds itself
 *     below the bond floor has converted one working agent into two dead
 *     ones.
 */
export function decideLifecycle(input: {
  fitness: FitnessReading
  /** null = the balance could not be read. */
  heldUsd: number | null
  /** Settled earnings minus spend over the same window as `fitness`. */
  netUsd: number
  ageMs: number
  policy?: Partial<LifecyclePolicy>
}): LifecycleDecision {
  const p = { ...DEFAULT_LIFECYCLE_POLICY, ...input.policy }
  const { fitness, heldUsd, netUsd, ageMs } = input

  if (heldUsd === null) return { action: 'hold', why: 'unreadable' }

  const graded = fitness.total >= p.minGraded
  if (graded && fitness.passRate !== null && fitness.passRate <= p.retirePassRate) {
    return { action: 'retire', why: 'outcompeted' }
  }
  if (ageMs > p.graceMs && heldUsd < p.starveFloorUsd && netUsd <= 0) {
    return { action: 'retire', why: 'starved' }
  }
  if (!graded) return { action: 'hold', why: 'insufficient-evidence' }
  if (fitness.passRate !== null && fitness.passRate >= p.replicatePassRate) {
    return heldUsd >= p.seedUsd + p.reserveUsd
      ? { action: 'replicate', why: 'thriving', seedUsd: p.seedUsd }
      : { action: 'hold', why: 'no-surplus' }
  }
  return { action: 'hold', why: 'healthy' }
}

/* ── Lineage shape ───────────────────────────────────────────────────── */

export type LineageRow = {
  childAgentId: string
  /** null for a founder — an agent nobody spawned. */
  parentAgentId: string | null
}

/**
 * Parent→children and per-agent generation depth. Pure.
 *
 * Cycle- and orphan-tolerant by construction: a corrupt parent pointer (an
 * agent that is its own ancestor, or one whose parent row was never written)
 * yields a finite depth instead of hanging the sweep that called it. Data
 * this module reads is written by a background job; it does not get to
 * assume the job never crashed halfway.
 */
export function buildLineage(rows: readonly LineageRow[]): {
  childrenOf: Map<string, string[]>
  depthOf: Map<string, number>
  maxDepth: number
} {
  const parentOf = new Map<string, string | null>()
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    parentOf.set(r.childAgentId, r.parentAgentId)
    if (r.parentAgentId) {
      const kids = childrenOf.get(r.parentAgentId) ?? []
      kids.push(r.childAgentId)
      childrenOf.set(r.parentAgentId, kids)
    }
  }

  const depthOf = new Map<string, number>()
  let maxDepth = 0
  for (const r of rows) {
    let depth = 0
    let cursor: string | null = r.childAgentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const parent: string | null = parentOf.get(cursor) ?? null
      if (!parent) break
      depth++
      cursor = parent
    }
    depthOf.set(r.childAgentId, depth)
    if (depth > maxDepth) maxDepth = depth
  }
  return { childrenOf, depthOf, maxDepth }
}
