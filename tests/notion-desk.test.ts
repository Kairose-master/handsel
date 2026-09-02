import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  MAX_BRIEF_CHARS,
  MAX_POSTS_PER_DAY,
  MAX_POSTS_PER_TICK,
  MAX_RESULT_BLOCKS,
  MAX_ROW_BOUNTY_USD_DEFAULT,
  NOTION_TEXT_LIMIT,
  REQUIRED_PROPERTIES,
  STATUS,
  checkItem,
  inFlightFilter,
  missingProperties,
  parseDatabaseId,
  parsePage,
  presentOptional,
  readyFilter,
  renderDesk,
  resultBlocks,
  rowPatch,
  type NotionPage,
} from '@/lib/notion-desk'
import { TOOLS } from '@/lib/mcp/tools-manifest'

const rt = (s: string) => [{ plain_text: s }]
const page = (over: Partial<Record<string, unknown>> = {}): NotionPage => ({
  id: 'page-1',
  properties: {
    Name: { type: 'title', title: rt('Weekly ad copy') },
    Status: { type: 'status', status: { name: 'Ready' } },
    Brief: { type: 'rich_text', rich_text: rt('Write three ad variants for the Q3 launch.') },
    Criteria: { type: 'rich_text', rich_text: rt('Each under 30 words; names the product; one CTA each.') },
    Bounty: { type: 'number', number: 5 },
    Agent: { type: 'rich_text', rich_text: rt('Copy Desk') },
    Mode: { type: 'select', select: { name: 'Job' } },
    ...(over as Record<string, never>),
  },
})
const fullSchema = {
  Name: { type: 'title' },
  Status: { type: 'status' },
  Brief: { type: 'rich_text' },
  Criteria: { type: 'rich_text' },
  Bounty: { type: 'number' },
  Job: { type: 'number' },
  Result: { type: 'rich_text' },
  Proof: { type: 'url' },
  Note: { type: 'rich_text' },
  Session: { type: 'rich_text' },
}

describe('a row becomes a work item', () => {
  it('reads every column, case-insensitively', () => {
    const p = page({ bounty: { type: 'number', number: 7 } })
    delete p.properties.Bounty
    const item = parsePage(p)
    expect(item).toMatchObject({ name: 'Weekly ad copy', bountyUsd: 7, agentName: 'Copy Desk', mode: 'job', status: 'Ready' })
    expect(item.brief).toContain('three ad variants')
  })

  it('Mode = Session, with the next turn and the session id', () => {
    const item = parsePage(
      page({
        Mode: { type: 'select', select: { name: 'Session' } },
        Next: { type: 'rich_text', rich_text: rt('now the landing page headline') },
        Session: { type: 'rich_text', rich_text: rt('ses-abc') },
      }),
    )
    expect(item).toMatchObject({ mode: 'session', next: 'now the landing page headline', sessionId: 'ses-abc' })
  })

  it('missing columns read as empty, never throw', () => {
    const item = parsePage({ id: 'p', properties: {} })
    expect(item).toMatchObject({ name: '', brief: '', criteria: '', bountyUsd: 0, agentName: null, mode: 'job', status: null })
  })
})

describe('what the desk refuses to pay for', () => {
  const ok = parsePage(page())
  it('accepts a complete row', () => expect(checkItem(ok, MAX_ROW_BOUNTY_USD_DEFAULT)).toEqual({ ok: true }))
  it('no name, no brief, ungradeable criteria, no bounty, over the cap', () => {
    expect(checkItem({ ...ok, name: '' }, 50)).toMatchObject({ ok: false, reason: 'no-name' })
    expect(checkItem({ ...ok, brief: '  ' }, 50)).toMatchObject({ ok: false, reason: 'no-brief' })
    expect(checkItem({ ...ok, brief: 'x'.repeat(MAX_BRIEF_CHARS + 1) }, 50)).toMatchObject({ ok: false, reason: 'brief-too-long' })
    expect(checkItem({ ...ok, criteria: 'ok' }, 50)).toMatchObject({ ok: false, reason: 'criteria' })
    expect(checkItem({ ...ok, bountyUsd: 0 }, 50)).toMatchObject({ ok: false, reason: 'bounty' })
    expect(checkItem({ ...ok, bountyUsd: 51 }, 50)).toMatchObject({ ok: false, reason: 'bounty-cap' })
  })
  it('a session row with an open session is judged on Next, not Brief', () => {
    const s = { ...ok, mode: 'session' as const, sessionId: 'ses-1', next: null }
    expect(checkItem(s, 50)).toMatchObject({ ok: false, reason: 'no-brief' })
    expect(checkItem({ ...s, next: 'turn two' }, 50)).toEqual({ ok: true })
  })
})

