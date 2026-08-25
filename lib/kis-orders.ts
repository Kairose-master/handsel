/**
 * Real (paper-account) order placement against Korea Investment &
 * Securities' Open API — the one part of the Securities Office feature
 * that is NOT reachable through the MCP/job-claiming pipeline, on purpose.
 *
 * kis_price_lookup and kis_account_balance (securities-mcp/) are read-only
 * and wired to hired agents, so Handsel's own autonomous job-claiming
 * pipeline can call them without a human in the loop — that's fine, nothing
 * they do has a side effect. Order placement is different: it has a real
 * side effect (a real paper-account fill), so it does NOT exist as an MCP
 * tool an agent can be wired to. It exists only as this module, called only
 * from a dedicated, human-driven UI action (app/actions/kis-orders.ts) where
 * a person reviews the exact ticker/side/quantity/price and clicks Place —
 * never from a delegation subtask's own output text, which an LLM wrote and
 * this project doesn't trust to control money movement on its own (that's
 * also why the order form never auto-fills from the Rebalance Planner's
 * draft text — a human reads it and retypes the numbers).
 *
 * Paper trading only, by construction, same as securities-mcp/kis_client.py:
 * PAPER_BASE_URL is the only base URL in this file, and the two order TR
 * IDs below are KIS's paper-mode codes (the "V"-prefixed pair) — their
 * real-account counterparts (the same codes with a "T" prefix instead) do
 * not appear anywhere in this file, checked by tests/kis-orders.test.ts.
 * Endpoint path, TR IDs, and required fields are copied from KIS's own
 * official example script (examples_llm/domestic_stock/order_cash/ in
 * koreainvestment/open-trading-api), not guessed.
 */
import { pool } from '@/lib/db'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

