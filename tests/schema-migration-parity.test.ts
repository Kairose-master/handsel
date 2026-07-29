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

/**
 * The same test one level down: every COLUMN, not just every table.
 *
 * The table check above was green while posting a job was impossible. Two
 * columns — `test_suite_slug` and `brief_nonce` — were declared in schema.ts by
 * the sealed-brief work and created by no CREATE, no ALTER, and no runtime
 * self-healer. `job_specs` existed, so the table-level guard had nothing to say.
 *
 * A missing column is worse than a missing table, because drizzle names every
 * column schema.ts declares in the INSERT it builds. One absent column does not
 * disable the feature that added it; it fails every write to the table. Here
 * that was `POST /jobs` — the product's first action — returning a 500 whose
 * cause production Next.js reduces to `digest: '3465974810'`.
 *
 * Same shape as the table check on purpose, including that it scans source
 * rather than a live database: the point is to fail in CI, before a deploy
 * makes it a 500.
 */
describe('schema.ts and the migration agree on columns', () => {
  /** table -> declared column db-names, read out of schema.ts. */
  function declaredColumns(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const m of schema.matchAll(/pgTable\(\s*'([^']+)'\s*,\s*\{/g)) {
      const open = schema.indexOf('{', m.index! + m[0].length - 1)
      let depth = 0
      let end = -1
      for (let i = open; i < schema.length; i++) {
        if (schema[i] === '{') depth++
        else if (schema[i] === '}' && --depth === 0) {
          end = i
          break
        }
      }
      // Comments first: this file documents columns in prose, and a name inside
      // a comment is not a declaration. Matching it would excuse the very thing
      // being checked — `onchain_contract` appears in three comments.
      const body = schema
        .slice(open, end)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      const cols = new Set<string>()
      const types =
        /\b(text|integer|bigint|boolean|jsonb|timestamp|numeric|real|doublePrecision|serial|uuid|date|varchar)\(\s*'([^']+)'/g
      for (const c of body.matchAll(types)) cols.add(c[2])
      out.set(m[1], cols)
    }
    return out
  }

  /** table -> columns any CREATE TABLE or ADD COLUMN in `src` produces. */
  function createdColumns(sources: string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    const unquote = (s: string) => s.replace(/"/g, '')
    const add = (table: string, col: string) => {
      const set = out.get(table) ?? new Set<string>()
      set.add(col)
      out.set(table, set)
    }
    for (const src of sources) {
      for (const t of src.matchAll(
        /CREATE TABLE (?:IF NOT EXISTS )?("?\w+"?)\s*\(([\s\S]*?)\n\s*\);/g,
      )) {
        for (const line of t[2].split('\n')) {
          const name = line.trim().match(/^("?\w+"?)\s+/)
          if (!name) continue
          const col = unquote(name[1])
          if (/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(col)) continue
          add(unquote(t[1]), col)
        }
      }
      for (const t of src.matchAll(
        /ALTER TABLE ("?\w+"?) ADD COLUMN (?:IF NOT EXISTS )?("?\w+"?)/g,
      )) {
        add(unquote(t[1]), unquote(t[2]))
      }
    }
    return out
  }

  const declared = declaredColumns()
  const created = createdColumns([migration, readFileSync('lib/db/ensure-columns.ts', 'utf8')])

  it('parses both sides — the parse is the test here', () => {
    // Every source-scanning assertion passes vacuously on a failed parse, so
    // pin known-present facts on each side before comparing them.
    expect(declared.size).toBeGreaterThan(30)
    expect(declared.get('job_specs')?.has('test_suite_slug')).toBe(true)
    expect(declared.get('job_specs')?.has('spec_hash')).toBe(true)
    expect(created.get('job_specs')?.has('pricing')).toBe(true)
    expect(created.get('agent')?.size ?? 0).toBeGreaterThan(3)
  })

  it('creates every column schema.ts declares', () => {
    const problems: string[] = []
    for (const [table, cols] of declared) {
      const have = created.get(table)
      // Tables created at runtime are the previous describe's business; a table
      // absent from both places is reported there, not twice.
      if (!have) continue
      const missing = [...cols].filter((c) => !have.has(c))
      if (missing.length) problems.push(`${table}: ${missing.join(', ')}`)
    }
    expect(problems, `declared in schema.ts but never created:\n${problems.join('\n')}`).toEqual([])
  })

  it('has the two that broke job posting, in the migration specifically', () => {
    // Named as well as covered by the sweep above, for the same reason the
    // table version names gas_spend: a fresh database should have these before
    // the first request, not after the first 500.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS test_suite_slug/)
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS brief_nonce/)
  })

  it('keeps the runtime self-healer covering them too', () => {
    // The migration is run by a human against a database that may already be
    // live. ensure-columns.ts is what closes the window between a deploy and
    // someone remembering to run it — and posting a job is not a path that can
    // afford to wait for the reminder.
    const src = readFileSync('lib/db/ensure-columns.ts', 'utf8')
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS test_suite_slug/)
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS brief_nonce/)
  })
})
