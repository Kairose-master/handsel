/**
 * The query behind the tool record.
 *
 * One pass over graded job specs, joined to the agent that did the work and
 * the agent that posted it, grouped by tool identity rather than by agent.
 * The grouping is the whole feature — everything it reads has been recorded
 * on every job since long before this file existed (docs/positioning.md §5).
 *
 * Read-only and public-facing, so two things are non-negotiable and are
 * enforced here rather than at the page: nothing account-identifying leaves
 * this module (the requester's account id is used only to COUNT distinct
 * sources, in lib/tool-record.ts, and never reaches a `ToolRecord`), and a
 * tool whose identity cannot be published safely is dropped rather than
 * printed (lib/tool-identity.ts).
 */
import { db } from '@/lib/db'
import { agent as agentTable, jobSpec } from '@/lib/db/schema'
import { toolIdentityOf } from '@/lib/tool-identity'
import { groupByTool, rankTools, type GradedJob, type ToolRecord } from '@/lib/tool-record'

/**
 * Every tool with graded work on this market, best evidence first.
 *
 * Degrades to an empty list rather than throwing: this renders a public page
 * that is worth showing even when the record behind it is momentarily
 * unavailable, and an error page teaches a first-time visitor nothing.
 */
export async function toolRecords(): Promise<ToolRecord[]> {
  let specs: Array<typeof jobSpec.$inferSelect>
  let agents: Array<typeof agentTable.$inferSelect>
  try {
    ;[specs, agents] = await Promise.all([db.select().from(jobSpec), db.select().from(agentTable)])
  } catch {
    return []
  }

  const byId = new Map(agents.map((a) => [a.id, a]))

  // The bounty is NOT on the spec, on purpose: schema.ts records that the
  // current price is always the live on-chain value, because a cached one
  // drifts from the escrow and then promises money the contract will not pay.
  // So it is read from the chain here and left ABSENT when that read fails —
  // a $0.00 median is a claim about price, and an unavailable RPC is not one.
  const bountyByJobId = await (async () => {
    try {
      const { readJobs } = await import('@/lib/onchain/labor')
      const chain = await readJobs()
      return new Map(chain.map((j) => [j.id, j.bounty]))
    } catch {
      return new Map<number, number>()
    }
  })()
  const harnesses = await (async () => {
    try {
      const { harnessesFor } = await import('@/lib/agent-harness-server')
      return await harnessesFor(agents.map((a) => a.id))
    } catch {
      return new Map<string, string>()
    }
  })()

  const jobs: GradedJob[] = []
  for (const spec of specs) {
    const verdict = spec.testResult
    // A verdict, not merely a submission: an ungraded job says nothing about
    // the tool, and counting it either way would be inventing evidence.
    if (!verdict || (verdict.passed !== true && verdict.passed !== false)) continue
    if (!spec.workerAgentId) continue
    const worker = byId.get(spec.workerAgentId)
    if (!worker) continue

    const identity = toolIdentityOf({
      runtimeType: worker.runtimeType,
      mcpServerUrl: worker.mcpServerUrl,
      mcpToolName: worker.mcpToolName,
      harnessId: harnesses.get(worker.id) ?? null,
    })
    if (!identity) continue // platform model, or a private local setup

    const gradedAt = Date.parse(verdict.gradedAt)
    if (!Number.isFinite(gradedAt)) continue
    const claimedAt = spec.claimedAt ? spec.claimedAt.getTime() : null

    jobs.push({
      toolId: identity.id,
      toolLabel: identity.label,
      toolKind: identity.kind,
      passed: verdict.passed === true,
      bountyUsd: spec.onchainJobId != null ? (bountyByJobId.get(spec.onchainJobId) ?? null) : null,
      seconds: claimedAt !== null && gradedAt > claimedAt ? Math.round((gradedAt - claimedAt) / 1000) : null,
      gradedAt,
      // The requester's OWNER, not the requesting agent: one account running
      // seventeen agents that hire each other is still one source, and
      // counting agents would make a single-account market look independent.
      requesterAccountId: requesterAccountOf(spec, byId),
    })
  }

  return rankTools(groupByTool(jobs))
}

function requesterAccountOf(
  spec: typeof jobSpec.$inferSelect,
  byId: Map<string, typeof agentTable.$inferSelect>,
): string {
  const requester = spec.requesterAgentId ? byId.get(spec.requesterAgentId) : null
  if (requester?.userId) return `u:${requester.userId}`
  // An outside poster has no agent here at all, which is the most
  // independent source there is — key it by the poster so two of them count
  // as two.
  if (spec.externalPoster) return `x:${spec.externalPoster.toLowerCase()}`
  return `spec:${spec.specHash}`
}
