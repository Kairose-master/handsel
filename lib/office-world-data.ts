/**
 * Office World — the real data behind the pixel-office visual.
 *
 * The reference toy this borrowed its room/pathfinding/canvas engine from
 * (a "AI Office" pixel simulation) runs a fully SCRIPTED single-day
 * scenario: fixed phases, a generator per employee, canned dialogue. Every
 * name and "task" in it comes from a static config file — none of it is
 * live. Dropping real Handsel agent names into that script would have
 * produced the worst version of fake data this project has ever shipped:
 * a real identity narrating an invented activity ("checking sources
 * today") it never did.
 *
 * This file is the alternative: the ENGINE (world layout, A* pathfinding,
 * canvas rendering — app/(dashboard)/office/game/) was kept, and the BRAIN
 * (the scripted generator) was replaced with this — a real snapshot of what
 * an account's agents are actually doing right now, refreshed on a poll
 * instead of a scripted clock. Every "room" an agent stands in and every
 * status line above their head is one of the facts below, not a script.
 *
 * One department per agent, assigned by the first matching rule below —
 * most urgent/active state wins; static attributes are the fallback so an
 * otherwise-quiet agent still lands somewhere real rather than idling for
 * no visible reason. An agent that matches nothing sits in the lounge.
 */
import { db } from '@/lib/db'
import { agent, delegation, creditTransaction, agentEvent, jobSpec } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'

export type OfficeDeptId =
  | 'disputed'
  | 'reviewing'
  | 'working'
  | 'delegating'
  | 'credit'
  | 'settled'
  | 'governance'
  | 'mining'
  | 'external'
  | 'template'
  | 'erc8004'
  | 'capable'

export const OFFICE_DEPARTMENTS: Array<{ id: OfficeDeptId; name: string; short: string; icon: string; blurb: string }> = [
  { id: 'disputed', name: 'Disputes', short: 'dispute.desk', icon: '⚖️', blurb: 'A job on this agent is in dispute right now.' },
  { id: 'reviewing', name: 'Review line', short: 'review.line', icon: '🖋️', blurb: 'Working an office-scoped peer review.' },
  { id: 'working', name: 'Working', short: 'job.desk', icon: '💼', blurb: 'Accepted or Submitted on a real escrowed job.' },
  { id: 'delegating', name: 'Delegating', short: 'delegate.hq', icon: '📤', blurb: 'Prime on an active delegation, coordinating subtasks.' },
  { id: 'credit', name: 'Credit', short: 'credit.line', icon: '📊', blurb: 'Has an open credit draw against its score.' },
  { id: 'settled', name: 'Settled today', short: 'payout.log', icon: '💰', blurb: 'Completed and got paid in the last 24h.' },
  { id: 'governance', name: 'Governance', short: 'gov.hall', icon: '🗳️', blurb: 'Votes on proposals on the owner\'s behalf.' },
  { id: 'mining', name: 'Mining', short: 'mining.rig', icon: '⛏️', blurb: 'Auto-claims qualifying open jobs.' },
  { id: 'external', name: 'External', short: 'mcp.bridge', icon: '🔌', blurb: 'Runs outside the platform — webhook, cloud key, or MCP.' },
  { id: 'template', name: 'Cloned', short: 'template.hq', icon: '🧬', blurb: 'Built from a purchased or cloned agent template.' },
  { id: 'erc8004', name: 'Registered', short: 'erc8004.id', icon: '🪪', blurb: 'Has an ERC-8004 identity registry entry.' },
  { id: 'capable', name: 'Specialist', short: 'capable.lab', icon: '🎨', blurb: 'Declares a capability beyond plain text.' },
]

export type OfficeStaffMember = {
  id: string
  name: string
  role: string
  deptId: OfficeDeptId | null // null = lounge (idle — nothing else matched)
  rank: 'lead' | 'member'
  statusLine: string
}

export type OfficeSnapshot = {
  ceoName: string
  ceoLine: string
  staff: OfficeStaffMember[]
}

const COLOR_PALETTE: Array<[string, string, string]> = [
  ['#6b3d34', '#fff3b0', '#ff8fc0'],
  ['#372b4a', '#c9b8ff', '#c9b8ff'],
  ['#c26e4b', '#ff8fc0', '#fff3b0'],
  ['#2d4b46', '#b8f0dd', '#b8f0dd'],
  ['#8b534a', '#fff3b0', '#ff8fc0'],
  ['#2c2638', '#ff8fc0', '#ff8fc0'],
  ['#d88d68', '#c9b8ff', '#c9b8ff'],
  ['#563a32', '#b8f0dd', '#b8f0dd'],
  ['#313b56', '#fff3b0', '#fff3b0'],
  ['#9c5c72', '#ff8fc0', '#ff8fc0'],
  ['#3b3b49', '#b8f0dd', '#b8f0dd'],
  ['#7a453c', '#c9b8ff', '#c9b8ff'],
]

export function colorsFor(index: number): [string, string, string] {
  return COLOR_PALETTE[index % COLOR_PALETTE.length]
}

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
