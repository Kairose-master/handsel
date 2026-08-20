// Demand census — one reading per day, appended to data/demand-census/series.csv
//
// Runs in GitHub Actions because the search API needs a token, and a public
// repo gets it for free. The arithmetic lives in lib/demand-census.ts with
// tests; this file is only the network and the file append.
//
// It counts GitHub-visible bounty-labelled open issues. That is a narrow thing
// and the module header says so at length: it is a trend on one channel, not a
// measurement of demand for agent labor.
//
// A query that fails is written as an EMPTY field, never as 0 — a failure
// recorded as zero would make the series confirm our own thesis by accident.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const OUT = 'data/demand-census/series.csv'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required; the search API is not anonymous.')
  process.exit(1)
}

// The pure module is TypeScript; read the query set out of it rather than
// duplicating it here, so the CSV header and the queries cannot drift apart.
const src = readFileSync('lib/demand-census.ts', 'utf8')
const block = src.slice(src.indexOf('export const QUERIES'), src.indexOf('/** Substitute the date'))
const QUERIES = [...block.matchAll(/key:\s*'([^']+)',\s*\n\s*q:\s*'([^']+)'/g)].map(([, key, q]) => ({ key, q }))
if (QUERIES.length === 0) throw new Error('could not read QUERIES out of lib/demand-census.ts')

const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const today = new Date().toISOString().slice(0, 10)

async function count(q) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
    })
    if (r.status === 403 || r.status === 429) {
      // Secondary rate limit. Back off rather than hammering someone else's API.
      await new Promise((res) => setTimeout(res, 20_000 * (attempt + 1)))
      continue
    }
    if (!r.ok) return null
    const body = await r.json().catch(() => null)
    const n = body && typeof body.total_count === 'number' && body.total_count >= 0 ? body.total_count : null
    return n
  }
  return null
}

const counts = {}
for (const { key, q } of QUERIES) {
  counts[key] = await count(q.replace('{{d30}}', d30))
  console.log(`${key.padEnd(24)} ${counts[key] ?? 'FAILED'}`)
  await new Promise((res) => setTimeout(res, 3_000)) // search API is 30 req/min; be well under
}

// Sampled column: open real issues and count how many state a figure. A label
// is not money, and counting labels cannot tell the difference. The rate is
// recorded as sampled_n / sampled_with_amount and never extrapolated to a
// total — a sampled rate multiplied by a search count is a manufactured number.
const AMOUNT_RE = /(?:\$\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usdc|usd|dai|eth|sats)\b)/i
try {
  const url =
    'https://api.github.com/search/issues?q=' +
    encodeURIComponent('is:issue is:open label:bounty no:assignee sort:created-desc') +
    '&per_page=100'
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
  })
  if (r.ok) {
    const body = await r.json()
    const items = Array.isArray(body.items) ? body.items : []
    const withAmount = items.filter(
      (i) => AMOUNT_RE.test(i.title ?? '') || AMOUNT_RE.test(i.body ?? ''),
    ).length
    counts.sampled_n = items.length
    counts.sampled_with_amount = withAmount
    console.log(`sample                   ${withAmount}/${items.length} state an amount`)
  } else {
    counts.sampled_n = null
    counts.sampled_with_amount = null
    console.log('sample                   FAILED')
  }
} catch {
  counts.sampled_n = null
  counts.sampled_with_amount = null
  console.log('sample                   FAILED')
}

if (Object.values(counts).every((v) => v === null)) {
  console.error('every query failed — writing nothing rather than a row of blanks')
  process.exit(0)
}

mkdirSync('data/demand-census', { recursive: true })
const SAMPLED = ['sampled_n', 'sampled_with_amount']
const header = ['date', ...QUERIES.map((q) => q.key), ...SAMPLED].join(',')
if (!existsSync(OUT)) writeFileSync(OUT, header + '\n')

const existing = readFileSync(OUT, 'utf8')
if (existing.split('\n').some((l) => l.startsWith(today + ','))) {
  console.log(`${today} already recorded; not appending a second reading`)
  process.exit(0)
}

const line = [today, ...QUERIES.map((q) => counts[q.key] ?? ''), ...SAMPLED.map((k) => counts[k] ?? '')].join(',')
writeFileSync(OUT, existing.replace(/\n*$/, '\n') + line + '\n')
console.log(`appended: ${line}`)

try {
  execFileSync('git', ['add', OUT])
  execFileSync('git', ['-c', 'user.name=handsel-census', '-c', 'user.email=census@users.noreply.github.com',
    'commit', '-m', `data(census): ${today}`])
  execFileSync('git', ['push'])
} catch {
  console.log('nothing to commit, or push not permitted in this context')
}
