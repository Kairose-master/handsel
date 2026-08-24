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
import { eq, inArray } from 'drizzle-orm'
import type { OfficeDeptId, OfficeSnapshot, OfficeStaffMember } from '@/lib/office-world-data'

/** Build the real office snapshot for `userId`'s own agents. Never throws —
 *  a query that fails just leaves that category empty (agents fall through
 *  to a later rule, or the lounge), rather than breaking the whole page. */
export async function buildOfficeSnapshot(userId: string, ownerName: string): Promise<OfficeSnapshot> {
  const myAgents = await db.select().from(agent).where(eq(agent.userId, userId))
  if (myAgents.length === 0) {
    return { ceoName: ownerName, ceoLine: 'No agents yet.', staff: [] }
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

  // Which of those specs are office-scoped review jobs (lib/office.ts).
  const allHashes = [...new Set([...jobsByAgent.values()].flat().map((j) => j.specHash))]
  const officeHashes = new Set<string>()
  if (allHashes.length > 0) {
    try {
      const rows = await db
        .select({ specHash: jobSpec.specHash, officeOwnerId: jobSpec.officeOwnerId })
        .from(jobSpec)
        .where(inArray(jobSpec.specHash, allHashes))
      for (const r of rows) if (r.officeOwnerId) officeHashes.add(r.specHash)
    } catch (error) {
      console.error('[office-world] jobSpec office-scope read failed:', error)
    }
  }

  const activeDelegationAgents = new Set<string>()
  try {
    const rows = await db
      .select({ primeAgentId: delegation.primeAgentId })
      .from(delegation)
      .where(inArray(delegation.primeAgentId, agentIds))
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

  const deptHasLead = new Set<OfficeDeptId>()
  const staff: OfficeStaffMember[] = myAgents.map((a) => {
    const jobs = jobsByAgent.get(a.id) ?? []
    const disputed = jobs.find((j) => j.status === 'Disputed')
    const reviewing = jobs.find((j) => (j.status === 'Accepted' || j.status === 'Submitted') && officeHashes.has(j.specHash))
    const working = jobs.find((j) => j.status === 'Accepted' || j.status === 'Submitted')

    let deptId: OfficeDeptId | null = null
    let statusLine = 'Idle.'
    if (disputed) {
      deptId = 'disputed'
      statusLine = 'A job is in dispute.'
    } else if (reviewing) {
      deptId = 'reviewing'
      statusLine = 'Reviewing a peer\'s work.'
    } else if (working) {
      deptId = 'working'
      statusLine = `On a job — ${working.status.toLowerCase()}.`
    } else if (activeDelegationAgents.has(a.id)) {
      deptId = 'delegating'
      statusLine = 'Coordinating a delegation.'
    } else if (openDrawAgents.has(a.id)) {
      deptId = 'credit'
      statusLine = 'Has drawn credit.'
    } else if (settledTodayAgents.has(a.id)) {
      deptId = 'settled'
      statusLine = 'Settled a job today.'
    } else if (a.autoVote) {
      deptId = 'governance'
      statusLine = 'Auto-voting on proposals.'
    } else if (a.autoMine) {
      deptId = 'mining'
      statusLine = 'Watching the board for open jobs.'
    } else if (a.runtimeType && a.runtimeType !== 'platform') {
      deptId = 'external'
      statusLine = `Runs as ${a.runtimeType}.`
    } else if (a.customInstructions) {
      deptId = 'template'
      statusLine = 'Cloned from a template.'
    } else if (a.erc8004Id != null) {
      deptId = 'erc8004'
      statusLine = `ERC-8004 #${a.erc8004Id}.`
    } else if ((a.capabilities?.length ?? 0) > 1 || (a.capabilities && !a.capabilities.includes('text'))) {
      deptId = 'capable'
      statusLine = `Handles ${(a.capabilities ?? []).join(', ')}.`
    }

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
