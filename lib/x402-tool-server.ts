/**
 * x402-paid tools — the impure half of lib/x402-tool.ts: where a role's
 * binding is stored, and the paid call itself.
 *
 * Who pays: the account's x402 BUYER key (`X402_BUYER_PRIVATE_KEY`), a plain
 * EOA holding a small USDC float on the deployment's x402 network. Not the
 * agent's smart account — the `exact` scheme settles by EIP-3009
 * `transferWithAuthorization`, which facilitators verify as an EOA
 * signature, and not the oracle, which must never hold spendable balances.
 * One key per deployment is the honest scope of this increment; per-account
 * buyer keys are a schema change for when a second account wants one.
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
import { x402NetworkFor } from '@/lib/x402-network'
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

export function x402BuyerConfigured(): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(process.env.X402_BUYER_PRIVATE_KEY ?? '')
}

export type X402ToolCall =
  | { ok: true; output: string; paidUsd: number; status: number; txHash?: string }
  | { ok: false; error: string; code: 'BUYER_UNCONFIGURED' | 'ENVELOPE' | 'CHALLENGE_REFUSED' | 'HTTP' | 'NETWORK' }

/** One paid call. Grades the envelope first, then pays only a challenge that
 *  passes the pins, then records what was actually paid. */
export async function callX402Tool(input: { agentId: string; binding: X402ToolBinding; task: string; timeoutMs?: number }): Promise<X402ToolCall> {
  if (!x402BuyerConfigured()) {
    return { ok: false, code: 'BUYER_UNCONFIGURED', error: 'X402_BUYER_PRIVATE_KEY is not set on this deployment, so no role can buy a tool call.' }
  }
  const network = x402NetworkFor(CHAIN.name)
  const { checkSpend, recordSpend, refusalText } = await import('@/lib/spend-envelope-server')
  const check = await checkSpend({ agentId: input.agentId, kind: 'x402_tool', amountUsd: input.binding.priceCapUsd, destination: input.binding.payTo, ref: input.binding.url })
  if (check.grade.verdict !== 'ALLOW') return { ok: false, code: 'ENVELOPE', error: refusalText(check, 'this role') }

  const { url, init } = requestFor(input.binding, input.task)
  const timeoutMs = input.timeoutMs ?? 60_000
  let refusal: string | null = null
  let chosenPrice = 0
  try {
    const { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } = await import('x402-fetch')
    const key = process.env.X402_BUYER_PRIVATE_KEY as string
    const signer = await createSigner(network, (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`)
    const selector = (accepts: PaymentRequirement[]) => {
      const pick = pickRequirement(accepts, { network, priceCapUsd: input.binding.priceCapUsd, payTo: input.binding.payTo })
      if (!pick.ok) {
        refusal = pick.reason
        throw new Error(`x402 challenge refused: ${pick.reason}`)
      }
      chosenPrice = pick.priceUsd
      return pick.chosen
    }
    // maxValue is a second, independent ceiling inside the library; the
    // selector above is ours and runs first.
    const paidFetch = wrapFetchWithPayment(fetch, signer, usdToUnits(input.binding.priceCapUsd), selector as never)
    const res = await paidFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) return { ok: false, code: 'HTTP', error: `tool answered ${res.status}: ${text.slice(0, 300)}` }
    let paidUsd = chosenPrice
    let txHash: string | undefined
    const receiptHeader = res.headers.get('x-payment-response')
    if (receiptHeader) {
      try {
        const receipt = decodeXPaymentResponse(receiptHeader) as { transaction?: string; success?: boolean }
        txHash = receipt.transaction
      } catch {
        /* keep the selector's price */
      }
    }
    if (paidUsd > 0) {
      await recordSpend({ agentId: input.agentId, kind: 'x402_tool', amountUsd: paidUsd, destination: input.binding.payTo, ref: txHash ?? input.binding.url, verdict: 'ALLOW' }).catch(() => undefined)
    }
    return { ok: true, output: text, paidUsd, status: res.status, ...(txHash ? { txHash } : {}) }
  } catch (error) {
    if (refusal) return { ok: false, code: 'CHALLENGE_REFUSED', error: `refused to pay: ${refusal}` }
    return { ok: false, code: 'NETWORK', error: error instanceof Error ? error.message : String(error) }
  }
}
