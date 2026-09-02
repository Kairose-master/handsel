/**
 * The Notion desk — a Notion database as the control surface of a fleet
 * of agents that can all pay.
 *
 * The picture this is built from: a business owner's whole company drawn
 * as one map on one screen — marketing, sales, admin, operations, finance in
 * the middle; funnels, content, ads, SMS and email flows around it — with
 * the line "the most important part is having nothing live inside my head;
 * I want to review everything that happened last month and adjust." Every
 * box on that map is a role somebody has to fill. This makes each row of a
 * Notion database one of those boxes, worked by an agent that has a wallet.
 *
 * So Handsel is not pushed here as a place to shop for agents. It is the
 * rail under a fleet the owner already runs from Notion: a row marked Ready
 * becomes an escrowed job (or a session turn) posted by the owner's own
 * agent, worked by the owner's Claude Code worker or by the market, graded
 * independently, and paid only on pass — and the row is written back with
 * the result, the job number and the proof. The map stays in Notion; the
 * money and the verification are on the rail.
 *
 * This file is pure: the property schema the database must have, how a
 * page becomes a work item, what gets written back, and the bounds. The
 * reads and writes are in lib/notion-desk-server.ts; the HTTP is in
 * lib/notion-api.ts.
 *
 * Bounds are about the owner's wallet, not about Notion: a sheet can be
 * edited by anyone the owner shares it with, so a row is a request the
 * owner's agent PAYS for. Per-row bounty cap, per-tick and per-day posting
 * caps, and a row is posted at most once (its status moves off Ready before
 * money moves, same discipline as every spend here).
 */

export const NOTION_VERSION = '2022-06-28'

/** The columns a desk database must have, by name and type. Names are
 *  matched case-insensitively; the type must be exact. */
export const REQUIRED_PROPERTIES = {
  Name: 'title',
  Status: 'status',
  Brief: 'rich_text',
  Criteria: 'rich_text',
  Bounty: 'number',
} as const

/** Optional columns the desk uses when present. */
export const OPTIONAL_PROPERTIES = {
  Agent: 'rich_text', // which of the owner's agents is reserved for the row (by name); empty → the market
  Mode: 'select', // Job (default) | Session
  Next: 'rich_text', // a session row: the next turn's message
  Job: 'number', // written back: the on-chain job number
  Session: 'rich_text', // written back: the session id
  Result: 'rich_text', // written back: the delivered text (first 2000 chars; the rest as page blocks)
  Proof: 'url', // written back: the certificate page
  Note: 'rich_text', // written back: why a row was refused or failed
} as const

/** Status values the desk understands. `Ready` is the owner's verb; the
 *  other four are the desk's. Anything else is left alone. */
export const STATUS = {
  ready: 'Ready',
  posted: 'Posted',
  working: 'Working',
  delivered: 'Delivered',
  failed: 'Failed',
} as const
export type DeskStatus = (typeof STATUS)[keyof typeof STATUS]

export const MAX_ROW_BOUNTY_USD_DEFAULT = 50
export const MAX_POSTS_PER_TICK = 5
export const MAX_POSTS_PER_DAY = 25
export const MAX_BRIEF_CHARS = 20_000
export const MIN_CRITERIA_CHARS = 10
/** Notion rich_text is capped at 2000 characters per text object. */
export const NOTION_TEXT_LIMIT = 2000
/** How many paragraph blocks of the full result are appended to the page. */
export const MAX_RESULT_BLOCKS = 40

export type WorkItem = {
  pageId: string
  name: string
  brief: string
  criteria: string
  bountyUsd: number
  agentName: string | null
  mode: 'job' | 'session'
  next: string | null
  sessionId: string | null
  jobNumber: number | null
  status: string | null
}

export type RowRefusal = 'no-name' | 'no-brief' | 'brief-too-long' | 'criteria' | 'bounty' | 'bounty-cap'

export const ROW_REFUSAL_TEXT: Record<RowRefusal, string> = {
  'no-name': 'The row has no Name.',
  'no-brief': 'Brief is empty — the worker would have nothing to do.',
  'brief-too-long': `Brief is over ${MAX_BRIEF_CHARS} characters.`,
  criteria: `Criteria must be specific enough to grade (${MIN_CRITERIA_CHARS}+ characters). It is what the escrow releases against.`,
  bounty: 'Bounty must be a positive number of USD.',
  'bounty-cap': 'Bounty is over this desk\'s per-row cap. Raise the cap on the desk if you mean it.',
}

