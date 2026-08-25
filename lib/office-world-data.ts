/**
 * Office World — types and pure helpers shared by the SERVER-only query
 * (lib/office-world-server.ts, DB-backed) and the CLIENT-side game engine
 * (app/(dashboard)/office/game/, imported from a 'use client' page).
 *
 * Nothing in this file touches the database — that split is load-bearing,
 * not stylistic. `lib/db` pulls in `pg`, which needs Node's `net`/`tls`/
 * `util` and cannot be bundled for the browser; this file exists so the
 * client-side engine can import `OFFICE_DEPARTMENTS`/`colorsFor`/the
 * `OfficeSnapshot` type without dragging `pg` into the browser bundle.
 * See office-world-server.ts's header for the production build this broke
 * before the split.
 *
 * The reference toy this borrowed its room/pathfinding/canvas engine from
 * (a "AI Office" pixel simulation) runs a fully SCRIPTED single-day
 * scenario: fixed phases, a generator per employee, canned dialogue. Every
 * name and "task" in it comes from a static config file — none of it is
 * live. Dropping real Handsel agent names into that script would have
 * produced the worst version of fake data this project has ever shipped:
 * a real identity narrating an invented activity ("checking sources
 * today") it never did.
 *
 * The alternative: the ENGINE (world layout, A* pathfinding, rendering —
 * app/(dashboard)/office/game/) was kept, and the BRAIN (the scripted
 * generator) was replaced with a real snapshot of what an account's agents
 * are actually doing right now (office-world-server.ts), refreshed on a
 * poll instead of a scripted clock. One department per agent, assigned by
 * the first matching rule — most urgent/active state wins; static
 * attributes are the fallback so an otherwise-quiet agent still lands
 * somewhere real. An agent that matches nothing sits in the lounge.
 */

export type OfficeDeptId =
  | 'disputed'
  | 'reviewing'
  | 'working'
  | 'delegating'
  | 'credit'
  | 'settled'
  | 'governance'
  | 'mining'
  | 'external'
  | 'template'
  | 'erc8004'
  | 'capable'

export const OFFICE_DEPARTMENTS: Array<{ id: OfficeDeptId; name: string; short: string; icon: string; blurb: string }> = [
  { id: 'disputed', name: 'Disputes', short: 'dispute.desk', icon: '⚖️', blurb: 'A job on this agent is in dispute right now.' },
  { id: 'reviewing', name: 'Review line', short: 'review.line', icon: '🖋️', blurb: 'Working an office-scoped peer review.' },
  { id: 'working', name: 'Working', short: 'job.desk', icon: '💼', blurb: 'Accepted or Submitted on a real escrowed job.' },
  { id: 'delegating', name: 'Delegating', short: 'delegate.hq', icon: '📤', blurb: 'Prime on an active delegation, coordinating subtasks.' },
  { id: 'credit', name: 'Credit', short: 'credit.line', icon: '📊', blurb: 'Has an open credit draw against its score.' },
  { id: 'settled', name: 'Settled today', short: 'payout.log', icon: '💰', blurb: 'Completed and got paid in the last 24h.' },
  { id: 'governance', name: 'Governance', short: 'gov.hall', icon: '🗳️', blurb: 'Votes on proposals on the owner\'s behalf.' },
  { id: 'mining', name: 'Mining', short: 'mining.rig', icon: '⛏️', blurb: 'Auto-claims qualifying open jobs.' },
  { id: 'external', name: 'External', short: 'mcp.bridge', icon: '🔌', blurb: 'Runs outside the platform — webhook, cloud key, or MCP.' },
  { id: 'template', name: 'Cloned', short: 'template.hq', icon: '🧬', blurb: 'Built from a purchased or cloned agent template.' },
  { id: 'erc8004', name: 'Registered', short: 'erc8004.id', icon: '🪪', blurb: 'Has an ERC-8004 identity registry entry.' },
  { id: 'capable', name: 'Specialist', short: 'capable.lab', icon: '🎨', blurb: 'Declares a capability beyond plain text.' },
]

export type OfficeStaffMember = {
  id: string
  name: string
  role: string
  deptId: OfficeDeptId | null // null = lounge (idle — nothing else matched)
  rank: 'lead' | 'member'
  statusLine: string
}

export type OfficeSnapshot = {
  ceoName: string
  ceoLine: string
  staff: OfficeStaffMember[]
}

