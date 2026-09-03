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

/* ── Leads: the same sample, kept instead of discarded ────────────────────
 *
 * The census opens a hundred real bounty issues every day to compute one
 * rate, then throws them away. docs/go-to-market.md §5 argues that the
 * first paying counterparty this market has ever had will come from exactly
 * this list — a maintainer who already posted a bounty and already has a way
 * to pay it — so from here the sample is also kept, qualified, and ranked.
 *
 * This is a sales tool, not a measurement, and the two rules that keep the
 * census honest apply in reverse here: the RATE must never be extrapolated to
 * a count, and the LIST must never be mistaken for demand. A ranked lead is
 * a place to look, and the score is a reason to look there first — every
 * reason is written out so a person can disagree with it.
 */

/** Just the fields of a GitHub search result item this reads. */
export interface IssueItem {
  html_url: string
  title: string
  body?: string | null
  created_at: string
  comments?: number
  labels?: { name?: string }[]
  repository_url?: string
}

/**
 * What `GET /repos/{owner}/{repo}` says about the repository behind a lead.
 * The first ranked list (2026-09-03) was mostly forks of well-known projects
 * under week-old accounts and repositories named "bounty-plaza" — agent
 * bounty farms, not maintainers with a backlog. None of that is visible in
 * the issue; all of it is visible in the repository. Every field is optional
 * so a lookup that fails costs the lead nothing but the signal.
 */
export interface RepoMeta {
  fork?: boolean
  stars?: number
  /** ISO. */
  createdAt?: string
  /** True when the metadata read itself failed — reported, never scored. */
  unreadable?: boolean
}

export interface Lead {
  url: string
  repo: string
  title: string
  /** First stated figure, as written. Null when none — never "0". */
  amount: string | null
  ageDays: number
  comments: number
  /** Something in the text names a bounty rail — the difference between a
   *  label and a way to get paid, which the census README learned the hard
   *  way. */
  paymentChannel: string | null
  score: number
  reasons: string[]
}

/** Rails that actually move money on merge. A body naming one of these is
 *  the strongest single signal in the sample. */
const CHANNEL_RE = /\b(algora|polar\.sh|gitcoin|opire|boss\.dev|bountysource|issuehunt|\/bounty\s+\$|onlydust|console\.dev|dework)\b/i

/** Labels that mean "scoped for an outsider" vs "not a task". */
const GOOD_LABELS = ['good first issue', 'help wanted', 'bounty', 'reward']
const BAD_LABELS = ['epic', 'discussion', 'question', 'wontfix', 'duplicate', 'rfc', 'tracking']

/** Titles a bot writes: a radar prefix, a week stamp, a "prize" for GMV. A
 *  human maintainer's issue does not announce itself as a feed. */
const BOT_TITLE_RE = /^\s*\[(radar|feed|digest|auto)\]|\bweek\s*\d{6,8}\b|\bGMV\b/i

/** A repository younger than this is a throwaway, not a project with a backlog. */
export const YOUNG_REPO_DAYS = 30
/** Stars at which a repository has users someone else might be, too. */
export const ESTABLISHED_STARS = 100

