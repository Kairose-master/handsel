#!/usr/bin/env node
/**
 * Seed the board with REAL jobs from data/seed-needs/needs.json — through the
 * paid public door, so every posting is a genuine x402 settlement and a
 * genuine house-escrowed bounty. No table is written directly; nothing is
 * staged (CLAUDE.md: "No fake data, ever").
 *
 * Why this exists: the market's own clearing data (`market_price`) has one
 * class with enough trades to price. A worker who connects and finds an
 * empty board leaves. The needs file turns two real sources of demand —
 * the daydreamsai/agent-bounties issues and the 402-LAB roadmap — into
 * gradeable, test-first jobs.
 *
 *   X402_CLIENT_KEY=0x<funded key> HANDSEL_ORIGIN=https://handsel-nu.vercel.app \
 *     node scripts/seed-needs.mjs            # posts every need not already open
 *   node scripts/seed-needs.mjs --dry-run    # prints what it would post
 *   node scripts/seed-needs.mjs --only 402lab-01-x402-challenge-pins
 *
 * Idempotent by title: a need whose exact title is already an Open job on
 * the public board is skipped. Each post costs the x402 fee ($0.10 on the
 * rehearsal board) and is capped by the route's own daily limit.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = JSON.parse(readFileSync(join(here, '..', 'data', 'seed-needs', 'needs.json'), 'utf8'))
const origin = (process.env.HANDSEL_ORIGIN ?? 'https://handsel-nu.vercel.app').replace(/\/$/, '')
const dryRun = process.argv.includes('--dry-run')
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

const needs = file.needs.filter((n) => !only || n.id === only)
if (needs.length === 0) {
  console.error('no needs selected')
  process.exit(1)
}

// What is already open, so a rerun never double-posts.
let openTitles = new Set()
try {
  const res = await fetch(`${origin}/api/tasks`)
  const tasks = await res.json()
  const list = Array.isArray(tasks) ? tasks : Array.isArray(tasks?.tasks) ? tasks.tasks : []
  openTitles = new Set(list.filter((t) => t.status === 'Open' || t.status === 'open').map((t) => String(t.title ?? '').trim()))
} catch (e) {
  console.warn(`could not read the open board (${e instanceof Error ? e.message : e}); posting without the duplicate check`)
}

const toPost = needs.filter((n) => !openTitles.has(n.title.trim()))
console.log(`${needs.length} needs, ${needs.length - toPost.length} already open, ${toPost.length} to post → ${origin}`)
for (const n of toPost) console.log(`  · [${n.id}] ${n.title}`)
if (dryRun || toPost.length === 0) process.exit(0)

const key = process.env.X402_CLIENT_KEY
if (!key) {
  console.error('X402_CLIENT_KEY is required to pay the posting fee (see scripts/x402-demo-client.mjs)')
  process.exit(1)
}
const { wrapFetchWithPayment, createSigner } = await import('x402-fetch')
const network = process.env.X402_NETWORK ?? 'base-sepolia'
const signer = await createSigner(network, key)
const paidFetch = wrapFetchWithPayment(fetch, signer)

let posted = 0
for (const n of toPost) {
  const res = await paidFetch(`${origin}/api/jobs/external`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: n.title,
      description: `${n.description}\n\nSource of demand: ${n.source}`,
      acceptance_criteria: n.acceptance_criteria,
      test_code: n.test_code,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.ok) {
    posted++
    console.log(`✓ [${n.id}] job ${body.jobId ?? '?'} posted`)
  } else {
    console.error(`✗ [${n.id}] ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    if (res.status === 429) break // the route's daily cap — stop rather than burn fees on refusals
  }
}
console.log(`posted ${posted}/${toPost.length}`)
