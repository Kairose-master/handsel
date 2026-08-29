/**
 * Reading the network graph out of the database.
 *
 * lib/agent-network.ts holds the model, the visibility rule and the layout —
 * all pure, all tested. This file does the part that needs a database and
 * nothing else: it collects the rows, hands them to `buildNetwork`, and
 * returns what that produced.
 *
 * The split matters here more than usual. The visibility rule decides what
 * a viewer may see about other people's agents, and a rule that lives in
 * the same function as its queries is a rule that gets quietly bypassed the
 * next time somebody needs "just one more join". Everything this file reads
 * goes through `buildNetwork`; it never emits an edge of its own.
 *
 * Every query is bounded — by a time window, by a row cap, or by an id list
 * derived from one of those two. A graph is a whole-market read by nature,
 * so an unbounded version of any of these is a table scan waiting for the
 * market to grow.
 */
import { db, pool } from '@/lib/db'
import { agent, agentMessage, delegation, jobSpec } from '@/lib/db/schema'
import { and, desc, eq, gt, inArray, isNotNull, or } from 'drizzle-orm'
import { connectedOfficesOf, listOfficeSlots, officeSlotsByAgentId } from '@/lib/office'
import type { DelegationSubtask } from '@/lib/delegation'
import {
  buildNetwork,
  type AgentNetwork,
  type NetworkHandoffRow,
  type NetworkJobRow,
  type NetworkMessageRow,
  type NetworkOfficeRow,
} from '@/lib/agent-network'

/** How far back an exchange still counts as part of the picture. Long
 *  enough that a quiet week still shows a shape, short enough that the
 *  graph is about now rather than about everything that ever happened. */
export const NETWORK_WINDOW_DAYS = 30

const MAX_MESSAGE_ROWS = 600
const MAX_JOB_ROWS = 300
const MAX_DELEGATIONS = 40

/**
 * The whole graph for one viewer. `viewerUserId` null is the signed-out
 * case, which is legitimate: the public half (jobs between named agents) is
 * already public on /live, and the rule in `buildNetwork` drops everything
 * else without this file needing to remember to.
 */
