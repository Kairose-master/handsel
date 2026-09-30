import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { externalJobInputError, createExternalJob } from '@/lib/external-job-create'
import { externalJobPricing, PRICE_ENV, BOUNTY_ENV } from '@/lib/external-job-pricing'
import {
  callXrplFacilitator,
  decodeXrplPaymentHeader,
  paymentMatchesRequirements,
  xrplMerchantConfig,
  xrplPaymentChallenge,
  xrplPaymentRequirements,
} from '@/lib/xrpl-x402-merchant'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type InvoiceState = 'settling' | 'settled' | 'posting' | 'complete' | 'failed'
let invoiceTableReady: Promise<void> | null = null

function ensureInvoiceTable(): Promise<void> {
  invoiceTableReady ??= (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS xrpl_external_job_payment (
      invoice_id text PRIMARY KEY,
      body_hash text NOT NULL,
      payment_hash text UNIQUE,
      payer text,
      state text NOT NULL CHECK (state IN ('settling','settled','posting','complete','failed')),
      response_status integer,
      response_body jsonb,
      payment_response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS xrpl_external_job_payment_created ON xrpl_external_job_payment (created_at)`)
    await pool.query(`ALTER TABLE xrpl_external_job_payment ADD COLUMN IF NOT EXISTS payment_response jsonb`)
  })()
  return invoiceTableReady
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((k) => `${JSON.stringify(k)}:${canonical(row[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function bodyHash(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex')
}

function jsonResponse(body: unknown, status = 200, paymentResponse?: unknown): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  if (paymentResponse) headers.set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(paymentResponse)).toString('base64'))
  return Response.json(body, { status, headers })
}

async function configuration() {
  const config = xrplMerchantConfig()
  if (!config) return { response: jsonResponse({ error: 'XRPL job posting is not configured. Set XRPL_PAY_TO, XRPL_RLUSD_ISSUER, XRPL_NETWORK, and XRPL_FACILITATOR_URL.' }, 503) } as const
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  const pricing = externalJobPricing({ isRealMoney: isRealMoney(), price: process.env[PRICE_ENV], bounty: process.env[BOUNTY_ENV] })
  if (!pricing.open) return { response: jsonResponse({ error: pricing.reason }, 503) } as const
  if (!process.env.X402_JOB_REQUESTER_AGENT_ID) return { response: jsonResponse({ error: 'Job posting is unavailable: X402_JOB_REQUESTER_AGENT_ID is unset.' }, 503) } as const
  const [house] = await db.select({ smartAccountAddress: agent.smartAccountAddress }).from(agent).where(eq(agent.id, process.env.X402_JOB_REQUESTER_AGENT_ID))
  if (!house?.smartAccountAddress) return { response: jsonResponse({ error: 'The Handsel job requester is not provisioned.' }, 503) } as const
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { response: jsonResponse({ error: 'Labor market is not configured on this deployment.' }, 503) } as const
  return { config, pricing } as const
}

export async function GET(request: Request) {
  const configured = await configuration()
  if ('response' in configured) return configured.response
  const invoice = xrplPaymentChallenge({ url: request.url, amountUsd: configured.pricing.priceUsd, config: configured.config })
  return Response.json(invoice.body, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': invoice.header, 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: Request) {
  const configured = await configuration()
  if ('response' in configured) return configured.response
  const body = await request.json().catch(() => null)
  const invalid = await externalJobInputError(body)
  if (invalid) return invalid

  const header = request.headers.get('payment-signature') ?? request.headers.get('x-payment')
  const payment = decodeXrplPaymentHeader(header)
  if (!payment) {
    const requestHash = bodyHash(body)
    const invoice = xrplPaymentChallenge({ url: request.url, amountUsd: configured.pricing.priceUsd, config: configured.config, invoiceId: `${requestHash.slice(0, 32)}.${randomUUID()}` })
    return Response.json(invoice.body, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': invoice.header, 'Cache-Control': 'no-store' },
    })
  }

  const invoiceId = payment.accepted.extra?.invoiceId
  if (typeof invoiceId !== 'string' || !paymentMatchesRequirements(
    payment,
    xrplPaymentRequirements({ config: configured.config, amountUsd: configured.pricing.priceUsd, invoiceId }),
  )) return jsonResponse({ error: 'Payment terms do not match this Handsel job-posting resource.' }, 402)

  const requestHash = bodyHash(body)
  if (!invoiceId.startsWith(`${requestHash.slice(0, 32)}.`)) return jsonResponse({ error: 'The payment invoice is bound to a different job request.' }, 409)

  const requirements = xrplPaymentRequirements({ config: configured.config, amountUsd: configured.pricing.priceUsd, invoiceId })
  const hash = createHash('sha256').update(payment.payload.signedTxBlob.toUpperCase()).digest('hex')
  await ensureInvoiceTable()
  const { rows } = await pool.query<{ body_hash: string; state: InvoiceState; response_status: number | null; response_body: unknown; payment_response: unknown }>(
    `SELECT body_hash, state, response_status, response_body, payment_response FROM xrpl_external_job_payment WHERE invoice_id = $1`, [invoiceId],
  )
  const row = rows[0]
  if (row?.state === 'complete') return jsonResponse(row.response_body, row.response_status ?? 200, row.payment_response)
  if (row && row.body_hash !== requestHash) return jsonResponse({ error: 'The invoice does not match this job request.' }, 409)
  if (row) {
    return jsonResponse({ status: row.state, invoice_id: invoiceId, message: 'This payment is already being processed. Do not retry with a new payment.' }, 202)
  }
  try {
    const claim = await pool.query(
      `INSERT INTO xrpl_external_job_payment (invoice_id, body_hash, payment_hash, state)
       VALUES ($1, $2, $3, 'settling') ON CONFLICT DO NOTHING RETURNING invoice_id`, [invoiceId, requestHash, hash],
    )
    if (!claim.rowCount) {
      const duplicate = await pool.query('SELECT invoice_id FROM xrpl_external_job_payment WHERE invoice_id = $1', [invoiceId])
      if (duplicate.rowCount) return jsonResponse({ status: 'settling', invoice_id: invoiceId, message: 'This invoice is already being processed. Do not retry.' }, 202)
      return jsonResponse({ error: 'This signed XRPL payment has already been used for another invoice.' }, 409)
    }
  } catch (error) {
    console.error('[xrpl-jobs] invoice claim failed (duplicate payment likely):', error)
    return jsonResponse({ error: 'This XRPL payment has already been used or is being processed.' }, 409)
  }

  let verification: { isValid?: boolean; valid?: boolean; invalidReason?: string }
  try {
    verification = await callXrplFacilitator(configured.config, 'verify', payment, requirements)
  } catch (error) {
    await pool.query(`DELETE FROM xrpl_external_job_payment WHERE invoice_id = $1 AND state = 'settling'`, [invoiceId])
    console.error('[xrpl-jobs] T54 verification unavailable:', error)
    return jsonResponse({ error: 'T54 payment verification is temporarily unavailable. Retry this invoice.' }, 502)
  }
  if (verification.isValid !== true && verification.valid !== true) {
    await pool.query(`DELETE FROM xrpl_external_job_payment WHERE invoice_id = $1 AND state = 'settling'`, [invoiceId])
    return jsonResponse({ error: 'XRPL payment verification failed.', reason: verification.invalidReason ?? 'invalid_payment' }, 402)
  }

  let settlement: { success?: boolean; transaction?: string; payer?: string; network?: string }
  try {
    settlement = await callXrplFacilitator(configured.config, 'settle', payment, requirements)
  } catch (error) {
    console.error('[xrpl-jobs] T54 settlement result is ambiguous; invoice consumed:', error)
    const receipt = { status: 'pending', invoice_id: invoiceId, message: 'Settlement status is being reconciled. Do not submit another payment.' }
    await pool.query(`UPDATE xrpl_external_job_payment SET state = 'failed', response_status = 202, response_body = $2, updated_at = now() WHERE invoice_id = $1`, [invoiceId, JSON.stringify(receipt)])
    return jsonResponse(receipt, 202)
  }
  if (settlement.success !== true || settlement.network !== configured.config.network || !settlement.transaction) {
    await pool.query(`UPDATE xrpl_external_job_payment SET state = 'failed', updated_at = now() WHERE invoice_id = $1`, [invoiceId])
    return jsonResponse({ error: 'XRPL facilitator did not confirm settlement.', invoice_id: invoiceId, paid: false }, 502)
  }

  const paymentResponse = { success: true, transaction: settlement.transaction, network: settlement.network, payer: settlement.payer ?? null }
  await pool.query(`UPDATE xrpl_external_job_payment SET state = 'posting', payer = $2, payment_response = $3, updated_at = now() WHERE invoice_id = $1`, [invoiceId, settlement.payer ?? null, JSON.stringify(paymentResponse)])
  try {
    const payer = settlement.payer ?? 'unattributed'
    const result = await createExternalJob({ body, payerKey: `xrpl:${payer}`, externalPoster: `xrpl:${payer}`, pricing: configured.pricing })
    const responseBody = await result.json().catch(() => ({ error: 'Job posting response could not be decoded.' }))
    await pool.query(`UPDATE xrpl_external_job_payment SET state = 'complete', response_status = $2, response_body = $3, updated_at = now() WHERE invoice_id = $1`, [invoiceId, result.status, JSON.stringify(responseBody)])
    return jsonResponse(responseBody, result.status, paymentResponse)
  } catch (error) {
    console.error('[xrpl-jobs] paid invoice could not be posted; consumed to prevent duplicate escrow:', error)
    const receipt = { status: 'pending', invoice_id: invoiceId, message: 'Payment settled but job posting needs reconciliation. Do not submit another payment.' }
    await pool.query(`UPDATE xrpl_external_job_payment SET state = 'failed', response_status = 202, response_body = $2, updated_at = now() WHERE invoice_id = $1`, [invoiceId, JSON.stringify(receipt)]).catch(() => undefined)
    return jsonResponse(receipt, 202, paymentResponse)
  }
}
