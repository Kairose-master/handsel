import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getSession } from '@/lib/get-session'
import { agent, ciBountyPolicy } from '@/lib/db/schema'
import { validateCiBountyPolicy } from '@/lib/ci-bounty'
import { validateRepoFullName } from '@/lib/repo-jobs'
import { normalizeRepoFullName } from '@/lib/repo-job-post'

/**
 * Set or read a repo's CI-bounty policy — the standing authorisation that lets
 * a red check become a funded fix-job (lib/ci-bounty.ts).
 *
 * This endpoint IS the consent. A policy row is the only thing that turns the
 * auto-spend on, so writing one has to prove the writer may spend the funder's
 * money: the funder agent must belong to the authenticated user. Owning the
 * repo is not checked here and deliberately so — you may fund fixes for a repo
 * you do not own (an open-source project you depend on), but you may only ever
 * spend from an agent that is yours.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not signed in' }, { status: 401 })

  let body: { repoFullName?: string; funderAgentId?: string; bountyUsd?: number; dailyCapUsd?: number; enabled?: boolean }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 })
  }

  const repoFullName = normalizeRepoFullName(String(body.repoFullName ?? ''))
  if (!validateRepoFullName(repoFullName)) {
    return Response.json({ error: 'repoFullName must be owner/name' }, { status: 400 })
  }

  // The funder agent must be the caller's — spending is scoped to what you own.
  const funderAgentId = String(body.funderAgentId ?? '')
  const [funder] = await db
    .select({ id: agent.id, userId: agent.userId, wallet: agent.smartAccountAddress })
    .from(agent)
    .where(and(eq(agent.id, funderAgentId), eq(agent.userId, session.user.id)))
  if (!funder) return Response.json({ error: 'No such agent on your account' }, { status: 403 })
  if (!funder.wallet) return Response.json({ error: 'That agent has no wallet to fund from' }, { status: 400 })

  const bountyUsd = Number(body.bountyUsd)
  const dailyCapUsd = Number(body.dailyCapUsd)
  const check = validateCiBountyPolicy({ bountyUsd, dailyCapUsd })
  if (!check.ok) return Response.json({ error: check.reason }, { status: 400 })

  const { ensureCiBountyTable } = await import('@/lib/db/ensure-columns')
  await ensureCiBountyTable()

  await db
    .insert(ciBountyPolicy)
    .values({
      repoFullName,
      funderAgentId,
      bountyUsd: bountyUsd.toFixed(2),
      dailyCapUsd: dailyCapUsd.toFixed(2),
      enabled: body.enabled ?? true,
      createdBy: session.user.id,
    })
    .onConflictDoUpdate({
      target: ciBountyPolicy.repoFullName,
      set: {
        funderAgentId,
        bountyUsd: bountyUsd.toFixed(2),
        dailyCapUsd: dailyCapUsd.toFixed(2),
        enabled: body.enabled ?? true,
        updatedAt: new Date(),
      },
    })

  return Response.json({ ok: true, repoFullName, bountyUsd, dailyCapUsd, enabled: body.enabled ?? true })
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not signed in' }, { status: 401 })

  const repoFullName = normalizeRepoFullName(new URL(request.url).searchParams.get('repo') ?? '')
  if (!validateRepoFullName(repoFullName)) {
    return Response.json({ error: 'repo must be owner/name' }, { status: 400 })
  }

  const { ensureCiBountyTable } = await import('@/lib/db/ensure-columns')
  await ensureCiBountyTable()

  const [row] = await db.select().from(ciBountyPolicy).where(eq(ciBountyPolicy.repoFullName, repoFullName))
  if (!row) return Response.json({ policy: null })

  // Only the account that funds it may read its own policy back.
  const [funder] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, row.funderAgentId), eq(agent.userId, session.user.id)))
  if (!funder) return Response.json({ policy: null })

  return Response.json({
    policy: {
      repoFullName: row.repoFullName,
      funderAgentId: row.funderAgentId,
      bountyUsd: parseFloat(row.bountyUsd),
      dailyCapUsd: parseFloat(row.dailyCapUsd),
      enabled: row.enabled,
    },
  })
}
