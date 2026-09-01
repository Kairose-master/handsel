'use server'

/**
 * World state — one snapshot powering the /world arcade page.
 *
 * Design rule: every sprite and animation on that page maps to a REAL
 * platform fact (an on-chain job status, an escrowed delegation subtask, a
 * VeilPoll commit). Nothing is invented for show — the game layer is a
 * different *rendering* of the same economy, never a different economy.
 *
 * Every section is best-effort: a missing table (migration pending) or a
 * hiccuping RPC degrades that section to empty instead of failing the page.
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent, artifact, delegation, jobSpec } from '@/lib/db/schema'
import { desc, eq, inArray } from 'drizzle-orm'
import { faucetAgentId } from '@/lib/job-faucet'

export interface WorldAgent {
  id: string
  name: string
  creditScore: number
  creditRating: string
  hasWallet: boolean
  /** Live on-chain activity: a job this agent's account is Accepted/Submitted on. */
  working: boolean
  workingTitle: string | null
  completedJobs: number
  isDelegate: boolean
}

export interface WorldJob {
  id: number
  title: string
  bounty: number
  status: string
  kind: string
  /** true when one of the viewer's agents is the worker */
  mine: boolean
}

export interface WorldSubtask {
  title: string
  bounty: number
  state: 'open' | 'active' | 'done' | 'failed' | 'integration'
}

export interface WorldDelegation {
  id: string
  goal: string
  status: string
  budget: number
  subtasks: WorldSubtask[]
}

export interface WorldPoll {
  proposalId: string
  title: string
  closesAt: string
  tally: { for: number; against: number; abstain: number; quorumMet: boolean }
  yourVote: string | null
  yourVoteRationale: string | null
  open: boolean
  /** On-chain VeilPoll mirror, when configured. */
  onchain: { address: string; phase: number; commitCount: number; revealCount: number } | null
}

/** A real deliverable one of the viewer's agents produced — an image
 *  thumbnail or a playable audio clip, straight from the artifact store. */
export interface WorldArtifact {
  id: string
  kind: 'image' | 'audio'
  mime: string
  name: string
  title: string
  agentName: string
}

export interface WorldState {
  agents: WorldAgent[]
  openJobs: WorldJob[]
  gallery: WorldArtifact[]
  delegations: WorldDelegation[]
  gov: {
    balance: number
    locked: number
    votingPower: number
    totalEarned: number
    pendingReviews: number
    delegateName: string | null
    delegatePolicy: string | null
    polls: WorldPoll[]
  } | null
  at: string
}