/** "owner/name" for an item — the key the metadata map uses. */
export function repoOf(item: IssueItem): string {
  return (item.repository_url ?? '').replace(/^.*\/repos\//, '') || item.html_url.replace(/^https:\/\/github\.com\//, '').split('/issues/')[0]
}

export function qualifyLead(item: IssueItem, nowMs: number, meta?: RepoMeta): Lead {
  const text = `${item.title}\n${item.body ?? ''}`
  const amountMatch = AMOUNT_RE.exec(text)
  const channelMatch = CHANNEL_RE.exec(text)
  const labels = (item.labels ?? []).map((l) => (l.name ?? '').toLowerCase())
  const ageDays = Math.max(0, Math.round((nowMs - Date.parse(item.created_at)) / 86_400_000))
  const comments = item.comments ?? 0
  const bodyLen = (item.body ?? '').trim().length
  const repo = repoOf(item)

  let score = 0
  const reasons: string[] = []
  const add = (pts: number, why: string) => {
    score += pts
    reasons.push(`${pts > 0 ? '+' : ''}${pts} ${why}`)
  }

  if (amountMatch) add(3, `states an amount (${amountMatch[0].trim()})`)
  else add(-2, 'no amount stated — a label is not money')
  if (channelMatch) add(3, `names a payment rail (${channelMatch[1].toLowerCase()})`)
  if (ageDays <= 14) add(2, `fresh (${ageDays}d)`)
  else if (ageDays > 90) add(-2, `stale (${ageDays}d) — nobody has taken it in three months`)
  if (comments === 0) add(1, 'no comments — unclaimed')
  else if (comments >= 8) add(-1, `${comments} comments — likely contested or already in progress`)
  if (bodyLen < 120) add(-2, 'body under 120 chars — underspecified')
  else if (bodyLen > 600) add(1, 'substantial brief')
  if (labels.some((l) => BAD_LABELS.includes(l))) add(-3, `labelled ${labels.filter((l) => BAD_LABELS.includes(l)).join(', ')} — not a task`)
  if (labels.some((l) => GOOD_LABELS.includes(l) && l !== 'bounty')) add(1, 'scoped for an outsider')
  if (BOT_TITLE_RE.test(item.title)) add(-3, 'title reads as a bot feed, not a maintainer')

  // The repository, when the caller looked it up. A fork is somebody else's
  // backlog; a repo younger than a month has no backlog; stars say whether
  // a merged PR would be seen by anyone but its author.
  if (meta && !meta.unreadable) {
    if (meta.fork) add(-4, 'a fork — the backlog belongs to the upstream project')
    if (meta.createdAt) {
      const repoAgeDays = Math.round((nowMs - Date.parse(meta.createdAt)) / 86_400_000)
      if (repoAgeDays >= 0 && repoAgeDays < YOUNG_REPO_DAYS) add(-3, `repository is ${repoAgeDays}d old — no backlog to speak of`)
    }
    if (typeof meta.stars === 'number') {
      if (meta.stars >= ESTABLISHED_STARS) add(2, `${meta.stars} stars — a merge would be seen`)
      else if (meta.stars === 0) add(-1, 'no stars')
    }
  } else if (meta?.unreadable) {
    reasons.push('repository metadata unreadable — not scored')
  }

  return {
    url: item.html_url,
    repo,
    title: item.title.trim().slice(0, 140),
    amount: amountMatch ? amountMatch[0].trim() : null,
    ageDays,
    comments,
    paymentChannel: channelMatch ? channelMatch[1].toLowerCase() : null,
    score,
    reasons,
  }
}

/** Ranked, one per repository — the first lead in a repo is a relationship,
 *  the fifth is the same relationship listed five times. */
export function qualifyLeads(items: IssueItem[], nowMs: number, limit = 25, metaByRepo?: ReadonlyMap<string, RepoMeta>): Lead[] {
  const seen = new Set<string>()
  return items
    .map((i) => qualifyLead(i, nowMs, metaByRepo?.get(repoOf(i))))
    .sort((a, b) => b.score - a.score || a.ageDays - b.ageDays)
    .filter((l) => (seen.has(l.repo) ? false : (seen.add(l.repo), true)))
    .slice(0, limit)
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const LEADS_HEADER = 'score,amount,channel,age_days,comments,repo,url,title,reasons'

export function leadsCsv(leads: Lead[]): string {
  return [
    LEADS_HEADER,
    ...leads.map((l) =>
      [l.score, l.amount, l.paymentChannel, l.ageDays, l.comments, l.repo, l.url, l.title, l.reasons.join('; ')]
        .map(csvCell)
        .join(','),
    ),
  ].join('\n')
}
