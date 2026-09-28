import { and, eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agent, oauthToken } from '@/lib/db/schema'
import { resolveExtensionAuth } from '@/lib/oauth'
import { envelopeFor, setEnvelopeFor, spentTodayUsd } from '@/lib/spend-envelope-server'
import { parseEnvelope } from '@/lib/spend-envelope'

export const dynamic = 'force-dynamic'

type SpendRow = {
  id: string
  agent_id: string
  kind: string
  amount_usd: string
  destination: string | null
  verdict: string
  ref: string | null
  created_at: Date
}

export async function GET(request: Request) {
  const auth = await resolveExtensionAuth(request)
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const agents = await db
      .select({ id: agent.id, name: agent.name })
      .from(agent)
      .where(eq(agent.userId, auth.userId))
      .orderBy(agent.name)
      .limit(64)

    const budgets = await Promise.all(agents.map(async (row) => {
      const [envelope, spent] = await Promise.all([
        envelopeFor(row.id),
        spentTodayUsd(row.id),
      ])
      return { agentId: row.id, name: row.name, envelope, spentTodayUsd: spent }
    }))

    const recent: SpendRow[] = agents.length
      ? (await pool.query<SpendRow>(
          `SELECT id::text, agent_id, kind, amount_usd::text, destination, verdict, ref, created_at
             FROM agent_spend_event
            WHERE agent_id = ANY($1::text[])
            ORDER BY created_at DESC
            LIMIT 40`,
          [agents.map((row) => row.id)],
        )).rows
      : []

    return Response.json({
      user: { email: auth.email },
      agents: budgets,
      recent: recent.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        kind: row.kind,
        amountUsd: Number(row.amount_usd),
        destination: row.destination,
        verdict: row.verdict,
        reference: row.ref,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[extension/dashboard] read failed:', error)
    return Response.json({ error: 'Could not load spending controls' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const auth = await resolveExtensionAuth(request)
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const agentId = typeof body?.agentId === 'string' ? body.agentId : ''
  if (!agentId) return Response.json({ error: 'agentId is required' }, { status: 400 })

  try {
    const [owned] = await db
      .select({ id: agent.id })
      .from(agent)
      .where(and(eq(agent.id, agentId), eq(agent.userId, auth.userId)))
      .limit(1)
    if (!owned) return Response.json({ error: 'Agent not found' }, { status: 404 })

    const current = await envelopeFor(agentId)
    const next = parseEnvelope({
      ...current,
      perTxMaxUsd: body?.perTxMaxUsd ?? current.perTxMaxUsd,
      dailyMaxUsd: body?.dailyMaxUsd ?? current.dailyMaxUsd,
      autoApproveMaxUsd: body?.autoApproveMaxUsd ?? current.autoApproveMaxUsd,
    })
    if (!next) {
      return Response.json({ error: 'Limits must satisfy 0 ≤ auto-approve ≤ per-payment ≤ daily.' }, { status: 400 })
    }
    await setEnvelopeFor(agentId, next)
    return Response.json({ agentId, envelope: next }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[extension/dashboard] update failed:', error)
    return Response.json({ error: 'Could not update spending limits' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const auth = await resolveExtensionAuth(request)
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  await db.delete(oauthToken).where(and(
    eq(oauthToken.token, token),
    eq(oauthToken.userId, auth.userId),
    eq(oauthToken.scope, 'extension:read extension:write'),
  ))
  return Response.json({ ok: true })
}
