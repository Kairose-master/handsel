/**
 * x402-paid tools — the impure half of lib/x402-tool.ts: where a role's
 * binding is stored, and the paid call itself.
 *
 * Each agent pays from its own encrypted EOA sub-wallet. It is deliberately
 * independent of the Kernel smart account: the current x402 exact signer is
 * an EOA. The old deployment-wide buyer key is never a fallback.
 *
 * What bounds it: the agent's spend envelope (`kind: 'x402_tool'`) graded
 * BEFORE the request at the binding's price cap, so a role cannot be walked
 * past its budget by a server that keeps answering 402; and `pickRequirement`
 * (pure) refusing any challenge outside the pinned network, asset, cap and
 * payTo. The amount actually paid is read back from the settlement receipt
 * and recorded, so the 24h ledger counts real spend, not the cap.
 */
import { pool } from '@/lib/db'
import { CHAIN } from '@/lib/onchain/config'
import { randomUUID } from 'node:crypto'
import { x402NetworkFor } from '@/lib/x402-network'
import { ensureX402Wallet, x402SignerKeyFor, x402WalletEncryptionConfigured } from '@/lib/x402-agent-wallet'
import { envelopeFor, recordSpend, refusalText } from '@/lib/spend-envelope-server'
import { gradeSpend } from '@/lib/spend-envelope'
import {
  parseX402ToolBinding,
  pickRequirement,
  requestFor,
  usdToUnits,
  type PaymentRequirement,
  type X402ToolBinding,
} from '@/lib/x402-tool'

let ensured: Promise<void> | null = null
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS agent_x402_tool (
           agent_id text PRIMARY KEY,
           binding jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        ensured = null
        throw e
      })
  }
  return ensured
}

export async function x402ToolFor(agentId: string): Promise<X402ToolBinding | null> {
  try {
    await ensureTable()
    const { rows } = await pool.query<{ binding: unknown }>(`SELECT binding FROM agent_x402_tool WHERE agent_id = $1`, [agentId])
    if (!rows[0]) return null
    const parsed = parseX402ToolBinding(rows[0].binding)
    return parsed.ok ? parsed.binding : null
  } catch {
    return null
  }
}

export async function setX402ToolFor(agentId: string, binding: X402ToolBinding): Promise<void> {
  await ensureTable()
  await pool.query(
    `INSERT INTO agent_x402_tool (agent_id, binding, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (agent_id) DO UPDATE SET binding = EXCLUDED.binding, updated_at = now()`,
    [agentId, JSON.stringify(binding)],
  )
}

export function x402WalletsConfigured(): boolean {
  return x402WalletEncryptionConfigured()
}

export { ensureX402Wallet }

export type X402ToolCall =
  | { ok: true; output: string; paidUsd: number; status: number; txHash?: string }
  | { ok: false; error: string; code: 'BUYER_UNCONFIGURED' | 'ENVELOPE' | 'CHALLENGE_REFUSED' | 'HTTP' | 'NETWORK' }

