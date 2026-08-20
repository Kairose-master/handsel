/**
 * Demand census — measuring the claim the whole thesis rests on.
 *
 * `docs/product-thesis.md` says the binding constraint is demand, not
 * infrastructure. The evidence for that sentence is currently three anecdotes:
 * our own market is operator-funded, one BountyScout digest listed eight
 * "opportunities" of which zero actually paid, and a single afternoon of
 * hand-checking found Algora with two open bounties site-wide and Stacker
 * News's jobs board dead since December.
 *
 * Three anecdotes is not a measurement, and we are making a strong claim on
 * them. This module turns the hand-check into a daily series.
 *
 * ## What it measures, and what it does not
 *
 * It counts **GitHub-visible, bounty-labelled, open issues**. That is a
 * specific and narrow thing. It is not "demand for agent labor" — most paid
 * work in the world is not a labelled GitHub issue, and a labelled issue is not
 * proof anyone will pay. Saying otherwise would be the same overreach as
 * treating a reproducible payment as evidence of an unreproducible delivery
 * (see `watcher/src/physical-authority.ts` in the booth repo).
 *
 * What it can honestly support is a **trend on one channel**: whether the
 * surface a crawler can see is growing, flat, or dying. If our thesis is right
 * the series stays flat and near zero; if it is wrong the series will say so
 * before we notice by feel, which is the point of instrumenting a claim you
 * have an interest in.
 *
 * ## Why the counting is here and the fetching is not
 *
 * The GitHub search API needs a token and lives in the Action; this file is the
 * pure part so the arithmetic is testable without the network — the repo's
 * standing preference for pure functions over untested I/O.
 */

/** One query we run daily. `label` is what the row is called in the series. */
export interface CensusQuery {
  key: string
  q: string
  why: string
}

/**
 * The query set. Deliberately small — every query is a column in a CSV that
 * has to stay comparable for months, so adding one later is cheap and changing
 * one silently makes the whole history a lie.
 */
export const QUERIES: CensusQuery[] = [
  {
    key: 'bounty_open',
    q: 'is:issue is:open label:bounty',
    why: 'the broadest honest proxy: issues someone labelled as paid work and left open',
  },
  {
    key: 'bounty_open_unassigned',
    q: 'is:issue is:open label:bounty no:assignee',
    why: 'open AND unclaimed — the subset a newly arrived worker could actually take',
  },
  {
    key: 'bounty_fresh_30d',
    q: 'is:issue is:open label:bounty created:>{{d30}}',
    why: 'flow rather than stock. A large backlog of stale bounties is not demand',
  },
]

/**
 * Two queries were removed after the first reading (2026-08-20), and the reason
 * is worth keeping because it is a hole in this module's original design.
 *
 * `dollar_in_title` was `label:bounty "$" in:title` and returned **0**. GitHub
 * search discards `$` as punctuation, so the query could never match anything.
 * That is not a measurement of zero, it is a broken question — and it returned
 * HTTP 200 with `total_count: 0`, so `parseCount` correctly recorded a *valid*
 * zero. The null-vs-zero rule protects against a failed request. It does
 * nothing against a request that succeeds while asking the wrong thing, and
 * the wrong thing happened to answer in our favour.
 *
 * `algora_command` was `"/bounty $" in:comments` and returned 17,798 — four
 * times the total number of issues labelled `bounty`. Search almost certainly
 * dropped the punctuation and matched the bare word, so the column was
 * measuring something other than its name.
 *
 * Both are replaced by `sampleAmountRate` below, which opens real issues
 * instead of trusting a count. Counting is cheap and answers the wrong
 * question; a label is not money.
 */

/** A `$12`, `$1,500`, `500 USDC`, `50 usd` in text. Deliberately strict about
 *  requiring digits, so the word "bounty" alone never counts as an amount. */
export const AMOUNT_RE = /(?:\$\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usdc|usd|dai|eth|sats)\b)/i

export interface SampledIssue {
  title: string
  body?: string | null
}

export interface AmountRate {
  sampled: number
  withAmount: number
  /** Share of the sample that states a figure, 0–1, or null on an empty sample. */
  rate: number | null
}

