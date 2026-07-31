import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq, ilike } from 'drizzle-orm'
import { DEFAULT_VAULT, availableToDrawUsd, healthFactor, maxDebtUsd, type Position } from '@/lib/mini-vault'

/**
 * Earnings → collateral bridge (preview). Reads an agent's REAL earned
 * (test) USDC balance on-chain and answers: "if this backed a MiniVault
 * position, what stable credit line would it open?" USDC is a dollar
 * stable, so collateralUnits = balance at price $1 — the same engine and
 * parameters as the deployed contract. Read-only: nothing moves.
 *
 *   GET /api/vault/quote-collateral?agent=<name | agent_id>
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const q = (url.searchParams.get('agent') ?? '').trim()
  if (!q) return Response.json({ error: 'agent (name or id) required' }, { status: 400 })

  const [row] = q.startsWith('agent_') || q.length > 20
    ? await db.select().from(agent).where(eq(agent.id, q))
    : await db.select().from(agent).where(ilike(agent.name, q))
  if (!row) return Response.json({ error: `agent "${q}" not found` }, { status: 404 })
  if (!row.smartAccountAddress) return Response.json({ error: 'agent has no wallet yet' }, { status: 409 })

  const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
  const balance = await usdcBalanceOf(row.smartAccountAddress as `0x${string}`)

  const pos: Position = { collateralUnits: balance, debtUsd: 0 }
  const priceUsd = 1 // USDC is the unit of account
  return Response.json({
    agent: row.name,
    wallet: row.smartAccountAddress,
    earnedUsdc: balance,
    asCollateral: {
      priceUsd,
      params: DEFAULT_VAULT,
      maxDebtUsd: maxDebtUsd(pos, priceUsd),
      availableToDrawUsd: availableToDrawUsd(pos, priceUsd),
      healthFactorIfMaxDrawn:
        maxDebtUsd(pos, priceUsd) > 0
          ? Math.round(healthFactor({ ...pos, debtUsd: maxDebtUsd(pos, priceUsd) }, priceUsd) * 1000) / 1000
          : null,
    },
    note: 'Preview only — nothing is escrowed or drawn.',
  })
}