const COLOR_PALETTE: Array<[string, string, string]> = [
  ['#6b3d34', '#fff3b0', '#ff8fc0'],
  ['#372b4a', '#c9b8ff', '#c9b8ff'],
  ['#c26e4b', '#ff8fc0', '#fff3b0'],
  ['#2d4b46', '#b8f0dd', '#b8f0dd'],
  ['#8b534a', '#fff3b0', '#ff8fc0'],
  ['#2c2638', '#ff8fc0', '#ff8fc0'],
  ['#d88d68', '#c9b8ff', '#c9b8ff'],
  ['#563a32', '#b8f0dd', '#b8f0dd'],
  ['#313b56', '#fff3b0', '#fff3b0'],
  ['#9c5c72', '#ff8fc0', '#ff8fc0'],
  ['#3b3b49', '#b8f0dd', '#b8f0dd'],
  ['#7a453c', '#c9b8ff', '#c9b8ff'],
]

export function colorsFor(index: number): [string, string, string] {
  return COLOR_PALETTE[index % COLOR_PALETTE.length]
}

/**
 * Agent hire templates — a name/persona/color starting point, not a claim
 * about what the agent has already done. Picking one only pre-fills the
 * hire form (name + description); it configures nothing about how the agent
 * actually runs. Real capability still comes from runtimeType, MCP wiring,
 * or whatever the agent's own implementation does once hired — the same
 * "no fake data" line every other office/job page holds: a template is a
 * naming convenience, never a pretend track record.
 */
export type AgentTemplate = {
  id: string
  name: string
  blurb: string
  colorIndex: number
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  { id: 'miner', name: 'Miner', blurb: 'Watches the board, claims qualifying jobs automatically.', colorIndex: 0 },
  { id: 'scout', name: 'Scout', blurb: 'Reads news and outside sources, reports back.', colorIndex: 1 },
  { id: 'reviewer', name: 'Reviewer', blurb: 'An independent second opinion on delivered work.', colorIndex: 2 },
  { id: 'architect', name: 'Architect', blurb: 'Breaks one big goal into a delegation plan.', colorIndex: 3 },
  { id: 'analyst', name: 'Analyst', blurb: 'Reads data and charts for patterns.', colorIndex: 4 },
  { id: 'scribe', name: 'Scribe', blurb: 'Writes docs, reports, structured text.', colorIndex: 5 },
  { id: 'courier', name: 'Courier', blurb: 'Runs repo jobs — diff in, PR out.', colorIndex: 6 },
  { id: 'sentinel', name: 'Sentinel', blurb: 'Watches deadlines and disputes.', colorIndex: 7 },
  { id: 'broker', name: 'Broker', blurb: 'Manages credit draws and repayments.', colorIndex: 8 },
  { id: 'delegate', name: 'Delegate', blurb: "Votes on governance on the owner's behalf.", colorIndex: 9 },
]

/**
 * Office templates — a hire-and-wire BUNDLE: several role agents, hired
 * together, plus a matching delegation pipeline between them. Two things
 * this deliberately does NOT do:
 *
 * 1. Auto-escrow real money. The pipeline is built as a 'planned' delegation
 *    (see app/actions/office.ts's hireOfficeTemplate) — same as any
 *    hand-authored plan on /delegate, the owner still reviews the exact
 *    subtask briefs and bounties and picks a funded prime agent before a
 *    single cent moves.
 * 2. Claim to auto-execute real trades. A "rebalance" step's deliverable is
 *    a proposed order list for a human to review — never an order placed.
 *    Nothing in this file or its wiring calls a live order-entry tool.
 *
 * `mcpHint` names real API *categories* from the referenced provider's docs
 * (verified before writing this file), never a specific tool identifier —
 * this project doesn't fabricate config values it hasn't confirmed exist.
 * Wiring a role to a real MCP server, if the owner chooses to, is manual:
 * they supply their own serverUrl/toolName/authHeader, same as any other
 * external MCP hire.
 */
export type OfficeTemplateRole = {
  id: string
  name: string
  blurb: string
  colorIndex: number
  customInstructions: string
  mcpHint: string
}

export type OfficeTemplateStep = {
  roleId: string
  title: string
  brief: string
  acceptanceCriteria: string
  dependsOnRoleIds: string[]
}

export type OfficeTemplate = {
  id: string
  name: string
  blurb: string
  symbolsLabel: string
  roles: OfficeTemplateRole[]
  pipeline: OfficeTemplateStep[]
}

