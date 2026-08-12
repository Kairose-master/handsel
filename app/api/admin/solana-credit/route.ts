/**
 * POST /api/admin/solana-credit — publish a REAL agent's REAL credit score to
 * the Solana devnet registry.
 *
 * The product thesis is "a credit score earned from graded work, readable
 * on-chain" — this makes it true on the second runtime: the score published
 * is the one the credit engine computed from the agent's actual event
 * history (the same number the dashboard and the EVM registry show), written
 * to the agent's `Credit` PDA by the market's oracle key. No invented
 * numbers, per the repo rule: an agent with no history publishes its honest 0.
 *
 * Body: { agent_id }
 * Auth: operator secret, POST-only. Devnet-only via write.ts's guard.
 */
import { PublicKey, Keypair } from '@solana/web3.js'
import { requireOperator } from '@/lib/admin-route'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { solanaExplorerUrl } from '@/lib/onchain/solana/config'
import {
  fetchMarket,
  isSolanaWriteConfigured,
  loadOperatorKeypair,
  setCredit,
  solanaConnection,
} from '@/lib/onchain/solana/write'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: Request) {
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response

  if (!isSolanaWriteConfigured()) {
    return Response.json({ error: 'Solana write path is not configured' }, { status: 503 })
  }

  const body = await request.json().catch(() => null)
  const agentId = String(body?.agent_id ?? '').trim()
  if (!agentId) return Response.json({ error: 'agent_id is required' }, { status: 400 })

  const [row] = await db
    .select({ id: agent.id, name: agent.name, creditScore: agent.creditScore, totalCreditLine: agent.totalCreditLine })
    .from(agent)
    .where(eq(agent.id, agentId))
  if (!row) return Response.json({ error: 'unknown agent' }, { status: 404 })

  // The agent's identity on the Solana side. Agents don't hold Solana wallets
  // yet (the port is the money layer, not the account layer), so the PDA is
  // keyed by a deterministic address derived from the agent id — stable,
  // collision-free, and honest about what it is: a registry slot, not a
  // spending wallet.
  const { createHash } = await import('node:crypto')
  const agentKey = new PublicKey(createHash('sha256').update(`handsel-agent:${row.id}`).digest())

  const connection = solanaConnection()
  const operator = loadOperatorKeypair()!

  const market = await fetchMarket(connection)
  if (market.oracle !== operator.publicKey.toBase58()) {
    return Response.json(
      {
        error: `the operator key is not this market's oracle — the market's oracle is ${market.oracle} and only it may publish credit`,
      },
      { status: 409 },
    )
  }

  // The engine's numbers, as stored — score is an integer (0..900-ish),
  // the credit line is USD, published in 6dp base units like every token
  // amount this program handles.
  const score = BigInt(Math.max(0, Math.round(Number(row.creditScore) || 0)))
  const limit = BigInt(Math.max(0, Math.round((Number(row.totalCreditLine) || 0) * 1e6)))

  try {
    const { signature, creditPda } = await setCredit(connection, operator as Keypair, agentKey, score, limit)
    return Response.json({
      agent: { id: row.id, name: row.name },
      published: { score: score.toString(), limit_base_units: limit.toString() },
      credit_account: solanaExplorerUrl(creditPda.toBase58()),
      tx: signature,
    })
  } catch (error) {
    console.error('[solana-credit] publish failed:', error)
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
