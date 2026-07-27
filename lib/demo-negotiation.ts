/**
 * Scripted A2A negotiation demo. A house "Ledger Broker" agent runs a full
 * job_proposal → job_counter_proposal → job_proposal_accept exchange against
 * one of a target user's agents, so the owner can watch a real structured
 * negotiation appear in /messages without hand-playing both sides.
 *
 * Uses sendAgentMessage() — the same guardrailed path the dashboard and BYO
 * agents use — so nothing here bypasses rate limits, blocks, or suspension.
 * Deliberately moves no money: a negotiation is agreement on terms, not an
 * escrow (that stays the Post-a-Job flow).
 */
import { db } from '@/lib/db'
import { user, agent } from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { sendAgentMessage } from '@/lib/agent-messages'

const BROKER_EMAIL = 'faucet@handsel.internal' // reuse the house owner account
const BROKER_NAME = 'Ledger Broker'

async function ensureBrokerAgent(): Promise<string> {
  let [owner] = await db.select().from(user).where(eq(user.email, BROKER_EMAIL))
  if (!owner) {
    const id = nanoid()
    await db.insert(user).values({ id, email: BROKER_EMAIL, name: 'Handsel Faucet', emailVerified: true })
    ;[owner] = await db.select().from(user).where(eq(user.id, id))
  }
  const [existing] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.userId, owner.id), eq(agent.name, BROKER_NAME)))
  if (existing) return existing.id

  const { randomBytes } = await import('node:crypto')
  const id = nanoid()
  await db.insert(agent).values({
    id,
    userId: owner.id,
    name: BROKER_NAME,
    walletAddress: `0x${randomBytes(20).toString('hex')}`,
    description: 'House broker — negotiates job terms with worker agents (demo counterpart).',
    modelVersion: 'claude-sonnet-5',
    creditScore: '720',
    creditRating: 'A',
    riskLevel: 'LOW',
    riskRating: 'low',
    totalCreditLine: '0',
    availableCredit: '0',
    capabilities: ['text'],
  })
  return id
}

/** Resolve the target worker agent: an explicit id wins; otherwise the most
 *  recently created agent belonging to the user with `email`. */
async function resolveTargetAgent(opts: { agentId?: string; email?: string }): Promise<{ id: string; name: string }> {
  if (opts.agentId) {
    const [a] = await db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.id, opts.agentId))
    if (!a) throw new Error(`agent ${opts.agentId} not found`)
    return a
  }
  if (!opts.email) throw new Error('provide agent_id or email')
  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, opts.email))
  if (!owner) throw new Error(`no user for email ${opts.email}`)
  const [a] = await db
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(eq(agent.userId, owner.id))
    .orderBy(desc(agent.createdAt))
    .limit(1)
  if (!a) throw new Error(`user ${opts.email} has no agents`)
  return a
}

export interface DemoNegotiationReport {
  broker: string
  worker: { id: string; name: string }
  steps: { type: string; from: string; body: string }[]
}

export async function runDemoNegotiation(opts: { agentId?: string; email?: string }): Promise<DemoNegotiationReport> {
  const brokerId = await ensureBrokerAgent()
  const worker = await resolveTargetAgent(opts)
  if (worker.id === brokerId) throw new Error('target agent is the broker itself')

  const deadline = 'within 3 days'
  const criteria = 'A 500-word product blurb, friendly tone, 3 SEO keywords woven in naturally.'

  // 1) Broker opens with a job proposal.
  await sendAgentMessage({
    fromAgentId: brokerId,
    toAgentId: worker.id,
    type: 'job_proposal',
    body: `Hi ${worker.name} — we need a product blurb. Offering $3 for ~500 words, ${deadline}. Interested?`,
    payload: { bounty_usd: 3, deadline, acceptance_criteria: criteria, min_score: 0 },
  })
  // 2) Worker counters — more scope, higher price.
  await sendAgentMessage({
    fromAgentId: worker.id,
    toAgentId: brokerId,
    type: 'job_counter_proposal',
    body: 'Happy to take it. With SEO keyword research and two revision rounds included, I can do it for $5.',
    payload: { bounty_usd: 5, deadline, acceptance_criteria: `${criteria} Includes up to 2 revisions.` },
  })
  // 3) Broker accepts the counter.
  await sendAgentMessage({
    fromAgentId: brokerId,
    toAgentId: worker.id,
    type: 'job_proposal_accept',
    body: 'Deal — $5 with 2 revisions. I will post the job with these terms and fund the escrow. Thanks!',
    payload: { bounty_usd: 5, deadline },
  })

  return {
    broker: BROKER_NAME,
    worker,
    steps: [
      { type: 'job_proposal', from: BROKER_NAME, body: '$3 for a ~500-word blurb' },
      { type: 'job_counter_proposal', from: worker.name, body: '$5 with SEO + 2 revisions' },
      { type: 'job_proposal_accept', from: BROKER_NAME, body: 'accepted at $5' },
    ],
  }
}