/* ── Reading Notion ───────────────────────────────────────────────────── */

type RichText = { plain_text?: string }[]
type NotionProperty =
  | { type: 'title'; title: RichText }
  | { type: 'rich_text'; rich_text: RichText }
  | { type: 'number'; number: number | null }
  | { type: 'status'; status: { name: string } | null }
  | { type: 'select'; select: { name: string } | null }
  | { type: 'url'; url: string | null }
  | { type: string }

export type NotionPage = { id: string; properties: Record<string, NotionProperty> }

const text = (rt: RichText | undefined) => (rt ?? []).map((t) => t.plain_text ?? '').join('').trim()

/** Case-insensitive property lookup, so "bounty" and "Bounty" both work. */
export function prop(page: NotionPage, name: string): NotionProperty | undefined {
  const key = Object.keys(page.properties).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? page.properties[key] : undefined
}

function str(page: NotionPage, name: string): string {
  const p = prop(page, name)
  if (!p) return ''
  if (p.type === 'title') return text((p as { title: RichText }).title)
  if (p.type === 'rich_text') return text((p as { rich_text: RichText }).rich_text)
  if (p.type === 'select') return (p as { select: { name: string } | null }).select?.name?.trim() ?? ''
  if (p.type === 'status') return (p as { status: { name: string } | null }).status?.name?.trim() ?? ''
  if (p.type === 'url') return (p as { url: string | null }).url ?? ''
  return ''
}
function num(page: NotionPage, name: string): number | null {
  const p = prop(page, name)
  if (!p || p.type !== 'number') return null
  const v = (p as { number: number | null }).number
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A page as a work item. Never refuses here — `checkItem` does, with a
 *  reason the desk writes back into the row's Note. */
export function parsePage(page: NotionPage): WorkItem {
  const mode = str(page, 'Mode').toLowerCase() === 'session' ? 'session' : 'job'
  return {
    pageId: page.id,
    name: str(page, 'Name'),
    brief: str(page, 'Brief'),
    criteria: str(page, 'Criteria'),
    bountyUsd: num(page, 'Bounty') ?? 0,
    agentName: str(page, 'Agent') || null,
    mode,
    next: str(page, 'Next') || null,
    sessionId: str(page, 'Session') || null,
    jobNumber: num(page, 'Job'),
    status: str(page, 'Status') || null,
  }
}

export function checkItem(item: WorkItem, maxBountyUsd: number): { ok: true } | { ok: false; reason: RowRefusal; message: string } {
  const refuse = (reason: RowRefusal) => ({ ok: false as const, reason, message: ROW_REFUSAL_TEXT[reason] })
  if (!item.name) return refuse('no-name')
  const body = item.mode === 'session' && item.sessionId ? (item.next ?? '') : item.brief
  if (!body.trim()) return refuse('no-brief')
  if (body.length > MAX_BRIEF_CHARS) return refuse('brief-too-long')
  if (item.criteria.trim().length < MIN_CRITERIA_CHARS) return refuse('criteria')
  if (!(item.bountyUsd > 0)) return refuse('bounty')
  if (item.bountyUsd > maxBountyUsd) return refuse('bounty-cap')
  return { ok: true }
}

/** Which required columns a database lacks, as "Name (type)" strings. */
export function missingProperties(schema: Record<string, { type: string }>): string[] {
  const have = new Map(Object.entries(schema).map(([k, v]) => [k.toLowerCase(), v.type]))
  return Object.entries(REQUIRED_PROPERTIES)
    .filter(([name, type]) => have.get(name.toLowerCase()) !== type)
    .map(([name, type]) => `${name} (${type})`)
}

/** Which optional columns are present — so status can say what the desk
 *  will and will not write back. */
export function presentOptional(schema: Record<string, { type: string }>): string[] {
  const have = new Map(Object.entries(schema).map(([k, v]) => [k.toLowerCase(), v.type]))
  return Object.entries(OPTIONAL_PROPERTIES)
    .filter(([name, type]) => have.get(name.toLowerCase()) === type)
    .map(([name]) => name)
}

/* ── Writing Notion ───────────────────────────────────────────────────── */

const rich = (s: string) => ({ rich_text: [{ type: 'text', text: { content: s.slice(0, NOTION_TEXT_LIMIT) } }] })

/**
 * The property patch for one row, built only from columns the database
 * actually has — Notion rejects a patch that names an unknown property, and
 * one bad column would then stall every write-back.
 */
export function rowPatch(
  input: {
    status?: DeskStatus
    jobNumber?: number | null
    sessionId?: string | null
    result?: string | null
    proofUrl?: string | null
    note?: string | null
  },
  schema: Record<string, { type: string }>,
): Record<string, unknown> {
  const has = (name: string, type: string) => Object.entries(schema).some(([k, v]) => k.toLowerCase() === name.toLowerCase() && v.type === type)
  const key = (name: string) => Object.keys(schema).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name
  const patch: Record<string, unknown> = {}
  if (input.status && has('Status', 'status')) patch[key('Status')] = { status: { name: input.status } }
  if (input.jobNumber !== undefined && has('Job', 'number')) patch[key('Job')] = { number: input.jobNumber }
  if (input.sessionId !== undefined && has('Session', 'rich_text')) patch[key('Session')] = rich(input.sessionId ?? '')
  if (input.result !== undefined && has('Result', 'rich_text')) patch[key('Result')] = rich(input.result ?? '')
  if (input.proofUrl !== undefined && has('Proof', 'url')) patch[key('Proof')] = { url: input.proofUrl }
  if (input.note !== undefined && has('Note', 'rich_text')) patch[key('Note')] = rich(input.note ?? '')
  return patch
}

/** The full delivered text as paragraph blocks under the page — Notion's
 *  2000-char text limit per block, and a block cap so a huge deliverable
 *  does not turn one page write into forty. */
export function resultBlocks(result: string, heading = 'Delivered'): unknown[] {
  const chunks: string[] = []
  for (let i = 0; i < result.length && chunks.length < MAX_RESULT_BLOCKS; i += NOTION_TEXT_LIMIT) {
    chunks.push(result.slice(i, i + NOTION_TEXT_LIMIT))
  }
  const cut = result.length > MAX_RESULT_BLOCKS * NOTION_TEXT_LIMIT
  return [
    { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: heading } }] } },
    ...chunks.map((c) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: c } }] } })),
    ...(cut ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `(cut — ${result.length - MAX_RESULT_BLOCKS * NOTION_TEXT_LIMIT} more characters on the platform)` } }] } }] : []),
  ]
}

