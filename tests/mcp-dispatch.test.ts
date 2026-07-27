import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '@/lib/mcp/tools-manifest'

/**
 * The manifest and the dispatch must not drift.
 *
 * Splitting a 900-line switch into seven modules has exactly one silent
 * failure mode: a tool that `tools/list` advertises but no handler claims.
 * TypeScript cannot see it — the names are strings on both sides — so it
 * compiles, ships, and answers "Unknown tool" the first time a connector calls
 * it. The reverse is quieter still: a handler for a tool nobody can discover.
 *
 * Read from source rather than by calling the handlers, because calling them
 * runs real work. Same reasoning as the compiled-SQL test in
 * tests/counterparty-independence.
 */

const HANDLER_DIR = 'lib/mcp/handlers'

const claimed = new Map<string, string[]>()
for (const file of readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts'))) {
  const source = readFileSync(`${HANDLER_DIR}/${file}`, 'utf8')
  for (const match of source.matchAll(/^ {4}case '([a-z_0-9]+)': \{$/gm)) {
    const name = match[1]
    claimed.set(name, [...(claimed.get(name) ?? []), file])
  }
}

const advertised = (TOOLS as { name: string }[]).map((t) => t.name)

describe('every advertised tool has a handler', () => {
  it.each(advertised)('%s is claimed', (name) => {
    expect(claimed.get(name) ?? []).not.toHaveLength(0)
  })
})

describe('no handler answers for a tool nobody can discover', () => {
  it('claims nothing outside the manifest', () => {
    const orphans = [...claimed.keys()].filter((name) => !advertised.includes(name))
    expect(orphans).toEqual([])
  })
})

describe('exactly one handler owns each tool', () => {
  it('has no duplicates across modules', () => {
    // The router returns the first non-null answer, so two claims would mean
    // one module silently shadows another and the loser is unreachable.
    const shared = [...claimed.entries()].filter(([, files]) => files.length > 1)
    expect(shared).toEqual([])
  })
})

describe('the split actually happened', () => {
  it('leaves the route file small enough to read', () => {
    // It was 75,740 bytes. The point of the exercise was reviewability, and a
    // number is the only way that stays true.
    expect(readFileSync('app/api/mcp/route.ts', 'utf8').length).toBeLessThan(10_000)
  })

  it('spreads the tools across several modules', () => {
    const files = new Set([...claimed.values()].flat())
    expect(files.size).toBeGreaterThan(3)
  })

  it('accounts for every tool the manifest declares', () => {
    expect(claimed.size).toBe(advertised.length)
  })
})