async function reserveSpend(input: { agentId: string; amountUsd: number; destination?: string; ref: string }) {
  const envelope = await envelopeFor(input.agentId)
  const id = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`x402-spend:${input.agentId}`])
    await client.query(`CREATE TABLE IF NOT EXISTS agent_x402_spend_reservation (
      id uuid PRIMARY KEY,
      agent_id text NOT NULL,
      amount_usd numeric(18,6) NOT NULL,
      status text NOT NULL CHECK (status IN ('reserved', 'released')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
    const { rows } = await client.query<{ spent: string }>(
      `SELECT COALESCE((SELECT sum(amount_usd) FROM agent_spend_event
          WHERE agent_id = $1 AND verdict = 'ALLOW' AND created_at > now() - interval '24 hours'), 0)
        + COALESCE((SELECT sum(amount_usd) FROM agent_x402_spend_reservation
          WHERE agent_id = $1 AND status = 'reserved' AND created_at > now() - interval '24 hours'), 0) AS spent`,
      [input.agentId],
    )
    const grade = gradeSpend(envelope, {
      kind: 'x402_tool', amountUsd: input.amountUsd, destination: input.destination,
      spentTodayUsd: Number(rows[0]?.spent ?? 0), ownerApproved: false,
    })
    if (grade.verdict !== 'ALLOW') {
      await client.query('ROLLBACK')
      await recordSpend({ ...input, kind: 'x402_tool', verdict: grade.verdict })
      return { ok: false as const, error: refusalText({ grade, envelope }, 'this agent') }
    }
    await client.query(
      `INSERT INTO agent_x402_spend_reservation (id, agent_id, amount_usd, status) VALUES ($1, $2, $3, 'reserved')`,
      [id, input.agentId, input.amountUsd.toFixed(6)],
    )
    await client.query('COMMIT')
    return { ok: true as const, id }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function releaseReservation(id: string): Promise<void> {
  await pool.query(`UPDATE agent_x402_spend_reservation SET status = 'released' WHERE id = $1 AND status = 'reserved'`, [id])
}

async function settleReservation(input: {
  id: string; agentId: string; amountUsd: number; destination?: string; ref: string
}): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`x402-spend:${input.agentId}`])
    await client.query(
      `INSERT INTO agent_spend_event (agent_id, kind, amount_usd, destination, verdict, owner_approved, ref)
       VALUES ($1, 'x402_tool', $2, $3, 'ALLOW', false, $4)`,
      [input.agentId, input.amountUsd.toFixed(6), input.destination?.toLowerCase() ?? null, input.ref],
    )
    await client.query(`UPDATE agent_x402_spend_reservation SET status = 'released' WHERE id = $1 AND status = 'reserved'`, [input.id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** One paid call. Grades the envelope first, then pays only a challenge that
 *  passes the pins, then records what was actually paid. */
export async function callX402Tool(input: { agentId: string; binding: X402ToolBinding; task: string; timeoutMs?: number }): Promise<X402ToolCall> {
  if (!x402WalletEncryptionConfigured()) {
    return { ok: false, code: 'BUYER_UNCONFIGURED', error: 'Per-agent x402 signing is not configured on this deployment.' }
  }
  const network = x402NetworkFor(CHAIN.name)
  let reservationId: string | null = null
  try {
    const reservation = await reserveSpend({ agentId: input.agentId, amountUsd: input.binding.priceCapUsd, destination: input.binding.payTo, ref: input.binding.url })
    if (!reservation.ok) return { ok: false, code: 'ENVELOPE', error: reservation.error }
    reservationId = reservation.id
  } catch (error) {
    return { ok: false, code: 'ENVELOPE', error: `Could not reserve this agent's spend limit: ${error instanceof Error ? error.message : String(error)}` }
  }

  const { url, init } = requestFor(input.binding, input.task)
  const timeoutMs = input.timeoutMs ?? 60_000
  let refusal: string | null = null
  let chosenPrice = 0
  let paymentMayHaveSettled = false
  try {
    const { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } = await import('x402-fetch')
    const key = await x402SignerKeyFor(input.agentId, network)
    const signer = await createSigner(network, key)
    const selector = (accepts: PaymentRequirement[]) => {
      const pick = pickRequirement(accepts, { network, priceCapUsd: input.binding.priceCapUsd, payTo: input.binding.payTo })
      if (!pick.ok) {
        refusal = pick.reason
        throw new Error(`x402 challenge refused: ${pick.reason}`)
      }
      chosenPrice = pick.priceUsd
      paymentMayHaveSettled = true
      return pick.chosen
    }
    // maxValue is a second, independent ceiling inside the library; the
    // selector above is ours and runs first.
    const paidFetch = wrapFetchWithPayment(fetch, signer, usdToUnits(input.binding.priceCapUsd), selector as never)
    const res = await paidFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    const paidUsd = chosenPrice
    let txHash: string | undefined
    const receiptHeader = res.headers.get('x-payment-response')
    if (receiptHeader) {
      try {
        const receipt = decodeXPaymentResponse(receiptHeader) as { transaction?: string; success?: boolean }
        if (receipt.success === false) {
          if (reservationId) await releaseReservation(reservationId)
          return { ok: false, code: 'NETWORK', error: 'The x402 settlement receipt reported failure.' }
        }
        txHash = receipt.transaction
      } catch {
        /* keep the selector's price */
      }
    }
    if (paidUsd > 0 && reservationId) await settleReservation({ id: reservationId, agentId: input.agentId, amountUsd: paidUsd, destination: input.binding.payTo, ref: txHash ?? input.binding.url })
    else if (reservationId) await releaseReservation(reservationId)
    if (!res.ok) return { ok: false, code: 'HTTP', error: `tool answered ${res.status}: ${text.slice(0, 300)}` }
    return { ok: true, output: text, paidUsd, status: res.status, ...(txHash ? { txHash } : {}) }
  } catch (error) {
    // If a payment challenge was selected, the facilitator may have settled
    // even when the request timed out. Keep its reservation for the 24h window
    // rather than reopening budget without a settlement record.
    if (reservationId && !paymentMayHaveSettled) await releaseReservation(reservationId).catch(() => undefined)
    if (refusal) return { ok: false, code: 'CHALLENGE_REFUSED', error: `refused to pay: ${refusal}` }
    return { ok: false, code: 'NETWORK', error: error instanceof Error ? error.message : String(error) }
  }
}
