/**
 * The facts lib/claim-fitness.ts decides on.
 *
 * Split out because the rules are the interesting part and they must be
 * testable without a database or a chain. Everything here is a query; every
 * query degrades to the module's explicit `unknown`, which never blocks
 * (see that file's header). A probe that cannot answer must not be the thing
 * that stops a working agent from earning.
 *
 * Cost matters: this runs on the claim path, and on auto-mine it runs once
 * per candidate job. So the per-agent facts — turnaround, failure history —
 * are gathered ONCE per agent and reused across every job in that tick, and
 * only the per-job facts are computed inline.
 */
import { db } from '@/lib/db'
import { agent as agentTable, jobSpec } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { classifyWorker } from '@/lib/worker-fleet'
import { workerCanDeliver } from '@/lib/artifacts'
import {
  assessClaim,
  claimJobClass,
  MIN_TURNAROUND_SAMPLES,
  FAILURE_WINDOW,
  type ClaimFacts,
  type ClassHistory,
  type FitnessVerdict,
  type Liveness,
  type RepoAccess,
} from '@/lib/claim-fitness'

type AgentRow = typeof agentTable.$inferSelect

/** Everything about the AGENT that does not change between jobs in one tick. */
export type AgentFitnessContext = {
  agentId: string
  liveness: Liveness
  heartbeatAgeSec: number | null
  capabilities: unknown
  /** Median claim→graded seconds over this agent's finished work, or null
   *  when it has fewer than MIN_TURNAROUND_SAMPLES of them. */
  medianTurnaroundSec: number | null
  /** jobClass → how that class has gone for this agent. */
  historyByClass: Map<string, ClassHistory>
}

/**
 * Map the fleet's phase onto the three states this decision cares about.
 *
 * `classifyWorker` already owns what "offline" means for each runtime (a push
 * runtime needs no heartbeat; a local one does), and duplicating that rule
 * here is how the two drift and a healthy worker starts getting refused.
 */
function livenessOf(row: AgentRow, now: Date): { liveness: Liveness; heartbeatAgeSec: number | null } {
  const phase = classifyWorker(
    {
      runtimeType: row.runtimeType,
      lastPollAt: row.lastPollAt,
      // Both true on purpose: this decision is only about whether something
      // is THERE to run the job. A missing wallet or key is refused earlier
      // on the claim path, with a better message than this module would give,
      // and reporting it here as a liveness problem would misname it.
      provisioned: true,
      hasKey: true,
      autoMine: row.autoMine,
    },
    now,
  )
  if (phase.phase === 'Offline') return { liveness: 'offline', heartbeatAgeSec: phase.heartbeatAgeSec }
  if (phase.phase === 'NotReady') return { liveness: 'stale', heartbeatAgeSec: phase.heartbeatAgeSec }
  return { liveness: 'ready', heartbeatAgeSec: phase.heartbeatAgeSec }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Gather the per-agent facts.
 *
 * One query over this agent's own specs. `claimedAt` and `testResult.gradedAt`
 * are both already stored, so turnaround is arithmetic rather than a new
 * column — and the failure history is derived the same way, which is why
 * there is no cooldown table to migrate, drift, or forget to clear.
 */
export async function agentFitnessContext(row: AgentRow, now = new Date()): Promise<AgentFitnessContext> {
  const { liveness, heartbeatAgeSec } = livenessOf(row, now)
  const base: AgentFitnessContext = {
    agentId: row.id,
    liveness,
    heartbeatAgeSec,
    capabilities: row.capabilities,
    medianTurnaroundSec: null,
    historyByClass: new Map(),
  }

  let specs: Array<typeof jobSpec.$inferSelect>
  try {
    specs = await db.select().from(jobSpec).where(eq(jobSpec.workerAgentId, row.id))
  } catch {
    return base // unknown history — never a reason to refuse work
  }

  const turnarounds: number[] = []
  // Oldest first, so "the last N" below means the most recent N.
  const graded = specs
    .filter((s) => s.testResult?.gradedAt)
    .sort((a, b) => Date.parse(a.testResult!.gradedAt) - Date.parse(b.testResult!.gradedAt))

  for (const s of graded) {
    const gradedAt = Date.parse(s.testResult!.gradedAt)
    const claimedAt = s.claimedAt ? s.claimedAt.getTime() : null
    if (claimedAt !== null && Number.isFinite(gradedAt) && gradedAt > claimedAt) {
      turnarounds.push(Math.round((gradedAt - claimedAt) / 1000))
    }
  }
  if (turnarounds.length >= MIN_TURNAROUND_SAMPLES) base.medianTurnaroundSec = median(turnarounds)

  // Per class, only the most recent FAILURE_WINDOW jobs count. An agent with
  // forty settled jobs and three old failures is not in trouble; one whose
  // last four all failed is, and a lifetime ratio cannot tell them apart.
  const byClass = new Map<string, Array<typeof jobSpec.$inferSelect>>()
  for (const s of graded) {
    if (s.testResult!.passed === null || s.testResult!.passed === undefined) continue
    const cls = claimJobClass(s)
    const list = byClass.get(cls) ?? []
    list.push(s)
    byClass.set(cls, list)
  }
  for (const [cls, list] of byClass) {
    const recent = list.slice(-FAILURE_WINDOW)
    const failures = recent.filter((s) => s.testResult!.passed === false)
    base.historyByClass.set(cls, {
      jobClass: cls,
      graded: recent.length,
      failed: failures.length,
      lastFailedAt: failures.length
        ? Math.max(...failures.map((s) => Date.parse(s.testResult!.gradedAt)))
        : null,
    })
  }
  return base
}

/**
 * Does this account hold the GitHub permission a repo job needs?
 *
 * `installationTokenForRepo` is the same call the run itself would make, so a
 * 'granted' here means the run will not die on its first fetch. Anything that
 * is not a clear refusal reads as unknown: a rate limit or a network blip is
 * not evidence the account lacks access, and treating it as such would refuse
 * work for a reason that was never true.
 */
export async function repoAccessFor(repoFullName: string | null): Promise<RepoAccess> {
  if (!repoFullName) return 'not-applicable'
  try {
    const { isGithubAppConfigured, installationTokenForRepo } = await import('@/lib/github-app')
    if (!(await isGithubAppConfigured())) return 'unknown' // nothing to ask
    await installationTokenForRepo(repoFullName)
    return 'granted'
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not installed|no installation|404|not found/i.test(msg)) return 'denied'
    return 'unknown'
  }
}

