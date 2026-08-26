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

/** One office slot. Declared here, in the client-safe module, rather than in
 *  lib/office.ts: app/actions/office.ts is a 'use server' file, and
 *  re-exporting an imported type out of one ("export type { OfficeSlot }")
 *  did not survive Next's server-action transform — it left a runtime
 *  reference and every action in that module threw "OfficeSlot is not
 *  defined". Same reason MAX_OFFICE_SLOTS lives here. */
export type OfficeSlot = { slot: number; name: string }

/**
 * One MCP source an office can reach. Several per office: the agent table has
 * always stored mcpServerUrl per agent, so a research role on web search, a
 * scribe on a private vault and an analyst on market data can coexist in one
 * pipeline — only the hire form used to force them all through one URL.
 *
 * Declared here rather than in app/actions/office.ts for the reason at the
 * top of this file: the hire dialog is a client component, and types it
 * imports should not have to come out of a 'use server' module.
 */
export type McpConnector = {
  id: string
  /** Owner-facing name. Shown in the UI only, never sent anywhere. */
  label: string
  serverUrl: string
  authHeader?: string
}

export type McpBinding = { connectorId: string; toolName: string }

/**
 * Which server+tool a role should be wired to, or null for "leave it a plain
 * platform agent".
 *
 * Pure so the refusals are testable, and they are the point: a binding whose
 * connector was deleted, or one with no tool name, resolves to null rather
 * than falling back to another role's server. Wiring an agent to the wrong
 * source silently is worse than not wiring it at all — it would deliver
 * confident work off the wrong data.
 */
export function resolveRoleConnector(
  connectors: McpConnector[],
  bindings: Record<string, McpBinding> | undefined,
  roleId: string,
): { serverUrl: string; toolName: string; authHeader?: string } | null {
  const binding = bindings?.[roleId]
  if (!binding) return null
  const toolName = binding.toolName?.trim()
  if (!toolName) return null
  const connector = connectors.find((c) => c.id === binding.connectorId)
  const serverUrl = connector?.serverUrl.trim()
  if (!connector || !serverUrl) return null
  return { serverUrl, toolName, authHeader: connector.authHeader?.trim() || undefined }
}


/** Offices per account (lib/office.ts). Defined here, not there, because that
 *  file imports @/lib/db (pg) and this one must stay importable from client
 *  components. lib/office.ts imports it back. */
export const MAX_OFFICE_SLOTS = 3

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
  /** Multi-party settlement split (lib/settlement-split.ts), keyed by the
   *  OTHER roles that get a cut when this step's job settles — resolved to
   *  their real hired agentId at hire time (app/actions/office.ts). This is
   *  what makes an office template a genuine agent-to-agent economy rather
   *  than one owner funding a roster: the money that moves is the worker's
   *  OWN just-settled bounty, split out on-chain to office-mates, not a
   *  separate payment from the prime's escrow. bps values must sum ≤ 10000. */
  splitBpsByRoleId?: Record<string, number>
  /** Relative share of the total budget this step's bounty gets — defaults
   *  to 1 (equal split, the original behavior). A step worth 2 gets twice
   *  the bounty of a step worth 1, budget split proportionally by weight
   *  across the whole pipeline (app/actions/office.ts). */
  bountyWeight?: number
}

export type OfficeTemplate = {
  id: string
  name: string
  blurb: string
  scopeLabel: string
  /** One plain-language line naming the pipeline shape and (when there is
   *  one) who gets paid what — the thing a person actually wants to know
   *  before hiring, distilled to one sentence for the template card. */
  flowSummary: string
  /** A ready-to-use scope string — what "Quick hire" submits untouched, so
   *  trying a template takes one click instead of first inventing a task. */
  exampleScope: string
  /** Whether hiring this template fetches a live market-data snapshot
   *  (lib/market-data.ts) into the chart-analyst/news-analyst roles' briefs
   *  — securities-desk only; irrelevant data for a non-trading template. */
  usesMarketData?: boolean
  roles: OfficeTemplateRole[]
  pipeline: OfficeTemplateStep[]
}

/**
 * The per-subtask bounty floor, mirrored from MIN_SUBTASK_BOUNTY_USD in
 * lib/delegation.ts. It can't be imported here: this module is reachable from
 * 'use client' components, and lib/delegation pulls in the Anthropic SDK and
 * the whole on-chain layer. tests/office-step-bounty.test.ts asserts the two
 * still agree, so the copy can't silently drift.
 */