/**
 * What share of labelled bounty issues actually state a number?
 *
 * This is the column that separates "someone applied a label" from "someone
 * named a price", and it is the only one of the two that bears on demand. It is
 * a *rate over a sample*, never extrapolated to a count in the CSV — multiplying
 * a sampled rate by a search total to produce "3,102 funded bounties" would be
 * exactly the manufactured number this repo keeps deleting.
 */
export function sampleAmountRate(issues: SampledIssue[]): AmountRate {
  const withAmount = issues.filter(
    (i) => AMOUNT_RE.test(i.title) || AMOUNT_RE.test(i.body ?? ''),
  ).length
  return {
    sampled: issues.length,
    withAmount,
    rate: issues.length === 0 ? null : Math.round((withAmount / issues.length) * 1000) / 1000,
  }
}

/** Substitute the date placeholders. Kept pure so the query set is testable. */
export function renderQuery(q: string, nowMs: number): string {
  const d30 = new Date(nowMs - 30 * 86_400_000).toISOString().slice(0, 10)
  return q.replace('{{d30}}', d30)
}

/**
 * Pull `total_count` out of a GitHub search response.
 *
 * Returns `null` rather than 0 on anything unexpected. A failed query recorded
 * as zero is indistinguishable from a channel that emptied out, which would
 * make the series confirm our thesis by accident — the exact failure the
 * ecosystem watch avoids by never writing a baseline on FETCH_FAILED.
 */
export function parseCount(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const n = (body as { total_count?: unknown }).total_count
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

export interface CensusRow {
  date: string
  counts: Record<string, number | null>
}

export const SAMPLED_KEYS = ['sampled_n', 'sampled_with_amount'] as const
export const CSV_HEADER = ['date', ...QUERIES.map((q) => q.key), ...SAMPLED_KEYS].join(',')

/** One CSV line. `null` is written as an empty field, never as 0. */
export function toCsvLine(row: CensusRow): string {
  const keys = [...QUERIES.map((q) => q.key), ...SAMPLED_KEYS]
  const cells = keys.map((k) => {
    const v = row.counts[k]
    return v === null || v === undefined ? '' : String(v)
  })
  return [row.date, ...cells].join(',')
}

export function parseCsv(text: string): CensusRow[] {
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length <= 1) return []
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const counts: Record<string, number | null> = {}
    header.slice(1).forEach((key, i) => {
      const raw = cells[i + 1]
      counts[key] = raw === undefined || raw === '' ? null : Number(raw)
    })
    return { date: cells[0]!, counts }
  })
}

export interface Trend {
  key: string
  first: number | null
  last: number | null
  /** Change over the observed window, or null when either end is missing. */
  deltaPct: number | null
  observations: number
  /** True when fewer than this many real readings exist to speak from. */
  tooEarly: boolean
}

/**
 * Below this many observations the series says nothing, and the report must say
 * that rather than print a percentage. A trend drawn from four points is the
 * kind of number that ends up in a pitch deck.
 */
export const MIN_OBSERVATIONS_FOR_TREND = 14

export function trendFor(rows: CensusRow[], key: string): Trend {
  const values = rows
    .map((r) => r.counts[key])
    .filter((v): v is number => typeof v === 'number')
  const first = values[0] ?? null
  const last = values.at(-1) ?? null
  const deltaPct =
    first !== null && last !== null && first > 0
      ? Math.round(((last - first) / first) * 1000) / 10
      : null
  return {
    key,
    first,
    last,
    deltaPct,
    observations: values.length,
    tooEarly: values.length < MIN_OBSERVATIONS_FOR_TREND,
  }
}

/** What the series may be said to support today, in one sentence per query. */
export function report(rows: CensusRow[]): string[] {
  return QUERIES.map((q) => {
    const t = trendFor(rows, q.key)
    if (t.observations === 0) return `${q.key}: no readings yet`
    if (t.tooEarly) {
      return `${q.key}: ${t.last} today, ${t.observations}/${MIN_OBSERVATIONS_FOR_TREND} readings — too early for a trend`
    }
    const dir = t.deltaPct === null ? 'unknown' : t.deltaPct > 0 ? `+${t.deltaPct}%` : `${t.deltaPct}%`
    return `${q.key}: ${t.last} today, ${dir} over ${t.observations} readings`
  })
}
