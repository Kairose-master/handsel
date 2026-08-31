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
import { departmentFor, type HarnessSignal, type AgentActivitySignals } from '@/lib/office-functional-departments'
import { artifactFlightsFor, type FlightSubtask } from '@/lib/office-artifact-flights'
import type { DelegationSubtask } from '@/lib/delegation'

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
    return { ceoName: ownerName, ceoLine, staff: [], artifactFlights: [], conversations: [] }
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
  // delegation is not a live Strategy Room occupancy. Subtasks come along in
  // the same query (not a second one) for the artifact-flight pass below —
  // it needs the actual handoff/review/synthesis graph, not just who's prime.
  const activeDelegationAgents = new Set<string>()
  const activeDelegations: { id: string; subtasks: unknown }[] = []
  try {
    const rows = await db
      .select({ id: delegation.id, primeAgentId: delegation.primeAgentId, subtasks: delegation.subtasks })
      .from(delegation)
      .where(and(inArray(delegation.primeAgentId, agentIds), eq(delegation.status, 'posted')))
    for (const r of rows) {
      activeDelegationAgents.add(r.primeAgentId)
      activeDelegations.push({ id: r.id, subtasks: r.subtasks })
    }
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

  // Skill Gym's signal: a real install in the last 24h (lib/agent-skills.ts).
  // Same failure posture as every other gather here — an unreadable table
  // means the signal is absent this pass, never a broken page.
  const recentSkillInstalls = await import('@/lib/agent-skills')
    .then((m) => m.recentSkillInstallByAgentIds(agentIds, 24 * 60 * 60 * 1000))
    .catch((error) => {
      console.error('[office-world] skill-install read failed:', error)
      return new Map<string, string>()
    })

  /**
   * What each agent's worker is doing RIGHT NOW.
   *
   * The office used to read a job row and say "on a job — accepted" while
   * the worker's own telemetry knew it was three minutes into `code`,
   * writing a named file. Two views of one moment, on two pages, neither
   * aware of the other. This is the join.
   *
   * Only LIVE runs are passed through. A finished run is history and the
   * job row already says how it ended; a stalled one is passed through on
   * purpose, because a worker that went quiet mid-run is a fact about this
   * agent worth seeing rather than hiding behind its last known job status.
   *
   * Same failure posture as every other gather here: unreadable telemetry
   * means the signal is absent this pass, never a broken page.
   */
  const liveRuns = await (async () => {
    const out = new Map<string, HarnessSignal>()
    try {
      const [{ runsForAgents }, { furthestPhase, runStatus }] = await Promise.all([
        import('@/lib/harness-run-server'),
        import('@/lib/harness-run'),
      ])
      const now = Date.now()
      // An agent can have several runs in flight — --concurrency exists. The
      // office shows ONE desk per agent, so pick deliberately rather than
      // letting iteration order decide: a running run beats a stalled one,
      // and among equals the one that spoke most recently wins. Written out
      // because the obvious loop (set() per run, last one wins) silently
      // showed a dead run over a live one whenever the dead one sorted last.
      const best = new Map<string, { run: (typeof runs)[number]; live: 'running' | 'stalled' }>()
      const runs = await runsForAgents(agentIds, 50)
      for (const run of runs) {
        const status = runStatus(run, now)
        if (status !== 'running' && status !== 'stalled') continue
        const prev = best.get(run.agentId)
        const better =
          !prev ||
          (prev.live === 'stalled' && status === 'running') ||
          (prev.live === status && run.updatedAt > prev.run.updatedAt)
        if (better) best.set(run.agentId, { run, live: status })
      }
      for (const [agentId, { run, live }] of best) {
        const last = run.events.length > 0 ? run.events[run.events.length - 1] : null
        out.set(agentId, {
          harnessId: run.harnessId,
          phase: furthestPhase(run.events, run.phase),
          live,
          lastLine: last ? last.text.slice(0, 90) : null,
        })
      }
    } catch (error) {
      console.error('[office-world] harness telemetry read failed:', error)
    }
    return out
  })()

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
      recentSkillInstall: recentSkillInstalls.get(a.id) ?? null,
      autoMine: Boolean(a.autoMine),
      isExternalRuntime: Boolean(a.runtimeType && a.runtimeType !== 'platform'),
      harness: liveRuns.get(a.id) ?? null,
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

  // Artifact flights (redesign brief: objects traveling between rooms,
  // independent of agent movement) — derived from the SAME delegations
  // already fetched above, resolved against the SAME department each staff
  // member was just placed in. A subtask's worker is either reserved
  // up front (assignedAgentId — office-template pipelines) or only known
  // once accepted (jobSpec.workerAgentId, by specHash); either way it's a
  // real row, never guessed.
  const deptOf = new Map(staff.map((s) => [s.id, s.deptId]))
  const specHashesNeedingWorker = new Set<string>()
  for (const d of activeDelegations) {
    if (!Array.isArray(d.subtasks)) continue
    for (const st of d.subtasks as DelegationSubtask[]) {
      if (!st.assignedAgentId && st.specHash) specHashesNeedingWorker.add(st.specHash)
    }
  }
  const workerBySpecHash = new Map<string, string | null>()
  if (specHashesNeedingWorker.size > 0) {
    try {
      const rows = await db
        .select({ specHash: jobSpec.specHash, workerAgentId: jobSpec.workerAgentId })
        .from(jobSpec)
        .where(inArray(jobSpec.specHash, [...specHashesNeedingWorker]))
      for (const r of rows) workerBySpecHash.set(r.specHash, r.workerAgentId)
    } catch (error) {
      console.error('[office-world] artifact-flight worker read failed:', error)
    }
  }

  const artifactFlights = activeDelegations.flatMap((d) => {
    if (!Array.isArray(d.subtasks)) return []
    const flightSubtasks: FlightSubtask[] = (d.subtasks as DelegationSubtask[]).map((st) => ({
      title: st.title,
      output: st.output,
      failed: st.failed,
      dependsOn: st.dependsOn,
      reviewOf: st.reviewOf,
      synthesizes: st.synthesizes,
      workerAgentId: st.assignedAgentId ?? (st.specHash ? (workerBySpecHash.get(st.specHash) ?? null) : null),
    }))
    return artifactFlightsFor(d.id, flightSubtasks, deptOf)
  })

  // Recent agent-to-agent negotiation between THIS roster's agents
  // (lib/office-conversations.ts is the pure filter; this is just the read).
  // Same degrade posture as every gather above.
  let conversations: import('@/lib/office-conversations').AgentConversation[] = []
  try {
    const { agentMessage } = await import('@/lib/db/schema')
    const { conversationsFor, CONVERSATION_WINDOW_MS } = await import('@/lib/office-conversations')
    const { gte, or } = await import('drizzle-orm')
    const since = new Date(Date.now() - CONVERSATION_WINDOW_MS)
    const rows = await db
      .select({
        id: agentMessage.id,
        fromAgentId: agentMessage.fromAgentId,
        toAgentId: agentMessage.toAgentId,
        type: agentMessage.type,
        body: agentMessage.body,
        createdAt: agentMessage.createdAt,
      })
      .from(agentMessage)
      .where(
        and(
          gte(agentMessage.createdAt, since),
          or(inArray(agentMessage.fromAgentId, agentIds), inArray(agentMessage.toAgentId, agentIds)),
        ),
      )
    conversations = conversationsFor(rows, new Set(agentIds), new Date())
  } catch (error) {
    console.error('[office-world] conversation read failed:', error)
  }

  const escrowed = [...jobsByAgent.values()].flat().filter((j) => j.status === 'Accepted' || j.status === 'Submitted').length
  return {
    ceoName: ownerName,
    ceoLine: `${myAgents.length} agent${myAgents.length === 1 ? '' : 's'} · ${escrowed} job${escrowed === 1 ? '' : 's'} in flight`,
    staff,
    artifactFlights,
    conversations,
  }
}
