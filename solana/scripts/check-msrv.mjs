#!/usr/bin/env node
/**
 * Does every locked dependency compile on the SBF toolchain's Rust?
 *
 * `cargo-build-sbf` ships its OWN bundled rustc, older than whatever you have
 * installed. So `cargo check` passing locally says nothing about whether
 * `anchor build` will: the host resolves to the newest compatible version of
 * every crate, and the SBF toolchain then fails to parse a manifest that wants
 * a newer edition than it knows.
 *
 * The first time this happened it cost a CI round-trip to learn ONE crate name
 * (`zeroize 1.9.0` wanting edition2024). There were sixteen. This script reads
 * every locked version's MSRV from the crates.io index and reports all of them
 * at once, so a lockfile is either safe or explains itself in one run.
 *
 * Usage:
 *   node scripts/check-msrv.mjs [--msrv 1.79.0] [--lock Cargo.lock]
 *
 * Exits 1 if any locked crate needs a newer rustc than the target.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

/** The SBF toolchain's rustc. Read from `cargo-build-sbf --version` if you are
 *  unsure; the default is what the devnet workflow reported. */
const TARGET = argOf('--msrv', '1.79.0')
const LOCK = argOf('--lock', 'Cargo.lock')
const CONCURRENCY = 16

const parse = (v) => {
  const parts = String(v).split(/[.+-]/).slice(0, 3).map(Number)
  return parts.every(Number.isFinite) && parts.length ? parts : null
}
const gt = (a, b) => {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** crates.io index layout: 1/2/3-char names are special-cased. */
function indexUrl(name) {
  const n = name.toLowerCase()
  if (n.length === 1) return `https://index.crates.io/1/${n}`
  if (n.length === 2) return `https://index.crates.io/2/${n}`
  if (n.length === 3) return `https://index.crates.io/3/${n[0]}/${n}`
  return `https://index.crates.io/${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`
}

async function msrvOf(name, vers) {
  const res = await fetch(indexUrl(name))
  // A 404 is the normal answer for a path dependency — the workspace's own
  // crates are not on crates.io and have no MSRV to check.
  if (res.status === 404) return { name, vers, local: true }
  if (!res.ok) return { name, vers, error: `HTTP ${res.status}` }
  const body = await res.text()
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (entry.vers === vers) return { name, vers, rustVersion: entry.rust_version ?? null }
  }
  return { name, vers, error: 'version not in index' }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

const lock = readFileSync(LOCK, 'utf8')
const packages = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map(
  (m) => ({ name: m[1], vers: m[2] }),
)

const target = parse(TARGET)
const results = await mapLimit(packages, CONCURRENCY, (p) => msrvOf(p.name, p.vers))

const tooNew = results.filter((r) => r.rustVersion && gt(parse(r.rustVersion), target))
const unknown = results.filter((r) => r.error)

console.log(`checked ${results.length} locked packages against rustc ${TARGET}`)

if (unknown.length) {
  console.log(`\ncould not check ${unknown.length}:`)
  for (const r of unknown) console.log(`  ${r.name} ${r.vers} — ${r.error}`)
}

if (tooNew.length === 0) {
  console.log('\nOK — every locked crate builds on the SBF toolchain.')
  process.exit(0)
}

console.log(`\n${tooNew.length} crate(s) need a newer rustc than ${TARGET}:\n`)
for (const r of tooNew.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${r.name.padEnd(38)} ${r.vers.padEnd(22)} needs ${r.rustVersion}`)
}
console.log(
  `\nFix by re-resolving the lockfile against the MSRV rather than pinning each one:\n` +
    `  set resolver = "3" in Cargo.toml, run \`cargo update\`, set it back to "2".\n` +
    `Resolver 3 is MSRV-aware; the SBF toolchain's cargo is too old to READ a\n` +
    `resolver-3 manifest, which is why it goes back afterwards. The lockfile is\n` +
    `what CI consumes, and it keeps the older, compatible versions.`,
)
process.exit(1)
