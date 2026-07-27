import { planDelegation } from '@/lib/delegation'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Public demo of the real delegation planner — the core of the connector's
 * "delegate work" flow. Decomposes a goal into priced subtasks using the
 * same planDelegation() the MCP connector calls, keyed off the house faucet
 * account. Read-only (no escrow, no money) so it is safe to expose.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const WINDOW_MS = 60 * 60 * 1000
const PER_IP = 12
const hits = new Map<string, number[]>()
function rateLimited(ip: string): boolean {
  const now = Date.now()
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (arr.length >= PER_IP) return true
  arr.push(now)
  hits.set(ip, arr)
  return false
}

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (rateLimited(ip)) return Response.json({ error: 'rate limit' }, { status: 429 })

  let goal: string, budget: number
  try {
    const body = await request.json()
    goal = String(body?.goal ?? '').trim()
    budget = Math.max(2, Math.min(Number(body?.budget ?? 10) || 10, 100))
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 })
  }
  if (goal.length < 10 || goal.length > 500) {
    return Response.json({ error: 'goal must be 10-500 chars' }, { status: 400 })
  }

  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, 'faucet@handsel.internal'))
  if (!owner) return Response.json({ error: 'demo engine not configured' }, { status: 503 })

  try {
    const subtasks = await planDelegation(owner.id, goal, budget)
    return Response.json({
      status: 'ok',
      goal,
      budget,
      subtasks: subtasks.map((s) => ({
        title: s.title,
        bountyUsd: s.bountyUsd,
        deliverableKind: s.deliverableKind ?? 'text',
      })),
    })
  } catch (error) {
    console.error('[demo/plan] failed:', error)
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
