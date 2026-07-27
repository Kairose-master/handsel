import { db } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * GET /api/agents/:id/report — the full underwritten credit report.
 *
 * This is the paid counterpart of /card (x402-gated in middleware.ts when
 * X402_PAY_TO is set — $0.01/query, machine-payable). /card is the free
 * business card; this is the credit bureau pull: the underwritten number
 * PLUS the graded-fact history that produced it, separated by signal
 * grade so a consumer can weigh facts over opinions — the same
 * distinction the scoring engine itself makes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { recordX402Payment } = await import('@/lib/x402-ledger')
  await recordX402Payment({ endpoint: '/api/agents/<id>/report', request, amountUsd: 0.01 })

  const { id } = await params
  const [ag] = await db.select().from(agent).where(eq(agent.id, id))
  if (!ag) return Response.json({ error: 'Unknown agent' }, { status: 404 })

  const events = await db.select().from(agentEvent).where(eq(agentEvent.agentId, id))
  const count = (type: string) => events.filter((e) => e.eventType === type).length

  const tasksCompleted = count('TASK_COMPLETED')
  const tasksFailed = count('TASK_FAILED')
  const totalTasks = tasksCompleted + tasksFailed

  const report = {
    type: 'HandselCreditReport',
    generatedAt: new Date().toISOString(),
    agent: {
      id: ag.id,
      name: ag.name,
      address: ag.smartAccountAddress,
      runtime: ag.runtimeType ?? 'platform',
      createdAt: ag.createdAt,
    },
    underwriting: {
      creditScore: Math.round(parseFloat(ag.creditScore)),
      rating: ag.creditRating,
      riskLevel: ag.riskLevel,
      totalCreditLine: Number(ag.totalCreditLine ?? 0),
    },
    // Facts: independently graded, immune to the agent's own opinion.
    gradedFacts: {
      verifiedTasksCompleted: count('VERIFIED_TASK_COMPLETED'),
      verifiedTasksFailed: count('VERIFIED_TASK_FAILED'),
      acceptanceTestsPassed: count('JOB_TESTS_PASSED'),
      acceptanceTestsFailed: count('JOB_TESTS_FAILED'),
      paidJobsCompleted: count('JOB_COMPLETED'),
      repaymentsCompleted: count('REPAYMENT_COMPLETED'),
      repaymentDefaults: count('REPAYMENT_DEFAULTED'),
    },
    // Opinions: the runtime grading its own output — weighted below facts.
    selfEvaluated: {
      tasksCompleted,
      tasksFailed,
      successRate: totalTasks > 0 ? Number((tasksCompleted / totalTasks).toFixed(3)) : null,
    },
    methodology:
      'https://github.com/Kairose-master/ai-agent-credit-dashboard#the-two-grades-of-credit-signal',
  }

  return Response.json(report)
}
