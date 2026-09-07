import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What `GET /api/world/frontier` and `GET /api/world/agents` may say, pinned
 * at the source. Both are polled by strangers' programs (a game's oracle, a
 * game's browser client) with no session, so what leaves here is what anyone
 * can read.
 */
const frontier = readFileSync(join(process.cwd(), 'app/api/world/frontier/route.ts'), 'utf8')
const agentsRoute = readFileSync(join(process.cwd(), 'app/api/world/agents/route.ts'), 'utf8')
const agentsFeed = readFileSync(join(process.cwd(), 'lib/world-agents-feed.ts'), 'utf8')

describe('the frontier feed states which money it is about', () => {
  it('derives meta from feedMeta(), never a literal', () => {
    expect(frontier).toMatch(/meta: feedMeta\(\)/)
    expect(frontier).not.toMatch(/environment:\s*['"](mainnet|testnet)['"]/)
    expect(frontier).not.toMatch(/realMoney:\s*(true|false)/)
  })
  it('sends meta even on the 503 path', () => {
    const idx503 = frontier.indexOf('status: 503')
    expect(idx503).toBeGreaterThan(0)
    expect(frontier.slice(0, idx503)).toMatch(/meta: feedMeta\(\)/)
  })
  it('carries the same untrusted-text warning the task feed does', () => {
    expect(frontier).toMatch(/safety: TASK_FEED_SAFETY/)
    expect(frontier).toMatch(/untrustedFields: TASK_FEED_UNTRUSTED_FIELDS/)
  })
  it('is readable from another origin', () => {
    expect(frontier).toMatch(/access-control-allow-origin/)
    expect(frontier).toMatch(/export async function OPTIONS/)
  })
  it('distinguishes an unreadable market from an empty one', () => {
    expect(frontier).toMatch(/state !== 'ok'/)
    expect(frontier).toMatch(/retry-after/)
  })
})

describe('the public agent rows expose only what the agent card already shows', () => {
  it('both routes read the one shared query', () => {
    expect(agentsRoute).toMatch(/publicAgentLeaderboard/)
    expect(frontier).toMatch(/publicAgentLeaderboard/)
  })
  it('never selects a private column', () => {
    for (const forbidden of ['email', 'ownerId', 'userId', 'secret', 'walletAddress', 'webhook', 'privateKey', 'apiKey']) {
      expect(agentsFeed, forbidden).not.toMatch(new RegExp(`agent\\.${forbidden}\\b`))
    }
  })
})
