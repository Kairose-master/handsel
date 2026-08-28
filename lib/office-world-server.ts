/**
 * Office World — server-only: the real query behind the pixel-office
 * snapshot. Split out of lib/office-world-data.ts on purpose — that file's
 * types and `colorsFor` are imported by the CLIENT-side game engine
 * (app/(dashboard)/office/game/), and this function's `@/lib/db` import
 * drags in `pg`, which needs Node's `net`/`tls`/`util` and cannot be
 * bundled for the browser. Co-locating them broke the production build:
 * every consumer of the pure exports pulled this one in too, and Next
 * failed to resolve `pg`'s Node built-ins client-side. Keep server-only
 * code here; keep lib/office-world-data.ts safe for a 'use client' import.
 */
import { db } from '@/lib/db'
import { agent, delegation, creditTransaction, agentEvent, jobSpec } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import type { OfficeSnapshot, OfficeStaffMember } from '@/lib/office-world-data'
import { officeSlotsByAgentId, roleIdsByAgentId } from '@/lib/office'
import { departmentFor, type AgentActivitySignals } from '@/lib/office-functional-departments'

/** Build the real office snapshot for `userId`'s agents in one office
 *  (`slot` — see lib/office.ts's MAX_OFFICE_SLOTS). Never throws — a query
 *  that fails just leaves that category empty (agents fall through to a
 *  later rule, or the lounge), rather than breaking the whole page. */
export async function buildOfficeSnapshot(userId: string, ownerName: string, slot: number): Promise<OfficeSnapshot> {
  const everyAgent = await db.select().from(agent).where(eq(agent.userId, userId))
  const slotByAgentId = await officeSlotsByAgentId(everyAgent.map((a) => a.id))
  const myAgents = everyAgent.filter((a) => slotByAgentId.get(a.id) === slot)
  if (myAgents.length === 0) {
    const ceoLine = everyAgent.length === 0 ? 'No agents yet.' : 'No agents in this office yet.'
    return { ceoName: ownerName, ceoLine, staff: [] }
  }
  const agentIds = myAgents.map((a) => a.id)
  const addressToAgent = new Map(
    myAgents.filter((a) => a.smartAccountAddress).map((a) => [a.smartAccountAddress!.toLowerCase(), a]),
  )

  // Live job state, keyed by this office's wallet addresses only — a handful
  // of address comparisons over the whole board, same pattern worker-console
  // uses for "which open jobs are mine".
  const jobsByAgent = new Map<string, { status: string; specHash: string }[]>()
  try {
    const { readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs().catch(() => [])
    for (const j of jobs) {
      const a = addressToAgent.get(j.worker?.toLowerCase() ?? '')
      if (!a) continue
      const list = jobsByAgent.get(a.id) ?? []
      list.push({ status: j.status, specHash: j.specHash })
      jobsByAgent.set(a.id, list)
    }
  } catch (error) {
    console.error('[office-world] job read failed (continuing with empty job state):', error)
  }

  // Which of those specs are office-scoped review jobs (lib/office.ts) and
  // which are GitHub repo jobs (lib/repo-jobs.ts) — one query on the same
  // spec-hash set answers both, since a functional department needs to tell
  // "reviewing" from "building" and "adversarial review" from "independent
  // review" apart, none of which the bare on-chain status says on its own.
  const allHashes = [...new Set([...jobsByAgent.values()].flat().map((j) => j.specHash))]
  const officeHashes = new Set<string>()
  const repoHashes = new Set<string>()
  if (allHashes.length > 0) {
    try {
      const rows = await db
        .select({ specHash: jobSpec.specHash, officeOwnerId: jobSpec.officeOwnerId, repoFullName: jobSpec.repoFullName })
        .from(jobSpec)
        .where(inArray(jobSpec.specHash, allHashes))
      for (const r of rows) {
        if (r.officeOwnerId) officeHashes.add(r.specHash)
        if (r.repoFullName) repoHashes.add(r.specHash)
      }
    } catch (error) {
      console.error('[office-world] jobSpec office-scope read failed:', error)
    }
  }

  // Currently coordinating, not "has ever delegated" — a completed or failed
  // delegation is not a live Strategy Room occupancy.
  const activeDelegationAgents = new Set<string>()
  try {
    const rows = await db
      .select({ primeAgentId: delegation.primeAgentId })
      .from(delegation)
      .where(and(inArray(delegation.primeAgentId, agentIds), eq(delegation.status, 'posted')))
    for (const r of rows) activeDelegationAgents.add(r.primeAgentId)
  } catch (error) {
    console.error('[office-world] delegation read failed:', error)
  }

  const openDrawAgents = new Set<string>()
  try {
    const rows = await db
      .select({ fromAgentId: creditTransaction.fromAgentId })
      .from(creditTransaction)
      .where(inArray(creditTransaction.fromAgentId, agentIds))
    // Presentation-only signal (which room to stand in), not a balance —
    // any recorded draw row is enough to say "this agent has touched credit".
    for (const r of rows) if (r.fromAgentId) openDrawAgents.add(r.fromAgentId)
  } catch (error) {
    console.error('[office-world] credit read failed:', error)
  }

  const settledTodayAgents = new Set<string>()
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const rows = await db
      .select({ agentId: agentEvent.agentId, createdAt: agentEvent.createdAt })
      .from(agentEvent)
      .where(inArray(agentEvent.agentId, agentIds))
    for (const r of rows) if (r.createdAt >= since) settledTodayAgents.add(r.agentId)
  } catch (error) {
    console.error('[office-world] settlement read failed:', error)
  }

  const roleIds = await roleIdsByAgentId(agentIds, slot).catch((error) => {
    console.error('[office-world] role-id read failed:', error)
    return new Map<string, string>()
  })

  const deptHasLead = new Set<string>()
  const staff: OfficeStaffMember[] = myAgents.map((a) => {
    const signals: AgentActivitySignals = {
      jobs: (jobsByAgent.get(a.id) ?? []).map((j) => ({ ...j, repoJob: repoHashes.has(j.specHash) })),
      officeReviewSpecHashes: officeHashes,
      roleId: roleIds.get(a.id) ?? null,
      mcpToolName: a.mcpToolName ?? null,
      isDelegationPrime: activeDelegationAgents.has(a.id),
      hasCreditDraw: openDrawAgents.has(a.id),
      settledRecently: settledTodayAgents.has(a.id),
      autoMine: Boolean(a.autoMine),
      isExternalRuntime: Boolean(a.runtimeType && a.runtimeType !== 'platform'),
    }
    const { deptId, statusLine } = departmentFor(signals)

    // First agent (in roster order) placed in a department leads it — the
    // "팀장" badge is cosmetic, not a real title; it exists so the room
    // doesn't render an empty-looking crowd with no one to anchor it.
    let rank: 'lead' | 'member' = 'member'
    if (deptId !== null && !deptHasLead.has(deptId)) {
      rank = 'lead'
      deptHasLead.add(deptId)
    }

    return {
      id: a.id,
      name: a.name,
      role: a.creditRating ?? 'unrated',
      deptId,
      rank,
      statusLine,
    }
  })

  const escrowed = [...jobsByAgent.values()].flat().filter((j) => j.status === 'Accepted' || j.status === 'Submitted').length
  return {
    ceoName: ownerName,
    ceoLine: `${myAgents.length} agent${myAgents.length === 1 ? '' : 's'} · ${escrowed} job${escrowed === 1 ? '' : 's'} in flight`,
    staff,
  }
}
