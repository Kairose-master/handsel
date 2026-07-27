import { db } from '@/lib/db'
import { agent, agentTask } from '@/lib/db/schema'
import { inArray, eq, sql } from 'drizzle-orm'
import { classifyWorker, summarizeFleet } from '@/lib/worker-fleet'

export const dynamic = 'force-dynamic'

/**
 * GET /api/fleet — `kubectl get pods` for the worker fleet.
 *
 * Every worker agent with its phase (Ready / NotReady / Offline /
 * Unschedulable), the reason in one sentence, heartbeat age where liveness
 * is probe-based (local workers), and in-flight task count. Live queries
 * only, like every other number on this platform.
 *
 * Public by the same policy as /world: names and liveness are already
 * public there; ids, keys and owners are not exposed here.
 */
export async function GET() {
  const now = new Date()
  // Name the eight fields this endpoint classifies on. Selecting with no
  // column list asked Postgres for every column schema.ts declares —
  // which on a PUBLIC, unauthenticated route meant pulling each worker's
  // encrypted key ciphertext into memory to evaluate one Boolean, and made
  // this route break the moment a new column ships ahead of its migration.
  const agents = await db
    .select({
      id: agent.id,
      name: agent.name,
      runtimeType: agent.runtimeType,
      lastPollAt: agent.lastPollAt,
      smartAccountAddress: agent.smartAccountAddress,
      hasKey: sql<boolean>`${agent.webhookSecretEnc} is not null`,
      autoMine: agent.autoMine,
      creditScore: agent.creditScore,
    })
    .from(agent)

  const running = await db
    .select({ agentId: agentTask.agentId })
    .from(agentTask)
    .where(inArray(agentTask.status, ['queued', 'running', 'processing']))
  const inFlightByAgent = new Map<string, number>()
  for (const t of running) inFlightByAgent.set(t.agentId, (inFlightByAgent.get(t.agentId) ?? 0) + 1)

  const workers = agents.map((a) => {
    const status = classifyWorker(
      {
        runtimeType: a.runtimeType,
        lastPollAt: a.lastPollAt,
        provisioned: Boolean(a.smartAccountAddress),
        hasKey: a.hasKey,
        autoMine: a.autoMine,
      },
      now,
    )
    return {
      name: a.name,
      runtime: a.runtimeType ?? 'platform',
      phase: status.phase,
      reason: status.reason,
      heartbeatAgeSec: status.heartbeatAgeSec,
      autoMine: a.autoMine,
      inFlight: inFlightByAgent.get(a.id) ?? 0,
      creditScore: Number(a.creditScore),
    }
  })

  return Response.json({
    type: 'HandselFleet',
    at: now.toISOString(),
    summary: summarizeFleet(workers.map((w) => ({ status: { phase: w.phase, reason: w.reason, heartbeatAgeSec: w.heartbeatAgeSec }, autoMine: w.autoMine }))),
    workers: workers.sort((a, b) => a.phase.localeCompare(b.phase) || b.creditScore - a.creditScore),
  })
}