export const OFFICE_TEMPLATES: OfficeTemplate[] = [
  {
    id: 'securities-desk',
    name: 'Securities Office',
    blurb: 'Chart + news analysts feed a quant model, which drafts a rebalance proposal — never an executed trade.',
    symbolsLabel: 'Tickers in scope (e.g. 005930.KS, AAPL, TSLA)',
    roles: [
      {
        id: 'chart-analyst',
        name: 'Chart Analyst',
        blurb: 'Reads price/volume data for trend, support/resistance, momentum.',
        colorIndex: 4,
        customInstructions:
          'You are a chart/technical analyst on a small securities desk. Given a list of tickers, pull recent ' +
          'price and volume history — via your connected market-data tool if one is wired — and summarize the ' +
          'technical picture for each: trend direction, key support/resistance levels, and a momentum read. Cite ' +
          'the actual prices and dates you looked up. If no live data tool is connected, say so plainly instead of ' +
          'guessing a number.',
        mcpHint: 'KIS Trading MCP (koreainvestment/open-trading-api → MCP/Kis Trading MCP): a 시세조회 (market data) capable tool.',
      },
      {
        id: 'news-analyst',
        name: 'News Analyst',
        blurb: 'Reads news and filings, flags what actually moves the names in scope.',
        colorIndex: 1,
        customInstructions:
          'You are a news/filings analyst on a small securities desk. Given a list of tickers, review recent news, ' +
          'disclosures, and filings and summarize what is actually relevant — earnings surprises, guidance changes, ' +
          'ownership/management moves, regulatory items. Cite what you found (headline, date, source) rather than ' +
          'paraphrasing from memory. If no live news/filings tool is connected, say so plainly instead of guessing.',
        mcpHint: 'A news/filings-capable MCP tool — the KIS server does not expose one; any general news MCP works here.',
      },
      {
        id: 'quant-modeler',
        name: 'Quant Modeler',
        blurb: 'Synthesizes the chart + news reads into a suggested weight per ticker.',
        colorIndex: 3,
        customInstructions:
          "You are a quant/portfolio modeler. You'll receive a chart analysis and a news analysis for the same " +
          'tickers. Synthesize both into a suggested weight or directional tilt per ticker, and explain the ' +
          'reasoning — which analysis drove which call, and where they agreed or conflicted. This is a model ' +
          'output for review, not an order.',
        mcpHint: 'None needed — this role synthesizes the two upstream deliverables, not live data of its own.',
      },
      {
        id: 'rebalance-planner',
        name: 'Rebalance Planner',
        blurb: 'Turns the model weights into a draft order list — proposal only, never auto-executed.',
        colorIndex: 6,
        customInstructions:
          "You are a rebalance planner. Given the quant model's target weights and (if available) current " +
          'holdings, produce a concrete proposed order list: ticker, buy/sell, and quantity or notional to move ' +
          'from current toward target. This is a DRAFT for a human to review and place manually — you have no ' +
          'authority to submit real orders and nothing about this task asks you to. State plainly that it is a ' +
          'draft, not an executed trade.',
        mcpHint: 'If wiring an account/balance tool here, use a READ-ONLY one (계좌잔고 조회) — never an order-placement tool.',
      },
    ],
    pipeline: [
      {
        roleId: 'chart-analyst',
        title: 'Chart analysis — {symbols}',
        brief:
          'Pull recent price/volume history for {symbols} and summarize, per ticker: trend direction, at least ' +
          'one support and one resistance level, and a momentum call. Ground every claim in the actual data you ' +
          'retrieved (specific prices and dates) — never a number from general knowledge.',
        acceptanceCriteria:
          'Every ticker in {symbols} gets a trend read, a support level, a resistance level, and a momentum call, ' +
          'each citing a specific price and date.',
        dependsOnRoleIds: [],
      },
      {
        roleId: 'news-analyst',
        title: 'News & filings analysis — {symbols}',
        brief:
          'Review recent news, disclosures, and filings for {symbols} and summarize what is actually relevant to ' +
          'the price — earnings, guidance, ownership/management moves, regulatory items. Cite headline, date, and ' +
          'source for each item.',
        acceptanceCriteria:
          'Every ticker in {symbols} gets at least one cited news/filing item (headline, date, source), or an ' +
          'explicit "nothing material found" if a genuine search turned up nothing.',
        dependsOnRoleIds: [],
      },
      {
        roleId: 'quant-modeler',
        title: 'Quant model — weight synthesis for {symbols}',
        brief:
          'Read the chart analysis and news analysis deliverables for {symbols} and synthesize a suggested ' +
          'weight or directional tilt per ticker, explaining which upstream analysis drove which call.',
        acceptanceCriteria:
          'Every ticker in {symbols} gets an explicit weight/tilt call that cites which upstream analysis (chart, ' +
          'news, or both) it is based on.',
        dependsOnRoleIds: ['chart-analyst', 'news-analyst'],
      },
      {
        roleId: 'rebalance-planner',
        title: 'Rebalance proposal (draft — not executed) — {symbols}',
        brief:
          "Read the quant model's weights for {symbols} and produce a concrete proposed order list (ticker, " +
          'buy/sell, quantity or notional) to move toward those targets. State explicitly that this is a draft ' +
          'for human review, not an executed trade.',
        acceptanceCriteria:
          'Every ticker with a nonzero weight change gets a concrete buy/sell line, and the deliverable states ' +
          'explicitly that it is a draft, not an executed order.',
        dependsOnRoleIds: ['quant-modeler'],
      },
    ],
  },
]
