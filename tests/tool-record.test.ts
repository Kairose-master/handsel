import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { publishableServerUrl, toolIdentityOf, displayHost } from '@/lib/tool-identity'
import {
  summarizeTool,
  groupByTool,
  rankTools,
  describeRecord,
  MIN_RATED_JOBS,
  MIN_SOURCES,
  type GradedJob,
} from '@/lib/tool-record'

const T0 = Date.parse('2026-08-30T00:00:00Z')

function job(over: Partial<GradedJob> = {}): GradedJob {
  return {
    toolId: 'mcp:https://api.example.com/mcp#search',
    toolLabel: 'api.example.com/mcp · search',
    toolKind: 'mcp',
    passed: true,
    bountyUsd: 1,
    seconds: 300,
    gradedAt: T0,
    requesterAccountId: 'acct-1',
    ...over,
  }
}

describe('publishableServerUrl', () => {
  // This value gets PUBLISHED, and people paste credentials into URLs.
  it('drops a key in the query string', () => {
    expect(publishableServerUrl('https://api.example.com/mcp?api_key=SECRET')).toBe('https://api.example.com/mcp')
  })

  it('drops credentials in the userinfo', () => {
    const got = publishableServerUrl('https://user:hunter2@api.example.com/mcp')
    expect(got).toBe('https://api.example.com/mcp')
    expect(got).not.toContain('hunter2')
    expect(got).not.toContain('user')
  })

  it('drops the fragment', () => {
    expect(publishableServerUrl('https://api.example.com/mcp#tok')).toBe('https://api.example.com/mcp')
  })

  it('keeps host, port and path, and normalises the host', () => {
    expect(publishableServerUrl('https://API.Example.com:8443/a/b/')).toBe('https://api.example.com:8443/a/b')
  })

  it('refuses what it cannot take apart, rather than printing it raw', () => {
    // A string we could not parse is a string we must not publish.
    for (const bad of ['', '   ', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', null, 42]) {
      expect(publishableServerUrl(bad as unknown), String(bad)).toBe(null)
    }
  })
})

describe('toolIdentityOf', () => {
  it('names an external MCP worker by server and tool', () => {
    const id = toolIdentityOf({ runtimeType: 'mcp', mcpServerUrl: 'https://api.exa.ai/mcp?key=S', mcpToolName: 'web_search' })
    expect(id?.id).toBe('mcp:https://api.exa.ai/mcp#web_search')
    expect(id?.id).not.toContain('key=S')
    expect(id?.kind).toBe('mcp')
  })

  it('names a harness worker by its harness', () => {
    const id = toolIdentityOf({ runtimeType: 'local', harnessId: 'codex' })
    expect(id).toEqual({ id: 'harness:codex', kind: 'harness', label: 'codex' })
  })

  it('attributes nothing to the platform itself', () => {
    // Publishing our own model's record as "a tool's" record is marking our
    // own homework.
    expect(toolIdentityOf({ runtimeType: 'platform' })).toBe(null)
  })

  it("attributes nothing to a private local setup", () => {
    // Nobody else can go and use it, so it is not a tool anyone can choose.
    expect(toolIdentityOf({ runtimeType: 'local' })).toBe(null)
  })

  it('refuses an MCP worker whose server or tool it cannot vouch for', () => {
    expect(toolIdentityOf({ runtimeType: 'mcp', mcpServerUrl: 'nonsense', mcpToolName: 'x' })).toBe(null)
    expect(toolIdentityOf({ runtimeType: 'mcp', mcpServerUrl: 'https://a.com/x', mcpToolName: 'a b; rm -rf' })).toBe(null)
  })

  it('shortens a server for display without inventing anything', () => {
    expect(displayHost('https://api.exa.ai/mcp')).toBe('api.exa.ai/mcp')
    expect(displayHost('https://api.exa.ai')).toBe('api.exa.ai')
  })
})

describe('the honesty rules', () => {
  it('refuses to state a pass rate below the sample floor', () => {
    // A rate without its sample is a decoration. Absent, not rounded.
    const few = summarizeTool(Array.from({ length: MIN_RATED_JOBS - 1 }, () => job()))!
    expect(few.passRate).toBe(null)
    expect(few.jobs).toBe(MIN_RATED_JOBS - 1)
    expect(few.caveat).toMatch(/too few/)
    expect(describeRecord(few)).toContain('not rated')
  })

  it('counts distinct hiring accounts, and will not rank a single-source record', () => {
    // "78% over 41 jobs" where all 41 came from one customer is a fact about
    // that customer's setup, not evidence about the tool.
    const solo = summarizeTool(Array.from({ length: 20 }, () => job()))!
    expect(solo.accounts).toBe(1)
    expect(solo.ranked).toBe(false)
    expect(solo.caveat).toMatch(/one account/)
    // The rate is still computed — it is real, it is just not ranked.
    expect(solo.passRate).toBe(1)
  })

  it('ranks once there is enough evidence from enough sources', () => {
    const mixed = [
      ...Array.from({ length: 4 }, () => job({ requesterAccountId: 'acct-1' })),
      ...Array.from({ length: 4 }, () => job({ requesterAccountId: 'acct-2', passed: false })),
    ]
    const r = summarizeTool(mixed)!
    expect(r.accounts).toBe(MIN_SOURCES)
    expect(r.ranked).toBe(true)
    expect(r.passRate).toBe(0.5)
    expect(r.caveat).toBe(null)
  })

  it('carries nothing that identifies a customer or a job', () => {
    // Publishing about somebody else's product must never also publish about
    // somebody else's customer.
    const r = summarizeTool([job({ requesterAccountId: 'acct-secret' }), job({ requesterAccountId: 'acct-2' })])!
    expect(JSON.stringify(r)).not.toContain('acct-secret')
    expect(Object.keys(r)).not.toContain('jobsList')
    expect(Object.keys(r).some((k) => /account(Id|s)$/.test(k) && k !== 'accounts')).toBe(false)
  })
})

describe('summarizeTool', () => {
  it('takes medians, not means, so one huge job does not set the price', () => {
    const r = summarizeTool([job({ bountyUsd: 1 }), job({ bountyUsd: 2 }), job({ bountyUsd: 900 })])!
    expect(r.medianBountyUsd).toBe(2)
  })

  it('ignores jobs with no timing rather than counting them as instant', () => {
    const r = summarizeTool([job({ seconds: null }), job({ seconds: 100 }), job({ seconds: 300 })])!
    expect(r.medianSeconds).toBe(200)
  })

  it('reports the most recent verdict', () => {
    const r = summarizeTool([job({ gradedAt: T0 }), job({ gradedAt: T0 + 5000 })])!
    expect(r.lastGradedAt).toBe(T0 + 5000)
  })

  it('is null for a tool with no graded work', () => {
    expect(summarizeTool([])).toBe(null)
  })
})

describe('rankTools', () => {
  const many = (n: number, over: Partial<GradedJob>) =>
    Array.from({ length: n }, (_, i) => job({ requesterAccountId: `acct-${i % 3}`, ...over }))

  it('puts ranked rows first, best rate first', () => {
    const records = groupByTool([
      ...many(6, { toolId: 'a', toolLabel: 'a', passed: true }),
      ...many(6, { toolId: 'b', toolLabel: 'b', passed: false }),
    ])
    expect(rankTools(records).map((r) => r.toolId)).toEqual(['a', 'b'])
  })

  it('shows unranked rows rather than hiding them, but below the ranked ones', () => {
    // A tool with three graded jobs is not a tool with none, and burying it
    // would make the list look more settled than the evidence is.
    const records = groupByTool([
      ...many(6, { toolId: 'ranked', toolLabel: 'ranked', passed: false }),
      ...Array.from({ length: 2 }, () => job({ toolId: 'tiny', toolLabel: 'tiny' })),
    ])
    const order = rankTools(records)
    expect(order.map((r) => r.toolId)).toEqual(['ranked', 'tiny'])
    expect(order[1].ranked).toBe(false)
  })

  it('breaks a rate tie on the larger sample', () => {
    const records = groupByTool([
      ...many(6, { toolId: 'small', toolLabel: 'small' }),
      ...many(12, { toolId: 'big', toolLabel: 'big' }),
    ])
    expect(rankTools(records)[0].toolId).toBe('big')
  })
})

describe('groupByTool', () => {
  it('separates tools and keeps their own labels', () => {
    const records = groupByTool([job({ toolId: 'x', toolLabel: 'X' }), job({ toolId: 'y', toolLabel: 'Y' })])
    expect(records.map((r) => r.label).sort()).toEqual(['X', 'Y'])
  })
})

describe('a price that could not be read', () => {
  it('is absent, never zero', () => {
    // schema.ts refuses to cache a bounty because a cached price drifts from
    // the escrow. When the chain read fails there is no price — and a $0.00
    // median would be a claim about price that nothing supports.
    const r = summarizeTool([job({ bountyUsd: null }), job({ bountyUsd: null })])!
    expect(r.medianBountyUsd).toBe(null)
    expect(describeRecord(r)).not.toContain('$0.00')
  })

  it('still reports a median from the jobs it could price', () => {
    const r = summarizeTool([job({ bountyUsd: null }), job({ bountyUsd: 2 }), job({ bountyUsd: 4 })])!
    expect(r.medianBountyUsd).toBe(3)
  })
})

describe('the record is reachable', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('renders above the mirrored registry on /directory', () => {
    // /directory was a mirror of ClawHub's list ranked by ClawHub's stars —
    // somebody else's data and a popularity metric Handsel cannot vouch for,
    // while sitting on the only column no other registry can print.
    const page = read('app/directory/page.tsx')
    expect(page).toMatch(/toolRecords\(\)/)
    expect(page).toMatch(/describeRecord\(r\)/)
    expect(page.indexOf('Graded on Handsel')).toBeLessThan(page.indexOf('What agents can do'))
  })

  it('is answerable from inside Claude, where the buyer already is', () => {
    expect(read('lib/mcp/tools-manifest.ts')).toContain("name: 'tool_record'")
    expect(read('lib/mcp/handlers/jobs.ts')).toMatch(/case 'tool_record'/)
  })

  it('a local worker reports which harness it runs, or it cannot be attributed', () => {
    // Without this a harness worker's record is indistinguishable from any
    // other private local setup, and tool-identity correctly refuses to
    // publish it at all.
    expect(read('public/handsel-worker.mjs')).toMatch(/harness: HARNESS \? HARNESS\.id : null/)
    expect(read('app/api/worker/poll/route.ts')).toMatch(/recordHarness\(/)
  })

  it('stores only harness ids the platform knows', () => {
    // A worker is a program on somebody else's machine sending whatever it
    // likes, and this string reaches a public listing.
    expect(read('lib/agent-harness-server.ts')).toMatch(/const KNOWN = new Set\(/)
  })
})