export const OFFICE_MIN_STEP_BOUNTY_USD = 1

/**
 * How a template's total budget divides across its pipeline steps, keyed by
 * roleId. Pure, and the single definition of that arithmetic: the hire action
 * escrows exactly these amounts and the hire dialog shows exactly these
 * amounts, so what a person reads before choosing who pays for which step is
 * what that agent's wallet is actually asked for.
 *
 * Weight defaults to 1 (equal split). A step whose weighted share falls under
 * the floor is raised to it — which means a heavily lopsided plan can total
 * slightly more than the budget, exactly as postDelegationJobs' own budget
 * check already tolerates.
 */
export function officeStepBounties(template: OfficeTemplate, budgetUsd: number): Map<string, number> {
  const totalWeight = template.pipeline.reduce((s, step) => s + (step.bountyWeight ?? 1), 0)
  const unitUsd = totalWeight > 0 ? budgetUsd / totalWeight : 0
  return new Map(
    template.pipeline.map((step) => [
      step.roleId,
      Math.max(OFFICE_MIN_STEP_BOUNTY_USD, Math.round(unitUsd * (step.bountyWeight ?? 1) * 100) / 100),
    ]),
  )
}

export const OFFICE_TEMPLATES: OfficeTemplate[] = [
  {
    id: 'securities-desk',
    name: 'Securities Office',
    blurb: 'Chart + news analysts feed a quant model, which drafts a rebalance proposal — never an executed trade.',
    flowSummary: 'Chart Analyst + News Analyst → Quant Modeler → Rebalance Planner (draft only, never an order).',
    exampleScope: '005930.KS, AAPL',
    scopeLabel: 'Tickers in scope (e.g. 005930.KS, AAPL, TSLA)',
    usesMarketData: true,
    roles: [
      {
        id: 'chart-analyst',
        name: 'Chart Analyst',
        blurb: 'Reads price/volume data for trend, support/resistance, momentum.',
        colorIndex: 4,
        customInstructions:
          'You are a chart/technical analyst on a small securities desk. Your brief includes a real live-quote ' +
          'snapshot fetched at hire time (or, if you have a connected market-data tool, use that for anything ' +
          'more current) — use it to summarize the technical picture for each ticker: trend direction, key ' +
          'support/resistance levels, and a momentum read. Cite the actual prices and dates given to you. Never ' +
          'invent a number that is not in the snapshot or your tool output.',
        mcpHint: 'securities-mcp/ in this repo, tool "kis_price_lookup" — a real paper-trading KIS price feed, purpose-built for this role.',
      },
      {
        id: 'news-analyst',
        name: 'News Analyst',
        blurb: 'Reads news and filings, flags what actually moves the names in scope.',
        colorIndex: 1,
        customInstructions:
          'You are a news/filings analyst on a small securities desk. Your brief includes real recent headlines ' +
          'fetched at hire time (or, if you have a connected news/filings tool, use that for anything more ' +
          'current) — summarize what is actually relevant: earnings surprises, guidance changes, ownership/' +
          'management moves, regulatory items. Cite what you were given (headline, date, source) rather than ' +
          'paraphrasing from memory. If a ticker has no headlines in your brief and no tool of your own, say so ' +
          'plainly instead of guessing.',
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
        mcpHint: 'securities-mcp/ in this repo, tool "kis_account_balance" — read-only paper holdings; no order-placement function exists in that server.',
      },
    ],
    pipeline: [
      {
        roleId: 'chart-analyst',
        title: 'Chart analysis — {scope}',
        brief:
          'Pull recent price/volume history for {scope} and summarize, per ticker: trend direction, at least ' +
          'one support and one resistance level, and a momentum call. Ground every claim in the actual data you ' +
          'retrieved (specific prices and dates) — never a number from general knowledge.',
        acceptanceCriteria:
          'Every ticker in {scope} gets a trend read, a support level, a resistance level, and a momentum call, ' +
          'each citing a specific price and date.',
        dependsOnRoleIds: [],
      },
      {
        roleId: 'news-analyst',
        title: 'News & filings analysis — {scope}',
        brief:
          'Review recent news, disclosures, and filings for {scope} and summarize what is actually relevant to ' +
          'the price — earnings, guidance, ownership/management moves, regulatory items. Cite headline, date, and ' +
          'source for each item.',
        acceptanceCriteria:
          'Every ticker in {scope} gets at least one cited news/filing item (headline, date, source), or an ' +
          'explicit "nothing material found" if a genuine search turned up nothing.',
        dependsOnRoleIds: [],
      },
      {
        roleId: 'quant-modeler',
        title: 'Quant model — weight synthesis for {scope}',
        brief:
          'Read the chart analysis and news analysis deliverables for {scope} and synthesize a suggested ' +
          'weight or directional tilt per ticker, explaining which upstream analysis drove which call.',
        acceptanceCriteria:
          'Every ticker in {scope} gets an explicit weight/tilt call that cites which upstream analysis (chart, ' +
          'news, or both) it is based on.',
        dependsOnRoleIds: ['chart-analyst', 'news-analyst'],
      },
      {
        roleId: 'rebalance-planner',
        title: 'Rebalance proposal (draft — not executed) — {scope}',
        brief:
          "Read the quant model's weights for {scope} and produce a concrete proposed order list (ticker, " +
          'buy/sell, quantity or notional) to move toward those targets. State explicitly that this is a draft ' +
          'for human review, not an executed trade.',
        acceptanceCriteria:
          'Every ticker with a nonzero weight change gets a concrete buy/sell line, and the deliverable states ' +
          'explicitly that it is a draft, not an executed order.',
        dependsOnRoleIds: ['quant-modeler'],
      },
    ],
  },
  {
    id: 'talent-agency',
    name: 'Talent Agency',
    blurb:
      'Every real job the Talent completes automatically pays the Agency Head and Scout a cut — real on-chain ' +
      'revenue share between three independently hired agents, not one owner funding a roster.',
    flowSummary: 'Talent does the work → Agency Head keeps 20% and Scout keeps 5%, automatically, out of the Talent\'s own payout.',
    exampleScope: 'Write a punchy 5-slide pitch deck outline for a coffee-subscription startup, one line per slide.',
    scopeLabel: 'What should the Talent deliver? (a task description, same as /delegate)',
    roles: [
      {
        id: 'agency-head',
        name: 'Agency Head',
        blurb: 'Posts and funds the job; takes an automatic cut of every payout.',
        colorIndex: 8,
        customInstructions:
          'You run this agency. You post and fund real work for your Talent, and you are paid automatically out ' +
          "of the Talent's settled earnings the moment a job completes — no separate invoice, no manual transfer. " +
          'You do not do the delivery work yourself.',
        mcpHint: 'Not applicable — this role never claims jobs itself.',
      },
      {
        id: 'scout',
        name: 'Talent Scout',
        blurb: 'Sourced this job; takes an automatic smaller cut when it settles.',
        colorIndex: 5,
        customInstructions:
          'You sourced this work for the agency. Like the Agency Head, you are paid automatically out of the ' +
          "Talent's settled earnings when the job completes — a real, independent cut of another agent's own " +
          'payout, not a fee taken before they are paid. You do not do the delivery work yourself.',
        mcpHint: 'Not applicable — this role never claims jobs itself.',
      },
      {
        id: 'talent',
        name: 'Talent',
        blurb: 'Does the actual work — keeps what is left after the agency and scout cuts.',
        colorIndex: 2,
        customInstructions:
          'You are the Talent at a small agency. Deliver exactly what the brief below asks for, complete and ' +
          'ready to use — no partial or placeholder output. The moment this job settles, a share of YOUR payout ' +
          'automatically goes to your Agency Head and Scout, on-chain, out of your own wallet — that is the deal ' +
          'that gets you real work in the first place.',
        mcpHint: 'Optional — connect this role to whatever tool the brief actually needs.',
      },
    ],
    pipeline: [
      {
        roleId: 'talent',
        title: 'Agency delivery',
        brief: '{scope}',
        acceptanceCriteria: 'Delivers exactly what the brief above asks for, complete and ready to use — no partial or placeholder output.',
        dependsOnRoleIds: [],
        splitBpsByRoleId: { 'agency-head': 2000, scout: 500 },
      },
    ],
  },
  {
    id: 'bootstrap-desk',
    name: 'Bootstrap Desk',
    blurb:
      'A rookie agent earns its first real dollar and its first real credit tick — then a pricier second job shows ' +
      'what that earned standing is actually worth. No seeded history: every number here is earned live, on this ' +
      'delegation, while you watch.',
    flowSummary: 'Job 1 (needs nothing upfront) → Job 2 (pricier — an Underwriter checks if the earned standing is real).',
    exampleScope: 'A 300-word explainer of what a credit score actually measures, written for someone with no finance background.',
    scopeLabel: 'What should the Bootstrapper deliver? (a small, self-contained task, e.g. "a 300-word explainer of X")',
    roles: [
      {
        id: 'bootstrapper',
        name: 'Bootstrapper',
        blurb: 'Starts at a real, literal zero — no seeded score, no starter balance, same cold start as every new agent.',
        colorIndex: 0,
        customInstructions:
          'You are a brand-new agent with no track record and no property yet — real $0 score, real $0 credit ' +
          "line, same as any fresh agent on this platform. Deliver exactly what the first job's brief asks for. " +
          "This first job needs nothing from you upfront — that's deliberate: it's the one kind of job a " +
          'propertyless agent can always do. What you earn from it is the first real entry in your own track record.',
        mcpHint: 'Not applicable — this role does self-contained delivery work, no external data needed.',
      },
      {
        id: 'underwriter',
        name: 'Underwriter',
        blurb: "Reviews the Bootstrapper's real, settled track record and states plainly what it is worth so far.",
        colorIndex: 9,
        customInstructions:
          "You are an underwriter reviewing one agent's track record. You will be given that agent's first " +
          'delivered piece of real work below. You have no tool access to the live credit-scoring system yourself — ' +
          'say so plainly, and tell the human reviewing this delegation to check the real number on /credit-scores ' +
          "before acting on anything here. Do not invent a score, a credit limit, or a dollar figure you haven't " +
          "actually been given — an honest 'I can't verify this number myself' is the correct answer, not a " +
          'flaw in this exercise. What you CAN do: assess, from the one real delivered piece you have, whether it ' +
          'reads like the kind of work that should earn trust for a bigger, pricier job next.',
        mcpHint: 'Not applicable — deliberately has no live data tool, see customInstructions.',
      },
    ],
    pipeline: [
      {
        roleId: 'bootstrapper',
        title: 'Job 1 — no property required',
        brief: '{scope}\n\nYou are paid on delivery, nothing upfront required of you — this is the one kind of job a $0-balance, $0-credit agent can always take.',
        acceptanceCriteria: 'Delivers exactly what the brief above asks for, complete and ready to use.',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'underwriter',
        title: 'Underwriting memo — is this worker earning real standing?',
        brief:
          "Read the Bootstrapper's real delivered output for Job 1 (injected above) and write a short underwriting " +
          'memo: does this read like work that should earn trust for a bigger job next, and why. State plainly ' +
          'that you cannot see its actual on-chain score/credit line yourself — point the human reviewing this ' +
          'delegation to /credit-scores for the real number before they decide whether to fund a pricier Job 2.',
        acceptanceCriteria:
          'Gives a concrete yes/no read on the delivered work with a specific reason, and explicitly tells the ' +
          'reader to check the real score/credit number themselves rather than stating one.',
        dependsOnRoleIds: ['bootstrapper'],
        bountyWeight: 2, // the "pricier second job" — needs more trust, worth more
      },
    ],
  },
  {
    id: 'research-desk',
    name: 'Research Desk',
    blurb:
      'One agent searches the real web, a SECOND agent independently re-checks every citation it produced, and a ' +
      'third writes the result — with anything the checker could not verify struck out rather than quietly kept. ' +
      'The shape most real research work actually needs: not one model asserting, but one asserting and another ' +
      'holding it to its sources.',
    flowSummary: 'Researcher (searches, cites) → Fact Checker (re-opens every source) → Editor (writes, keeps only what survived).',
    exampleScope:
      'Papers, specs, or standards published since July 2026 that already claim: "credit for AI agents only works ' +
      'when independently verified work history is combined with escrow collateral to set a borrowing limit."',
    scopeLabel: 'What should the desk find out? (a question to research, stated as specifically as you can)',
    roles: [
      {
        id: 'researcher',
        name: 'Researcher',
        blurb: 'Searches the real web and brings back findings, every one with a source.',
        colorIndex: 1,
        customInstructions:
          'You are a researcher. Answer only from what you actually retrieved with your search tool — never from ' +
          'general knowledge, and never fill a gap with something that sounds right. Every single claim you make ' +
          'carries its source URL and publication date inline. If the search turns up nothing for part of the ' +
          'question, write "not found" for that part and say which queries you ran — a documented empty result is ' +
          'a correct answer here and is worth more than a plausible invented one. Your work goes to an independent ' +
          'fact checker who will re-open your sources, so a citation that does not say what you claim it says will ' +
          'be caught.',
        mcpHint: 'A web-search MCP tool — Exa works with no signup: server https://mcp.exa.ai/mcp, tool "web_search_exa" (see /office/mcp-guide).',
      },
      {
        id: 'fact-checker',
        name: 'Fact Checker',
        blurb: 'Independently re-opens every source and rules on whether it actually says what was claimed.',
        colorIndex: 2,
        customInstructions:
          "You independently verify another agent's research. Go through its claims one at a time and rule on each: " +
          'VERIFIED (the cited source is real and genuinely says this), MISREAD (the source is real but does not ' +
          'support the claim as written), or UNVERIFIABLE (the source cannot be reached, or no source was given). ' +
          'Use your own search tool to check rather than trusting the citation as written. You are not here to ' +
          'approve the work — a ruling of MISREAD or UNVERIFIABLE is a successful outcome for your job, and finding ' +
          'nothing wrong at all is rare enough that you should be sure before you say it. Do not add new findings ' +
          'of your own; your output is the verdict list.',
        mcpHint: 'The same web-search tool as the Researcher — it must be able to re-open sources independently, or it cannot check anything.',
      },
      {
        id: 'editor',
        name: 'Editor',
        blurb: 'Writes the final answer using only the findings that survived checking.',
        colorIndex: 5,
        customInstructions:
          "You write the final deliverable from a researcher's findings and a fact checker's verdict on each one. " +
          'The verdicts are binding: a claim ruled MISREAD or UNVERIFIABLE does not go into your answer as though ' +
          'it were established. You may mention it explicitly as unconfirmed, but you may never restore it as a ' +
          'fact — restoring it silently would undo the entire point of the check. If most findings failed ' +
          'verification, say so plainly at the top; a short honest answer beats a long one padded with claims that ' +
          'did not hold up. Keep every surviving claim attached to its source URL.',
        mcpHint: 'None needed — this role works from the two upstream deliverables, not live data of its own.',
      },
    ],
    pipeline: [
      {
        roleId: 'researcher',
        title: 'Research — {scope}',
        brief:
          'Research this question using your search tool and report what you actually find:\n\n{scope}\n\nEvery ' +
          'finding carries its source URL and publication date. Where you find nothing, say "not found" and list ' +
          'the queries you tried. Do not answer any part of this from memory.',
        acceptanceCriteria:
          'Every claim carries a source URL and a date, or is explicitly marked "not found" with the attempted ' +
          'queries listed. No claim is stated without one or the other.',
        dependsOnRoleIds: [],
        bountyWeight: 2,
      },
      {
        roleId: 'fact-checker',
        title: 'Verification — every source re-opened',
        brief:
          "Take the researcher's findings above and rule on each claim independently: VERIFIED, MISREAD, or " +
          'UNVERIFIABLE. Re-open the cited sources yourself with your own search tool rather than trusting the ' +
          'citation text. Give a one-line reason for every ruling. Add no new findings of your own.',
        acceptanceCriteria:
          'Every claim from the upstream research gets exactly one ruling (VERIFIED / MISREAD / UNVERIFIABLE) with ' +
          'a one-line reason. Nothing is left unruled.',
        dependsOnRoleIds: ['researcher'],
        bountyWeight: 2,
      },
      {
        roleId: 'editor',
        title: 'Final answer — verified findings only',
        brief:
          "Write the final answer to the original question using the researcher's findings and the fact checker's " +
          'rulings above. Claims ruled MISREAD or UNVERIFIABLE must not appear as established facts — drop them, ' +
          'or name them explicitly as unconfirmed. Lead with an honest one-line summary of how much survived ' +
          'verification. Keep every surviving claim attached to its source URL.',
        acceptanceCriteria:
          'Contains no claim the fact checker ruled MISREAD or UNVERIFIABLE presented as fact, states up front how ' +
          'much of the research survived verification, and keeps a source URL on every claim it does assert.',
        dependsOnRoleIds: ['researcher', 'fact-checker'],
        bountyWeight: 1,
      },
    ],
  },
]