describe('the database contract', () => {
  it('names what is missing, with the type', () => {
    expect(missingProperties(fullSchema)).toEqual([])
    expect(missingProperties({ Name: { type: 'title' }, Status: { type: 'checkbox' } })).toEqual([
      'Status (status or select)',
      'Brief (rich_text)',
      'Criteria (rich_text)',
      'Bounty (number)',
    ])
    expect(Object.keys(REQUIRED_PROPERTIES)).toHaveLength(5)
  })
  it('reports which write-back columns exist', () => {
    expect(presentOptional(fullSchema)).toEqual(['Job', 'Session', 'Result', 'Proof', 'Note'])
  })
  it('Status may be a status OR a select column — the API cannot create status options, so a tool-built database gets a select', () => {
    expect(missingProperties({ ...fullSchema, Status: { type: 'select' } })).toEqual([])
    expect(rowPatch({ status: STATUS.posted }, { Status: { type: 'select' } })).toEqual({ Status: { select: { name: 'Posted' } } })
    expect(readyFilter('Status', 'select')).toEqual({ property: 'Status', select: { equals: 'Ready' } })
  })
  it('filters on the Status column by the desk\'s own words', () => {
    expect(readyFilter('Status')).toEqual({ property: 'Status', status: { equals: 'Ready' } })
    expect(JSON.stringify(inFlightFilter('Status'))).toContain('"Posted"')
    expect(JSON.stringify(inFlightFilter('Status'))).toContain('"Working"')
  })
})

describe('writing back', () => {
  it('patches only columns the database has, under their own casing', () => {
    const p = rowPatch({ status: STATUS.delivered, jobNumber: 144, result: 'done', proofUrl: 'https://x/proof/1', note: null }, {
      Name: { type: 'title' },
      status: { type: 'status' },
      job: { type: 'number' },
    })
    expect(Object.keys(p)).toEqual(['status', 'job'])
    expect(p.status).toEqual({ status: { name: 'Delivered' } })
  })
  it('truncates a result to Notion\'s text limit in the property, and carries the rest as blocks', () => {
    const long = 'r'.repeat(NOTION_TEXT_LIMIT * 3 + 5)
    const p = rowPatch({ result: long }, fullSchema) as { Result: { rich_text: { text: { content: string } }[] } }
    expect(p.Result.rich_text[0].text.content).toHaveLength(NOTION_TEXT_LIMIT)
    const blocks = resultBlocks(long)
    expect(blocks).toHaveLength(1 + 4) // heading + 4 chunks
    const huge = 'h'.repeat(NOTION_TEXT_LIMIT * (MAX_RESULT_BLOCKS + 3))
    const b2 = resultBlocks(huge)
    expect(b2).toHaveLength(1 + MAX_RESULT_BLOCKS + 1)
    expect(JSON.stringify(b2[b2.length - 1])).toContain('more characters on the platform')
  })
})

describe('a database id from whatever was pasted', () => {
  it('URL, dashed id, bare id', () => {
    const id = '1f2e3d4c5b6a47890123456789abcdef'
    const dashed = '1f2e3d4c-5b6a-4789-0123-456789abcdef'
    expect(parseDatabaseId(`https://www.notion.so/acme/Desk-${id}?v=abc`)).toBe(dashed)
    expect(parseDatabaseId(dashed)).toBe(dashed)
    expect(parseDatabaseId(id)).toBe(dashed)
    expect(parseDatabaseId('not an id')).toBeNull()
  })
})

describe('what the desk says about itself', () => {
  it('token last-4 only, the caps, and the missing columns', () => {
    const r = renderDesk({
      databaseId: 'db',
      databaseTitle: 'Ops board',
      tokenLast4: 'k9Qz',
      requesterAgentName: 'Prime',
      enabled: true,
      maxBountyUsd: 50,
      postedToday: 3,
      lastTickAt: null,
      lastError: null,
      missing: ['Bounty (number)'],
      optional: ['Job'],
    })
    expect(r).toContain('····k9Qz')
    expect(r).not.toContain('secret_')
    expect(r).toContain(`${MAX_POSTS_PER_TICK} posts per tick · ${MAX_POSTS_PER_DAY} per day (3 today)`)
    expect(r).toContain('missing columns: Bounty (number)')
    expect(r).toContain('Only a passing deliverable releases the bounty')
  })
})

describe('the connector and the code agree', () => {
  const byName = new Map((TOOLS as { name: string; description: string }[]).map((t) => [t.name, t]))
  it('connect_notion_desk names the five required columns and says rows spend money', () => {
    const d = byName.get('connect_notion_desk')!.description
    for (const col of Object.keys(REQUIRED_PROPERTIES)) expect(d).toContain(col)
    expect(d).toMatch(/spends|escrow/i)
    expect(d).toContain(`$${MAX_ROW_BOUNTY_USD_DEFAULT}`)
  })
  it('the desk is a cron step, never a visitor-traffic one — it spends the owner\'s money', () => {
    const ops = readFileSync('lib/ops-cycle.ts', 'utf8')
    const i = ops.indexOf("name: 'notionDesks'")
    expect(i).toBeGreaterThan(-1)
    const step = ops.slice(i, ops.indexOf('},', i))
    expect(step).not.toContain('fast: true')
  })
  it('the token is stored encrypted and echoed last-4 only', () => {
    const server = readFileSync('lib/notion-desk-server.ts', 'utf8')
    expect(server).toContain('encryptSecret(')
    expect(server).toContain('decryptSecret(')
    expect(server).toMatch(/slice\(-4\)/)
  })
})