const VEILPOLL_READ_ABI = [
  { type: 'function', name: 'currentPhase', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'commitCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'revealCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export async function getWorldState(): Promise<WorldState> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const userId = session.user.id

  const state: WorldState = { agents: [], openJobs: [], gallery: [], delegations: [], gov: null, at: new Date().toISOString() }

  // ---- agents + on-chain job board -------------------------------------
  const myAgents = await db.select().from(agent).where(eq(agent.userId, userId)).catch(() => [])
  const myAddresses = new Map(
    myAgents.filter((a) => a.smartAccountAddress).map((a) => [a.smartAccountAddress!.toLowerCase(), a.id]),
  )

  let jobs: Awaited<ReturnType<typeof import('@/lib/onchain/labor').readJobs>> = []
  try {
    const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
    if (isLaborMarketConfigured()) {
      const { readJobs } = await import('@/lib/onchain/labor')
      jobs = await readJobs()
    }
  } catch {
    jobs = []
  }

  // Titles/kinds for the jobs we'll show, in one query.
  const wantedHashes = jobs.map((j) => j.specHash)
  const specs = wantedHashes.length
    ? await db
        .select({ specHash: jobSpec.specHash, title: jobSpec.title, kind: jobSpec.deliverableKind, officeOwnerId: jobSpec.officeOwnerId })
        .from(jobSpec)
        .where(inArray(jobSpec.specHash, wantedHashes))
        .catch(() => [])
    : []
  const specByHash = new Map(specs.map((s) => [s.specHash, s]))

  const activeByAgent = new Map<string, string>() // agentId → job title
  const completedByAgent = new Map<string, number>()
  for (const j of jobs) {
    const owner = myAddresses.get(j.worker?.toLowerCase?.() ?? '')
    if (!owner) continue
    const title = specByHash.get(j.specHash)?.title ?? `Job #${j.id}`
    if (j.status === 'Accepted' || j.status === 'Submitted') activeByAgent.set(owner, title)
    if (j.status === 'Completed') completedByAgent.set(owner, (completedByAgent.get(owner) ?? 0) + 1)
  }

  state.agents = myAgents.map((a) => ({
    id: a.id,
    name: a.name,
    creditScore: Number(a.creditScore),
    creditRating: a.creditRating ?? 'unrated',
    hasWallet: Boolean(a.smartAccountAddress),
    working: activeByAgent.has(a.id),
    workingTitle: activeByAgent.get(a.id) ?? null,
    completedJobs: completedByAgent.get(a.id) ?? 0,
    isDelegate: a.autoVote,
  }))

  // Same visibility rule as the board and the MCP listing: an office-scoped
  // job's title is the owner's material, so the world view hides the whole
  // row for anyone who is neither the owner nor a connected office.
  const { canSeeOfficeOnlyJob } = await import('@/lib/office')
  const openOnchain = jobs.filter((j) => j.status === 'Open')
  const openVisibility = await Promise.all(
    openOnchain.map((j) => canSeeOfficeOnlyJob(specByHash.get(j.specHash)?.officeOwnerId ?? null, userId)),
  )
  state.openJobs = openOnchain
    .filter((_, i) => openVisibility[i])
    .sort((a, b) => b.bounty - a.bounty)
    .slice(0, 12)
    .map((j) => ({
      id: j.id,
      title: specByHash.get(j.specHash)?.title ?? `Job #${j.id}`,
      bounty: j.bounty,
      status: j.status,
      kind: specByHash.get(j.specHash)?.kind ?? 'text',
      mine: myAddresses.has(j.requester?.toLowerCase?.() ?? ''),
    }))

  // ---- loot vault: real image/audio deliverables --------------------------
  // Shows the viewer's OWN agents' output AND anything produced for a house
  // (faucet) job — those are public sample bounties, so their results are
  // safe to display to everyone. Private delegated work stays visible only to
  // its requester (their own agent produced it → the "mine" branch).
  const myAgentIds = new Set(myAgents.map((a) => a.id))
  const faucetId = await faucetAgentId().catch(() => null)
  const rows = await db
    .select({
      id: artifact.id,
      mime: artifact.mime,
      name: artifact.name,
      agentId: artifact.agentId,
      title: jobSpec.title,
      requesterAgentId: jobSpec.requesterAgentId,
      producer: agent.name,
    })
    .from(artifact)
    .leftJoin(jobSpec, eq(jobSpec.agentTaskId, artifact.taskId))
    .leftJoin(agent, eq(agent.id, artifact.agentId))
    .orderBy(desc(artifact.createdAt))
    .limit(60)
    .catch(() => [] as { id: string; mime: string; name: string; agentId: string; title: string | null; requesterAgentId: string | null; producer: string | null }[])

  state.gallery = rows
    .filter((r) => r.mime.startsWith('image/') || r.mime.startsWith('audio/'))
    .filter((r) => myAgentIds.has(r.agentId) || (faucetId !== null && r.requesterAgentId === faucetId))
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      kind: r.mime.startsWith('image/') ? ('image' as const) : ('audio' as const),
      mime: r.mime,
      name: r.name,
      title: r.title ?? r.name,
      agentName: r.producer ?? 'agent',
    }))

  // ---- delegations as quest trees --------------------------------------
  try {
    const rows = await db.select().from(delegation).where(eq(delegation.userId, userId))
    const jobById = new Map(jobs.map((j) => [j.id, j]))
    state.delegations = rows
      .filter((d) => d.status === 'posted' || d.status === 'completed')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 4)
      .map((d) => ({
        id: d.id,
        goal: d.task.slice(0, 90),
        status: d.status,
        budget: Number(d.budgetUsd),
        subtasks: (d.subtasks as any[]).map((st): WorldSubtask => {
          const j = st.onchainJobId != null ? jobById.get(st.onchainJobId) : undefined
          let stState: WorldSubtask['state'] = 'open'
          if (st.isIntegration) stState = 'integration'
          else if (st.failed) stState = 'failed'
          else if (st.output || j?.status === 'Completed') stState = 'done'
          else if (j?.status === 'Accepted' || j?.status === 'Submitted') stState = 'active'
          return { title: String(st.title ?? '').slice(0, 60), bounty: Number(st.bountyUsd ?? 0), state: stState }
        }),
      }))
  } catch {
    state.delegations = []
  }

  // ---- governance temple ------------------------------------------------
  try {
    const { govSummary, listProposals, listPendingReviews } = await import('@/lib/governance')
    const [summary, proposals, reviews] = await Promise.all([
      govSummary(userId),
      listProposals(userId, 8),
      listPendingReviews(userId),
    ])

    const delegateAgent = myAgents.find((a) => a.autoVote && (a.votePolicy ?? '').trim())

    // On-chain ballot boxes for up to 3 mirrored proposals (best-effort).
    const { govProposal } = await import('@/lib/db/schema')
    const propRows = await db.select().from(govProposal).catch(() => [])
    const addrByProposal = new Map(propRows.map((p) => [p.id, p.onchainPollAddress]))

    let onchainReads = 0
    const polls: WorldPoll[] = []
    for (const p of proposals) {
      let onchain: WorldPoll['onchain'] = null
      const addr = addrByProposal.get(p.id)
      if (addr && onchainReads < 3) {
        onchainReads++
        try {
          const { isGovernanceOnchainConfigured } = await import('@/lib/onchain/config')
          if (isGovernanceOnchainConfigured()) {
            const { publicClient } = await import('@/lib/onchain/clients')
            const pc = publicClient()
            const [phase, cc, rc] = await Promise.all([
              pc.readContract({ address: addr as `0x${string}`, abi: VEILPOLL_READ_ABI, functionName: 'currentPhase' }),
              pc.readContract({ address: addr as `0x${string}`, abi: VEILPOLL_READ_ABI, functionName: 'commitCount' }),
              pc.readContract({ address: addr as `0x${string}`, abi: VEILPOLL_READ_ABI, functionName: 'revealCount' }),
            ])
            onchain = { address: addr, phase: Number(phase), commitCount: Number(cc), revealCount: Number(rc) }
          }
        } catch {
          onchain = null
        }
      }
      polls.push({
        proposalId: p.id,
        title: p.title,
        closesAt: p.closesAt,
        tally: { for: p.tally.for, against: p.tally.against, abstain: p.tally.abstain, quorumMet: p.tally.quorumMet },
        yourVote: p.yourVote,
        yourVoteRationale: p.yourVoteRationale,
        open: p.open,
        onchain,
      })
    }

    state.gov = {
      balance: summary.balance,
      locked: summary.locked,
      votingPower: summary.votingPower,
      totalEarned: summary.totalEarned,
      pendingReviews: reviews.length,
      delegateName: delegateAgent?.name ?? null,
      delegatePolicy: delegateAgent?.votePolicy?.slice(0, 140) ?? null,
      polls,
    }
  } catch {
    state.gov = null
  }

  return state
}
