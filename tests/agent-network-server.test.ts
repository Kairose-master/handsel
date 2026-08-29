/**
 * A regression pin for a real production defect: `/office/network` 500'd
 * with Next.js's generic "An error occurred in the Server Components
 * render" — the digest that hides the actual message in production.
 *
 * The cause was `readDeskStats`'s raw SQL against `agent_messages`, quoted
 * in drizzle's camelCase JS naming (`"toAgentId"`, `"readAt"`,
 * `"fromAgentId"`, `"createdAt"`) instead of the table's real snake_case
 * columns (`to_agent_id`, `read_at`, `from_agent_id`, `created_at` —
 * `lib/db/schema.ts`'s `agentMessage = pgTable('agent_messages', {
 * fromAgentId: text('from_agent_id'), ... })`). Postgres throws "column
 * does not exist" the instant that string executes, and nothing catches it
 * before the dashboard: there is no DB-backed test in this repo (drizzle
 * queries are exercised through the type-safe builder everywhere else,
 * never as a hand-written string), so a typo here had no path to being
 * caught before a real page load did.
 *
 * A live Postgres to run the real query against isn't available in this
 * suite, so the next-best guard is pinned here: read both files' *source*
 * and assert the raw SQL only ever names real columns. Cheap, and it would
 * have caught this exact defect on the commit that introduced it.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync('lib/agent-network-server.ts', 'utf8')
const schema = readFileSync('lib/db/schema.ts', 'utf8')

describe('readDeskStats — the agent_messages raw SQL names real columns', () => {
  it('uses the actual snake_case columns, not drizzle’s camelCase JS names', () => {
    expect(src).toContain('to_agent_id')
    expect(src).toContain('read_at')
    expect(src).toContain('from_agent_id')
    expect(src).toContain('created_at')
  })

  it('never quotes a camelCase identifier against agent_messages again', () => {
    const raw = src.match(/`[^`]*FROM agent_messages[^`]*`/gs) ?? []
    expect(raw.length).toBeGreaterThan(0)
    for (const query of raw) {
      expect(query).not.toMatch(/"[a-z]+[A-Z]/)
    }
  })

  it('the snake_case names asserted above are the table’s real ones, per its own schema', () => {
    // Belt and suspenders: confirm the schema itself still says what this
    // test assumes it says, so a future rename of the DB columns fails
    // HERE with a clear reason instead of failing silently in production.
    // (Not block-scoped to the pgTable call: `.default({})` a few lines down
    // closes on the FIRST naive `})`, so a non-greedy slice truncates before
    // readAt/createdAt. These four column declarations are distinctive
    // enough as flat substrings of the whole file.)
    expect(schema).toContain("fromAgentId: text('from_agent_id')")
    expect(schema).toContain("toAgentId: text('to_agent_id')")
    expect(schema).toContain("readAt: timestamp('read_at'")
    expect(schema).toContain("createdAt: timestamp('created_at'")
  })
})