export async function buildAgentNetwork(viewerUserId: string | null): Promise<AgentNetwork> {
  const since = new Date(Date.now() - NETWORK_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const connectedUserIds = viewerUserId ? await connectedOfficesOf(viewerUserId) : []
  const visibleAccounts = viewerUserId ? [viewerUserId, ...connectedUserIds] : []

  /* The viewer's own agents — the seed for every private query below. */
  const myAgents = viewerUserId
    ? await db.select({ id: agent.id }).from(agent).where(eq(agent.userId, viewerUserId))
    : []
  const myAgentIds = myAgents.map((a) => a.id)

  /* Messages: only those with an endpoint the viewer owns. The visibility
     rule would drop the rest anyway — not fetching them is the same answer,
     cheaper, and means a stranger's message body never enters this process. */
  const messages: NetworkMessageRow[] =
    myAgentIds.length === 0
      ? []
      : (
          await db
            .select({
              fromAgentId: agentMessage.fromAgentId,
              toAgentId: agentMessage.toAgentId,
              type: agentMessage.type,
              body: agentMessage.body,
              createdAt: agentMessage.createdAt,
            })
            .from(agentMessage)
            .where(
              and(
                gt(agentMessage.createdAt, since),
                or(inArray(agentMessage.fromAgentId, myAgentIds), inArray(agentMessage.toAgentId, myAgentIds)),
              ),
            )
            .orderBy(desc(agentMessage.createdAt))
            .limit(MAX_MESSAGE_ROWS)
        ).map((m) => ({
          fromAgentId: m.fromAgentId,
          toAgentId: m.toAgentId,
          type: m.type,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
        }))

  /* Jobs: market-wide and public — a requester agent and the worker that
     accepted. This is the half of the graph a brand-new account can see,
     and the reason the page is not blank before you have said anything. */
  const jobs: NetworkJobRow[] = (
    await db
      .select({
        requesterAgentId: jobSpec.requesterAgentId,
        workerAgentId: jobSpec.workerAgentId,
        title: jobSpec.title,
        createdAt: jobSpec.createdAt,
      })
      .from(jobSpec)
      .where(and(gt(jobSpec.createdAt, since), isNotNull(jobSpec.requesterAgentId), isNotNull(jobSpec.workerAgentId)))
      .orderBy(desc(jobSpec.createdAt))
      .limit(MAX_JOB_ROWS)
  ).map((j) => ({
    requesterAgentId: j.requesterAgentId as string,
    workerAgentId: j.workerAgentId as string,
    title: j.title,
    at: j.createdAt.toISOString(),
  }))

  /* Handoffs: the viewer's own delegations only. A subtask that consumed
     another's finished output is a real information transfer between two
     workers — the one edge in this graph that exists because agents built
     on each other's work rather than merely talking about it. */
  const handoffs = viewerUserId ? await readHandoffs(viewerUserId, since) : []

  /* Offices the viewer may see the structure of, and the links between. */
  const offices: NetworkOfficeRow[] = []
  for (const uid of visibleAccounts) {
    for (const slot of await listOfficeSlots(uid)) {
      offices.push({ userId: uid, slot: slot.slot, name: slot.name })
    }
  }
  const officeLinks = viewerUserId ? connectedUserIds.map((other) => ({ a: viewerUserId, b: other })) : []

  /* Every agent any of the above referenced, plus everyone in a visible
     account — so an office with a silent roster still draws its people. */
  const wanted = new Set<string>(myAgentIds)
  for (const m of messages) {
    wanted.add(m.fromAgentId)
    wanted.add(m.toAgentId)
  }
  for (const j of jobs) {
    wanted.add(j.requesterAgentId)
    wanted.add(j.workerAgentId)
  }
  for (const h of handoffs) {
    wanted.add(h.fromAgentId)
    wanted.add(h.toAgentId)
  }

  const byId =
    wanted.size === 0
      ? []
      : await db
          .select({
            id: agent.id,
            name: agent.name,
            userId: agent.userId,
            creditScore: agent.creditScore,
            runtimeType: agent.runtimeType,
          })
          .from(agent)
          .where(inArray(agent.id, [...wanted]))

  const inVisibleAccounts =
    visibleAccounts.length === 0
      ? []
      : await db
          .select({
            id: agent.id,
            name: agent.name,
            userId: agent.userId,
            creditScore: agent.creditScore,
            runtimeType: agent.runtimeType,
          })
          .from(agent)
          .where(inArray(agent.userId, visibleAccounts))

  const agentsById = new Map<string, (typeof byId)[number]>()
  for (const row of [...byId, ...inVisibleAccounts]) agentsById.set(row.id, row)

  const slots = await officeSlotsByAgentId([...agentsById.keys()])

  return buildNetwork({
    viewerUserId,
    agents: [...agentsById.values()].map((a) => ({
      id: a.id,
      name: a.name,
      userId: a.userId,
      creditScore: Number(a.creditScore ?? 0),
      runtimeType: a.runtimeType,
      slot: slots.get(a.id) ?? null,
    })),
    offices,
    messages,
    handoffs,
    jobs,
    officeLinks,
    connectedUserIds,
  })
}

/**
 * A delegation's handoffs, resolved to the agents that actually did the
 * work: subtask B lists A in `dependsOn`, so A's worker → B's worker.
 *
 * Subtasks name each other by TITLE (that is what the planner emits and
 * what `tickDelegation` matches on), and a worker is only known once a job
 * has been accepted — so a pair with either side unclaimed produces no
 * edge. A missing worker is a job nobody took yet, not an anonymous one.
 */
async function readHandoffs(viewerUserId: string, since: Date): Promise<NetworkHandoffRow[]> {
  const rows = await db
    .select({ id: delegation.id, subtasks: delegation.subtasks, updatedAt: delegation.updatedAt })
    .from(delegation)
    .where(and(eq(delegation.userId, viewerUserId), gt(delegation.updatedAt, since)))
    .orderBy(desc(delegation.updatedAt))
    .limit(MAX_DELEGATIONS)

  const hashes = new Set<string>()
  for (const row of rows) {
    for (const s of (row.subtasks ?? []) as DelegationSubtask[]) {
      if (s?.specHash) hashes.add(s.specHash)
    }
  }
  if (hashes.size === 0) return []

  const specs = await db
    .select({ specHash: jobSpec.specHash, workerAgentId: jobSpec.workerAgentId })
    .from(jobSpec)
    .where(inArray(jobSpec.specHash, [...hashes]))
  const workerByHash = new Map(specs.map((s) => [s.specHash, s.workerAgentId]))

  const out: NetworkHandoffRow[] = []
  for (const row of rows) {
    const subtasks = ((row.subtasks ?? []) as DelegationSubtask[]).filter((s) => s && typeof s.title === 'string')
    const workerByTitle = new Map<string, string | null>()
    for (const s of subtasks) {
      workerByTitle.set(s.title, (s.specHash ? workerByHash.get(s.specHash) : null) ?? null)
    }
    for (const s of subtasks) {
      const consumer = workerByTitle.get(s.title)
      if (!consumer) continue
      const upstream = [...(s.dependsOn ?? []), ...(s.synthesizes ?? []), ...(s.reviewOf ? [s.reviewOf] : [])]
      for (const title of new Set(upstream)) {
        const producer = workerByTitle.get(title)
        if (!producer || producer === consumer) continue
        out.push({
          ownerUserId: viewerUserId,
          fromAgentId: producer,
          toAgentId: consumer,
          label: s.title,
          at: row.updatedAt.toISOString(),
        })
      }
    }
  }
  return out
}

/**
 * The office command-centre tiles. Deliberately NOT derived from the graph:
 * these count the viewer's own live state (agents, escrowed jobs in flight,
 * unread inbound), which is a different question from "who exchanged what",
 * and folding them together would make a tile silently inherit the graph's
 * 30-day window.
 */
export type NetworkDeskStats = {
  agents: number
  offices: number
  connectedOffices: number
  /** Unread agent_messages addressed to one of the viewer's agents. */
  unread: number
  /** Messages the viewer's agents sent in the last 24h. */
  sentToday: number
  /** Jobs this account's agents are currently working. */
  workingJobs: number
}

export async function readDeskStats(viewerUserId: string): Promise<NetworkDeskStats> {
  const myAgents = await db.select({ id: agent.id }).from(agent).where(eq(agent.userId, viewerUserId))
  const ids = myAgents.map((a) => a.id)
  const slots = await listOfficeSlots(viewerUserId)
  const connected = await connectedOfficesOf(viewerUserId)
  if (ids.length === 0) {
    return {
      agents: 0,
      offices: slots.length,
      connectedOffices: connected.length,
      unread: 0,
      sentToday: 0,
      workingJobs: 0,
    }
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const { rows: counts } = await pool.query<{ unread: string; sent: string }>(
    `SELECT
       (SELECT count(*) FROM agent_messages WHERE "toAgentId" = ANY($1) AND "readAt" IS NULL) AS unread,
       (SELECT count(*) FROM agent_messages WHERE "fromAgentId" = ANY($1) AND "createdAt" > $2) AS sent`,
    [ids, dayAgo],
  )
  const { rows: working } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM job_specs
      WHERE worker_agent_id = ANY($1) AND agent_task_id IS NOT NULL`,
    [ids],
  )

  return {
    agents: ids.length,
    offices: slots.length,
    connectedOffices: connected.length,
    unread: Number(counts[0]?.unread ?? 0),
    sentToday: Number(counts[0]?.sent ?? 0),
    workingJobs: Number(working[0]?.n ?? 0),
  }
}
