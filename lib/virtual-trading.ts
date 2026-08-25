/**
 * Account-less paper trading — Handsel's own virtual ledger, not KIS's. No
 * signup, no app key, works the moment someone opens /office/orders.
 *
 * The distinction that matters for CLAUDE.md's "no fake data, ever" rule:
 * the PRICE a fill happens at is real (lib/market-data.ts, fetched live at
 * order time) — what's simulated is the account itself (cash balance,
 * position bookkeeping, the matching), which is Handsel's own ledger, not a
 * claim about a real KIS account. The UI must always label it that way; see
 * app/(dashboard)/office/orders/page.tsx.
 *
 * MVP scope, stated plainly rather than silently: a limit order fills
 * immediately if the current real price already satisfies it, or is
 * rejected — there is no resting order book. Good enough to test a
 * rebalance plan's numbers against real prices; not a matching engine.
 */
import { pool } from '@/lib/db'
import { fetchQuote, fetchFxToUsd, normalizeSymbol, type Quote } from '@/lib/market-data'

const STARTING_CASH_USD = 100_000

async function ensureTables(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS virtual_trading_accounts (
       user_id text PRIMARY KEY,
       cash_usd numeric(18,2) NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS virtual_trading_positions (
       user_id text NOT NULL,
       symbol text NOT NULL,
       quantity numeric(18,4) NOT NULL,
       avg_cost_usd numeric(18,4) NOT NULL,
       PRIMARY KEY (user_id, symbol)
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS virtual_trading_fills (
       id text PRIMARY KEY,
       user_id text NOT NULL,
       symbol text NOT NULL,
       side text NOT NULL,
       quantity numeric(18,4) NOT NULL,
       price_usd numeric(18,4) NOT NULL,
       filled_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

async function ensureAccount(userId: string): Promise<number> {
  await ensureTables()
  await pool.query(
    `INSERT INTO virtual_trading_accounts (user_id, cash_usd) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, STARTING_CASH_USD],
  )
  const { rows } = await pool.query<{ cash_usd: string }>('SELECT cash_usd FROM virtual_trading_accounts WHERE user_id = $1', [userId])
  return Number(rows[0].cash_usd)
}

export type VirtualPosition = { symbol: string; quantity: number; avgCostUsd: number; currentPriceUsd: number; marketValueUsd: number }
export type VirtualPortfolio = { cashUsd: number; positions: VirtualPosition[]; equityUsd: number }

export async function virtualPortfolio(userId: string): Promise<VirtualPortfolio> {
  const cashUsd = await ensureAccount(userId)
  const { rows } = await pool.query<{ symbol: string; quantity: string; avg_cost_usd: string }>(
    'SELECT symbol, quantity, avg_cost_usd FROM virtual_trading_positions WHERE user_id = $1 AND quantity > 0 ORDER BY symbol',
    [userId],
  )
  const positions: VirtualPosition[] = []
  for (const row of rows) {
    let currentPriceUsd = Number(row.avg_cost_usd) // fallback if a live re-quote fails
    try {
      currentPriceUsd = await priceInUsd(row.symbol)
    } catch {
      /* stale mark rather than a broken page — real quote just unavailable right now */
    }
    const quantity = Number(row.quantity)
    positions.push({ symbol: row.symbol, quantity, avgCostUsd: Number(row.avg_cost_usd), currentPriceUsd, marketValueUsd: quantity * currentPriceUsd })
  }
  const equityUsd = cashUsd + positions.reduce((s, p) => s + p.marketValueUsd, 0)
  return { cashUsd, positions, equityUsd }
}

async function priceInUsd(rawSymbol: string): Promise<number> {
  const quote: Quote = await fetchQuote(rawSymbol)
  if (!Number.isFinite(quote.price) || quote.price <= 0) throw new Error(`Bad quote for ${quote.symbol}`)
  const fx = await fetchFxToUsd(quote.currency)
  return quote.price * fx
}

export type VirtualOrderInput = {
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  orderType: 'limit' | 'market'
  limitPriceUsd?: number
}

export type VirtualOrderResult =
  | { filled: true; symbol: string; side: 'buy' | 'sell'; quantity: number; priceUsd: number; cashUsdAfter: number }
  | { filled: false; reason: string }

/** Pure precondition check — same shape as lib/kis-orders.ts's
 *  validateOrderInput, testable without DB or network. */
export function validateVirtualOrderInput(input: VirtualOrderInput): { symbol: string; side: 'buy' | 'sell'; quantity: number; orderType: 'limit' | 'market'; limitPriceUsd?: number } {
  const symbol = normalizeSymbol(input.symbol)
  if (!symbol) throw new Error('symbol is required')
  if (input.side !== 'buy' && input.side !== 'sell') throw new Error('side must be "buy" or "sell"')
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('quantity must be a positive number')
  if (input.orderType === 'limit') {
    if (!Number.isFinite(input.limitPriceUsd) || (input.limitPriceUsd as number) <= 0) {
      throw new Error('limitPriceUsd is required and must be positive for a limit order')
    }
  } else if (input.orderType !== 'market') {
    throw new Error('orderType must be "limit" or "market"')
  }
  return { symbol, side: input.side, quantity: input.quantity, orderType: input.orderType, limitPriceUsd: input.limitPriceUsd }
}

export async function placeVirtualOrder(userId: string, input: VirtualOrderInput): Promise<VirtualOrderResult> {
  const order = validateVirtualOrderInput(input)
  await ensureAccount(userId)

  const marketPriceUsd = await priceInUsd(order.symbol)
  if (order.orderType === 'limit') {
    const limit = order.limitPriceUsd as number
    const satisfied = order.side === 'buy' ? marketPriceUsd <= limit : marketPriceUsd >= limit
    if (!satisfied) {
      return { filled: false, reason: `Current price ${marketPriceUsd.toFixed(2)} USD does not satisfy the ${limit.toFixed(2)} USD limit right now — no resting order book, try again or use market.` }
    }
  }
  const fillPriceUsd = order.orderType === 'limit' ? (order.limitPriceUsd as number) : marketPriceUsd
  const cost = fillPriceUsd * order.quantity

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: acctRows } = await client.query<{ cash_usd: string }>(
      'SELECT cash_usd FROM virtual_trading_accounts WHERE user_id = $1 FOR UPDATE',
      [userId],
    )
    const cashUsd = Number(acctRows[0].cash_usd)
    const { rows: posRows } = await client.query<{ quantity: string; avg_cost_usd: string }>(
      'SELECT quantity, avg_cost_usd FROM virtual_trading_positions WHERE user_id = $1 AND symbol = $2 FOR UPDATE',
      [userId, order.symbol],
    )
    const heldQty = Number(posRows[0]?.quantity ?? 0)
    const heldAvgCost = Number(posRows[0]?.avg_cost_usd ?? 0)

    if (order.side === 'buy') {
      if (cost > cashUsd + 0.01) {
        await client.query('ROLLBACK')
        return { filled: false, reason: `Insufficient virtual cash: need ${cost.toFixed(2)} USD, have ${cashUsd.toFixed(2)} USD.` }
      }
      const newQty = heldQty + order.quantity
      const newAvgCost = newQty > 0 ? (heldQty * heldAvgCost + cost) / newQty : 0
      await client.query(
        `INSERT INTO virtual_trading_positions (user_id, symbol, quantity, avg_cost_usd) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, symbol) DO UPDATE SET quantity = $3, avg_cost_usd = $4`,
        [userId, order.symbol, newQty, newAvgCost],
      )
      await client.query('UPDATE virtual_trading_accounts SET cash_usd = cash_usd - $2 WHERE user_id = $1', [userId, cost])
    } else {
      if (order.quantity > heldQty + 1e-9) {
        await client.query('ROLLBACK')
        return { filled: false, reason: `Insufficient virtual position: trying to sell ${order.quantity}, hold ${heldQty}.` }
      }
      const newQty = heldQty - order.quantity
      await client.query(
        `INSERT INTO virtual_trading_positions (user_id, symbol, quantity, avg_cost_usd) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, symbol) DO UPDATE SET quantity = $3`,
        [userId, order.symbol, newQty, heldAvgCost],
      )
      await client.query('UPDATE virtual_trading_accounts SET cash_usd = cash_usd + $2 WHERE user_id = $1', [userId, cost])
    }
    await client.query(
      `INSERT INTO virtual_trading_fills (id, user_id, symbol, side, quantity, price_usd) VALUES ($1, $2, $3, $4, $5, $6)`,
      [`vtf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, userId, order.symbol, order.side, order.quantity, fillPriceUsd],
    )
    const { rows: after } = await client.query<{ cash_usd: string }>('SELECT cash_usd FROM virtual_trading_accounts WHERE user_id = $1', [userId])
    await client.query('COMMIT')
    return { filled: true, symbol: order.symbol, side: order.side, quantity: order.quantity, priceUsd: fillPriceUsd, cashUsdAfter: Number(after[0].cash_usd) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
