/**
 * Real, no-signup market data — the thing that lets the Securities Office
 * template actually run without anyone connecting a KIS account first.
 *
 * Two free public endpoints, no API key for either:
 * - Yahoo Finance's public chart endpoint (query1.finance.yahoo.com) for
 *   price/volume — undocumented but widely relied on; if it starts
 *   rejecting requests, fetchQuote fails loudly rather than inventing a
 *   number (see the "no fake data, ever" rule in CLAUDE.md).
 * - Google News RSS search for headlines. Its feed is scoped by Google's
 *   own terms to "personal, non-commercial" feed-reader use — worth
 *   knowing before leaning on it harder than "a few real headlines to
 *   ground an LLM's analysis," which is what this file does with it.
 *
 * Pure helpers (normalizeSymbol, parseNewsRss) are exported separately from
 * the network calls so they're unit-testable without mocking fetch.
 */

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search'
const UA = 'Mozilla/5.0 (compatible; Handsel/1.0)'

/** A bare 6-digit code is assumed to be KRX (KOSPI) and gets `.KS` — pass an
 *  already-suffixed symbol (AAPL, 005930.KQ) through unchanged. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase()
  return /^\d{6}$/.test(s) ? `${s}.KS` : s
}

export type Quote = {
  symbol: string
  currency: string
  price: number
  dayHigh: number
  dayLow: number
  prevClose: number
  volume: number
  asOf: string
}

export async function fetchQuote(rawSymbol: string): Promise<Quote> {
  const symbol = normalizeSymbol(rawSymbol)
  const res = await fetch(`${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`Quote lookup for ${symbol} failed (${res.status})`)
  const body = (await res.json()) as {
    chart?: { result?: Array<{ meta?: Record<string, unknown> }>; error?: { description?: string } }
  }
  const meta = body.chart?.result?.[0]?.meta
  if (!meta) throw new Error(`Quote lookup for ${symbol} failed: ${body.chart?.error?.description ?? 'no data'}`)
  return {
    symbol,
    currency: String(meta.currency ?? '?'),
    price: Number(meta.regularMarketPrice ?? NaN),
    dayHigh: Number(meta.regularMarketDayHigh ?? NaN),
    dayLow: Number(meta.regularMarketDayLow ?? NaN),
    prevClose: Number(meta.chartPreviousClose ?? NaN),
    volume: Number(meta.regularMarketVolume ?? NaN),
    asOf: new Date().toISOString(),
  }
}

/** USD-per-unit-of-`currency` rate, e.g. fetchFxToUsd('KRW') ~ 0.00072. */
export async function fetchFxToUsd(currency: string): Promise<number> {
  if (currency === 'USD') return 1
  const quote = await fetchQuote(`${currency}=X`)
  if (!Number.isFinite(quote.price) || quote.price <= 0) throw new Error(`Bad FX rate for ${currency}`)
  return 1 / quote.price // Yahoo quotes CURRENCY=X as units-of-currency per USD
}

export type Headline = { title: string; source: string; link: string; pubDate: string }

/** Parses Google News RSS XML into headline entries. No XML library
 *  dependency — the feed's <item> shape is simple and stable enough for a
 *  small regex-based extraction; a malformed/empty feed just yields []. */
export function parseNewsRss(xml: string, limit: number): Headline[] {
  const items: Headline[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while (items.length < limit && (match = itemRe.exec(xml))) {
    const block = match[1]
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim()
    if (!title || !link) continue
    items.push({ title: decodeXmlEntities(title), source: source ? decodeXmlEntities(source) : '?', link, pubDate: pubDate ?? '?' })
  }
  return items
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export async function fetchHeadlines(query: string, limit = 5): Promise<Headline[]> {
  const url = `${GOOGLE_NEWS_RSS_URL}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`News lookup for "${query}" failed (${res.status})`)
  return parseNewsRss(await res.text(), limit)
}
