import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every table schema.ts declares must exist somewhere that creates it.
 *
 * `db.select().from(x)` compiles fine against a table no migration ever made.
 * There is no type error, no build failure, and no test failure — the first
 * signal is a query throwing `relation does not exist` in production, on
 * whichever path happens to touch it first.
 *
 * Two tables were in exactly that state, and both were recent work:
 *
 *   dispute_rulings  the record the dispute gate writes AFTER moving money
 *   gas_spend        the ledger the sponsored-gas fuse reads
 *
 * `gas_spend` is the one worth remembering. lib/gas-budget.ts fails toward
 * SPONSORING when its ledger is unreadable — which is the correct direction,
 * because refusing would take the market down over a migration — and an
 * unreadable ledger is indistinguishable from an empty one. So the entire
 * app-side fuse answered SPONSOR to every call while looking exactly like a
 * quiet day. A fuse that cannot read its own ledger is not conservative, it is
 * decoration, and nothing in the system could have said so.
 *
 * This test is the thing that could have.
 */

const schema = readFileSync('lib/db/schema.ts', 'utf8')
const migration = readFileSync('scripts/migrate.mjs', 'utf8')

/** Tables created at runtime instead of by the migration — the codebase's other
 *  established pattern (CLAUDE.md: "many tables self-migrate on first use").
 *  DISCOVERED by scanning for the statement, not hardcoded, so a table that
 *  stops self-creating is caught rather than permanently excused. */
function runtimeCreated(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const src = readFileSync(path, 'utf8')
        for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([a-zA-Z0-9_]+)"?/g)) found.add(m[1])
      }
    }
  }
  walk('lib')
  walk('app')
  return found
}

describe('schema.ts and the migration agree', () => {
  const declared = [...schema.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1])

  it('finds the tables at all — the parse is the test here', () => {
    // If this regex ever stops matching, every assertion below passes
    // vacuously, which is the failure mode of every source-scanning test.
    expect(declared.length).toBeGreaterThan(30)
    expect(declared).toContain('gas_spend')
    expect(declared).toContain('agent')
  })

  it('creates every declared table somewhere', () => {
    const runtime = runtimeCreated()
    const missing = declared.filter(
      (t) => !new RegExp(`CREATE TABLE IF NOT EXISTS\\s+"?${t}"?`, 'i').test(migration) && !runtime.has(t),
    )
    expect(missing, `declared in schema.ts but never created: ${missing.join(', ')}`).toEqual([])
  })

  it('has the two that were missing, in the migration specifically', () => {
    // Named rather than left to the general check, because these two are the
    // reason it exists — and because a fresh database should have them before
    // the first request rather than after whichever path touches them first.
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS gas_spend/)
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS dispute_rulings/)
  })

  it('keeps the fuse able to build its own ledger too', () => {
    // Belt and braces, deliberately: the migration is run by a human, and the
    // whole failure was that nobody noticed it had not been. ops-lease.ts sets
    // the precedent — the tables that matter most create themselves.
    const src = readFileSync('lib/gas-budget.ts', 'utf8')
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS gas_spend/)
    // And both entry points must go through it, not just the read.
    expect(src).toMatch(/export async function gasSpentInWindow[\s\S]{0,400}ensureLedger\(\)/)
    expect(src).toMatch(/export async function recordGasSpend[\s\S]{0,400}ensureLedger\(\)/)
  })

  it('no longer claims the table self-migrates when it did not', () => {
    // The original comment asserted this table showed up on its own. It was the
    // only thing standing where a mechanism should have been.
    const src = readFileSync('lib/gas-budget.ts', 'utf8')
    expect(src).not.toMatch(/table self-migrates on first use/)
  })
})