/** The Notion filter for rows the desk acts on. */
export const readyFilter = (statusProperty: string) => ({ property: statusProperty, status: { equals: STATUS.ready } })
export const inFlightFilter = (statusProperty: string) => ({
  or: [
    { property: statusProperty, status: { equals: STATUS.posted } },
    { property: statusProperty, status: { equals: STATUS.working } },
  ],
})

/** A Notion database id from a pasted URL or a bare id. */
export function parseDatabaseId(input: string): string | null {
  const s = input.trim()
  const m = s.replace(/-/g, '').match(/([0-9a-f]{32})(?![0-9a-f])/i)
  if (!m) return null
  const raw = m[1].toLowerCase()
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** What the desk says about itself. */
export function renderDesk(input: {
  databaseId: string
  databaseTitle: string | null
  tokenLast4: string
  requesterAgentName: string
  enabled: boolean
  maxBountyUsd: number
  postedToday: number
  lastTickAt: string | null
  lastError: string | null
  missing: string[]
  optional: string[]
}): string {
  return [
    `🗂 Notion desk — ${input.databaseTitle ?? input.databaseId}`,
    `token: ····${input.tokenLast4} · pays from: ${input.requesterAgentName} · ${input.enabled ? 'enabled' : 'paused'}`,
    `caps: $${input.maxBountyUsd} per row · ${MAX_POSTS_PER_TICK} posts per tick · ${MAX_POSTS_PER_DAY} per day (${input.postedToday} today)`,
    input.missing.length ? `⚠ missing columns: ${input.missing.join(', ')} — the desk will not post until these exist` : 'columns: all required present',
    `writes back: ${input.optional.length ? input.optional.join(', ') : 'Status only (add Job / Result / Proof / Note columns to see more)'}`,
    `last tick: ${input.lastTickAt ?? 'never'}${input.lastError ? ` · last error: ${input.lastError}` : ''}`,
    '',
    'A row is worked when its Status is Ready: Brief + Criteria + Bounty become an escrowed job posted by your agent',
    '(Agent names one of your agents to reserve it for, e.g. your Claude Code worker; Mode = Session opens a session',
    'and posts Brief as turn 1, later turns from Next). Status moves Ready → Posted → Working → Delivered / Failed;',
    'Result, Job and Proof are written back. Only a passing deliverable releases the bounty.',
  ].join('\n')
}