export type ClaimFitnessInput = {
  ctx: AgentFitnessContext
  spec: {
    title?: string | null
    deliverableKind?: string | null
    requiredCapabilities?: unknown
    repoFullName?: string | null
  }
  /** Governing on-chain deadline, unix seconds; null on a market without
   *  deadlines, which is unknown, which does not block. */
  deadlineSec: number | null
  repoAccess: RepoAccess
  autonomous: boolean
  now?: number
}

/** Assemble the facts for one (agent, job) pair and decide. */
export function assessClaimWith(input: ClaimFitnessInput): FitnessVerdict {
  const kind = input.spec.deliverableKind ?? 'text'
  const declared = Array.isArray(input.ctx.capabilities) && input.ctx.capabilities.length
    ? (input.ctx.capabilities as unknown[]).map(String)
    : ['text']
  const required = Array.isArray(input.spec.requiredCapabilities)
    ? (input.spec.requiredCapabilities as unknown[]).map(String)
    : []
  const missing = [kind, ...required].filter((c) => !declared.includes(c))

  const facts: ClaimFacts = {
    now: input.now ?? Date.now(),
    autonomous: input.autonomous,
    liveness: input.ctx.liveness,
    heartbeatAgeSec: input.ctx.heartbeatAgeSec,
    canDeliver: workerCanDeliver(input.ctx.capabilities, kind, input.spec.requiredCapabilities),
    deliverableKind: kind,
    missingCapabilities: [...new Set(missing)],
    repoAccess: input.repoAccess,
    repoFullName: input.spec.repoFullName ?? null,
    deadlineSec: input.deadlineSec,
    medianTurnaroundSec: input.ctx.medianTurnaroundSec,
    classHistory: input.ctx.historyByClass.get(claimJobClass(input.spec)) ?? null,
  }
  return assessClaim(facts)
}

/**
 * The whole check for one claim, agent row in hand.
 *
 * The convenience form for the single-claim paths (a person clicking, an MCP
 * `claim_job`). Auto-mine does NOT use this — it builds one context per tick
 * and reuses it, because this would otherwise re-query the agent's entire job
 * history once per candidate job.
 */
export async function assessOneClaim(input: {
  agentId: string
  spec: ClaimFitnessInput['spec']
  deadlineSec: number | null
  autonomous: boolean
}): Promise<FitnessVerdict | null> {
  const [row] = await db.select().from(agentTable).where(and(eq(agentTable.id, input.agentId)))
  if (!row) return null
  const [ctx, repoAccess] = await Promise.all([
    agentFitnessContext(row),
    repoAccessFor(input.spec.repoFullName ?? null),
  ])
  return assessClaimWith({ ctx, spec: input.spec, deadlineSec: input.deadlineSec, repoAccess, autonomous: input.autonomous })
}