const PAPER_BASE_URL = 'https://openapivts.koreainvestment.com:29443'
const TOKEN_PATH = '/oauth2/tokenP'
const BALANCE_PATH = '/uapi/domestic-stock/v1/trading/inquire-balance'
const BALANCE_TR_ID = 'VTTC8434R'
const ORDER_PATH = '/uapi/domestic-stock/v1/trading/order-cash'
const ORDER_TR_ID = { buy: 'VTTC0012U', sell: 'VTTC0011U' } as const

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS kis_paper_credentials (
       user_id text PRIMARY KEY,
       app_key_enc text NOT NULL,
       app_secret_enc text NOT NULL,
       cano_enc text NOT NULL,
       prdt_cd text NOT NULL DEFAULT '01',
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

export async function setKisPaperCredentials(
  userId: string,
  input: { appKey: string; appSecret: string; cano: string; prdtCd?: string },
): Promise<void> {
  await ensureTable()
  const appKey = input.appKey.trim()
  const appSecret = input.appSecret.trim()
  const cano = input.cano.trim()
  const prdtCd = input.prdtCd?.trim() || '01'
  if (!appKey || !appSecret || !cano) throw new Error('App key, app secret, and account number are all required')
  await pool.query(
    `INSERT INTO kis_paper_credentials (user_id, app_key_enc, app_secret_enc, cano_enc, prdt_cd)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET app_key_enc = $2, app_secret_enc = $3, cano_enc = $4, prdt_cd = $5, updated_at = now()`,
    [userId, encryptSecret(appKey), encryptSecret(appSecret), encryptSecret(cano), prdtCd],
  )
  _tokenCache.delete(userId) // credentials changed — force a fresh token next call
}

export async function clearKisPaperCredentials(userId: string): Promise<void> {
  await ensureTable()
  await pool.query(`DELETE FROM kis_paper_credentials WHERE user_id = $1`, [userId])
  _tokenCache.delete(userId)
}

/** Configured state for display — last 4 of the app key only, never the secret. */
export async function kisPaperCredentialsStatus(userId: string): Promise<{ configured: boolean; appKeyLast4: string | null }> {
  await ensureTable()
  const { rows } = await pool.query<{ app_key_enc: string }>('SELECT app_key_enc FROM kis_paper_credentials WHERE user_id = $1', [userId])
  if (!rows[0]) return { configured: false, appKeyLast4: null }
  const appKey = decryptSecret(rows[0].app_key_enc)
  return { configured: true, appKeyLast4: appKey.slice(-4) }
}

async function credentialsFor(userId: string): Promise<{ appKey: string; appSecret: string; cano: string; prdtCd: string }> {
  await ensureTable()
  const { rows } = await pool.query<{ app_key_enc: string; app_secret_enc: string; cano_enc: string; prdt_cd: string }>(
    'SELECT app_key_enc, app_secret_enc, cano_enc, prdt_cd FROM kis_paper_credentials WHERE user_id = $1',
    [userId],
  )
  const row = rows[0]
  if (!row) throw new Error('No KIS paper-trading credentials on file — add them first')
  return {
    appKey: decryptSecret(row.app_key_enc),
    appSecret: decryptSecret(row.app_secret_enc),
    cano: decryptSecret(row.cano_enc),
    prdtCd: row.prdt_cd,
  }
}

const _tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getAccessToken(userId: string): Promise<{ token: string; appKey: string; appSecret: string; cano: string; prdtCd: string }> {
  const creds = await credentialsFor(userId)
  const cached = _tokenCache.get(userId)
  if (cached && Date.now() < cached.expiresAt) return { token: cached.token, ...creds }

  const res = await fetch(`${PAPER_BASE_URL}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: creds.appKey, appsecret: creds.appSecret }),
  })
  if (!res.ok) throw new Error(`KIS token request failed (${res.status})`)
  const body = (await res.json()) as { access_token: string; expires_in?: number }
  _tokenCache.set(userId, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 86400) * 1000 - 60_000 })
  return { token: body.access_token, ...creds }
}

function headers(auth: { token: string; appKey: string; appSecret: string }, trId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/plain',
    charset: 'UTF-8',
    authorization: `Bearer ${auth.token}`,
    appkey: auth.appKey,
    appsecret: auth.appSecret,
    tr_id: trId,
    custtype: 'P',
  }
}

export type PaperHolding = { pdno: string; prdtName: string; qty: string; avgCost: string; currentValue: string }

export async function inquirePaperBalance(userId: string): Promise<PaperHolding[]> {
  const auth = await getAccessToken(userId)
  const params = new URLSearchParams({
    CANO: auth.cano,
    ACNT_PRDT_CD: auth.prdtCd,
    AFHR_FLPR_YN: 'N',
    OFL_YN: '',
    INQR_DVSN: '02',
    UNPR_DVSN: '01',
    FUND_STTL_ICLD_YN: 'N',
    FNCG_AMT_AUTO_RDPT_YN: 'N',
    PRCS_DVSN: '01',
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  })
  const res = await fetch(`${PAPER_BASE_URL}${BALANCE_PATH}?${params}`, { headers: headers(auth, BALANCE_TR_ID) })
  if (!res.ok) throw new Error(`KIS balance lookup failed (${res.status})`)
  const body = (await res.json()) as { rt_cd: string; msg1?: string; output1?: Array<Record<string, string>> }
  if (body.rt_cd !== '0') throw new Error(`KIS balance lookup error: ${body.msg1 ?? 'unknown'}`)
  return (body.output1 ?? []).map((h) => ({
    pdno: h.pdno ?? '?',
    prdtName: h.prdt_name ?? '?',
    qty: h.hldg_qty ?? '?',
    avgCost: h.pchs_avg_pric ?? '?',
    currentValue: h.evlu_amt ?? '?',
  }))
}

export type OrderInput = {
  krxCode: string
  side: 'buy' | 'sell'
  quantity: number
  orderType: 'limit' | 'market'
  priceKrw?: number
}

export type NormalizedOrder = {
  krxCode: string
  side: 'buy' | 'sell'
  quantity: number
  ordDvsn: '00' | '01'
  priceKrw: number
}

/** Pure validation — no network, no DB. Every real-money-adjacent
 *  precondition lives here so it's covered without mocking KIS at all. */
export function validateOrderInput(input: OrderInput): NormalizedOrder {
  const krxCode = input.krxCode.trim()
  if (!/^\d{6}$/.test(krxCode)) throw new Error('krxCode must be exactly 6 digits')
  if (input.side !== 'buy' && input.side !== 'sell') throw new Error('side must be "buy" or "sell"')
  if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new Error('quantity must be a positive integer')
  if (input.orderType === 'limit') {
    if (!Number.isFinite(input.priceKrw) || (input.priceKrw as number) <= 0) {
      throw new Error('priceKrw is required and must be positive for a limit order')
    }
    return { krxCode, side: input.side, quantity: input.quantity, ordDvsn: '00', priceKrw: Math.round(input.priceKrw as number) }
  }
  if (input.orderType === 'market') {
    return { krxCode, side: input.side, quantity: input.quantity, ordDvsn: '01', priceKrw: 0 }
  }
  throw new Error('orderType must be "limit" or "market"')
}

export type OrderResult = { orderNo: string; orderTime: string; raw: Record<string, string> }

/** Places a REAL order against the caller's PAPER account — it fills
 *  against KIS's real paper matching engine. Never call this from anything
 *  other than a human clicking "Place" in the UI with numbers they typed
 *  themselves; see this file's header. */
export async function placePaperOrder(userId: string, input: OrderInput): Promise<OrderResult> {
  const order = validateOrderInput(input)
  const auth = await getAccessToken(userId)
  const trId = ORDER_TR_ID[order.side]
  const res = await fetch(`${PAPER_BASE_URL}${ORDER_PATH}`, {
    method: 'POST',
    headers: headers(auth, trId),
    body: JSON.stringify({
      CANO: auth.cano,
      ACNT_PRDT_CD: auth.prdtCd,
      PDNO: order.krxCode,
      ORD_DVSN: order.ordDvsn,
      ORD_QTY: String(order.quantity),
      ORD_UNPR: String(order.priceKrw),
      EXCG_ID_DVSN_CD: 'KRX',
      SLL_TYPE: order.side === 'sell' ? '01' : '',
      CNDT_PRIC: '',
    }),
  })
  if (!res.ok) throw new Error(`KIS order request failed (${res.status})`)
  const body = (await res.json()) as { rt_cd: string; msg1?: string; output?: Record<string, string> }
  if (body.rt_cd !== '0') throw new Error(`KIS order rejected: ${body.msg1 ?? 'unknown error'}`)
  const output = body.output ?? {}
  return { orderNo: output.ODNO ?? '?', orderTime: output.ORD_TMD ?? '?', raw: output }
}
