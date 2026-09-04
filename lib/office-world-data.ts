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

export type McpBinding = {
  connectorId: string
  toolName: string
  /** 'assisted' has the role WRITE its deliverable from what the tool
   *  returned, rather than submitting the tool's raw output as the work —
   *  which is what a search-shaped server needs, since a result dump satisfies
   *  no acceptance criterion however good the retrieval was. Absent means
   *  'proxy', the behavior every MCP worker had before modes existed. See
   *  lib/mcp-assist.ts. */
  mode?: 'proxy' | 'assisted'
}

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
): { serverUrl: string; toolName: string; authHeader?: string; mode: 'proxy' | 'assisted' } | null {
  const binding = bindings?.[roleId]
  if (!binding) return null
  const toolName = binding.toolName?.trim()
  if (!toolName) return null
  const connector = connectors.find((c) => c.id === binding.connectorId)
  const serverUrl = connector?.serverUrl.trim()
  if (!connector || !serverUrl) return null
  return {
    serverUrl,
    toolName,
    authHeader: connector.authHeader?.trim() || undefined,
    mode: binding.mode === 'assisted' ? 'assisted' : 'proxy',
  }
}


/** Offices per account (lib/office.ts). Defined here, not there, because that
 *  file imports @/lib/db (pg) and this one must stay importable from client
 *  components. lib/office.ts imports it back. */
export const MAX_OFFICE_SLOTS = 3

/**
 * Room taxonomy — re-exported from lib/office-functional-departments.ts
 * (a pure, DB-free, unit-tested module) rather than declared here directly,
 * so the derivation logic and the taxonomy it produces can't drift apart.
 *
 * This used to be twelve STATUS buckets (disputed/reviewing/working/
 * delegating/credit/settled/governance/mining/external/template/erc8004/
 * capable) — an agent's CONDITION, not its function. "Mining" in particular
 * had become the de facto catch-all: any autoMine agent not otherwise busy
 * landed there regardless of what kind of work it actually did. Space
 * communicated status, not function — exactly the mental model the office
 * redesign exists to replace. See office-functional-departments.ts's header
 * for the nine functional rooms this became.
 */
import type { FunctionalDeptId } from '@/lib/office-functional-departments'
export type { FunctionalDeptId as OfficeDeptId } from '@/lib/office-functional-departments'
export { FUNCTIONAL_DEPARTMENTS as OFFICE_DEPARTMENTS } from '@/lib/office-functional-departments'
// office-artifact-flights.ts is pure (no @/lib/db import) — its types are
// re-exported here anyway, matching every other type in this file, so the
// client engine never has to remember which server-adjacent module happens
// to be safe to import directly.
import type { ArtifactFlight } from '@/lib/office-artifact-flights'
export type { ArtifactFlight, ArtifactFlightKind } from '@/lib/office-artifact-flights'
// Same rule for conversations (lib/office-conversations.ts is pure).
import type { AgentConversation } from '@/lib/office-conversations'
export type { AgentConversation, ConversationKind } from '@/lib/office-conversations'

export type OfficeStaffMember = {
  id: string
  name: string
  role: string
  deptId: FunctionalDeptId | null // null = lounge (idle — nothing else matched)
  rank: 'lead' | 'member'
  statusLine: string
}

export type OfficeSnapshot = {
  ceoName: string
  ceoLine: string
  staff: OfficeStaffMember[]
  /** Deliverables currently traveling between two known rooms — see
   *  lib/office-artifact-flights.ts's header for exactly what "known" and
   *  "currently" require before a flight is included at all. */
  artifactFlights: ArtifactFlight[]
  /** Recent agent-to-agent negotiation messages between agents of THIS
   *  roster (lib/office-conversations.ts — real agent_messages rows inside
   *  the freshness window, nothing else). */
  conversations: AgentConversation[]
}

/**
 * Client-safe shape of the Treasury room's real numbers — declared here
 * (never imported from lib/office-treasury.ts or lib/onchain/labor-v2.ts
 * directly) for the same reason OfficeSnapshot lives here rather than in
 * office-world-server.ts: those files import @/lib/db, which drags in `pg`,
 * which cannot be bundled for the browser. The 'use client' office page
 * imports the TYPE from here and the VALUE from a server action
 * (myOfficeTreasury) — never the other way around.
 */
export type OfficeTreasuryView = {
  office: {
    agentCount: number
    walletCount: number
    usdcTotal: number | null
    ethTotalWei: string | null
    walletReadErrors: number
  }
  market: {
    solvency: { owedUsd: number; heldUsd: number; surplusUsd: number } | null
    fee: { feeBps: number; flatFeeUsd: number; feeRecipient: string; balanceUsd: number | null } | null
  }
}

/** Client-safe shape of the account-wide "Company HQ" HUD — same reasoning
 *  and same rule as OfficeTreasuryView above: this is what the 'use client'
 *  page imports the TYPE from; lib/company-treasury.ts (which touches
 *  @/lib/db) supplies the VALUE, only ever from a server action. */
export type CompanyTreasuryView = {
  agentCount: number
  usdc: { walletCount: number; usdcTotal: number | null; ethTotalWei: string | null; walletReadErrors: number }
  gasPool: CompanyGasPoolStatus
  /** Computed server-side (lib/company-treasury.ts's gasPoolHealth) so the
   *  'use client' HUD never needs to import that function itself — that
   *  function lives in a file that touches @/lib/db and cannot be bundled
   *  for the browser. The client only ever reads this plain string. */
  gasHealth: CompanyGasHealth
}

export type CompanyGasHealth = 'unconfigured' | 'disabled' | 'unknown' | 'empty' | 'low' | 'ok'

export type CompanyGasPoolStatus =
  | { configured: false }
  | {
      configured: true
      enabled: boolean
      sourceAgentId: string
      sourceAgentName: string
      heldWei: string | null
      spendableWei: string | null
      spentTodayWei: string | null
      budgetWei: string
      reserveWei: string
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
  /**
   * A real, working MCP server this role should be wired to, pre-filled in the
   * hire dialog instead of left as advice.
   *
   * mcpHint above is a sentence telling somebody to go and find a tool. That
   * is the difference between a template and a desk that works when you hire
   * it: every endpoint named here was probed with this repo's own client
   * (initialize → tools/list → tools/call) and answered a real question with
   * no key — see docs/office-connectors.md for what was run and when. The
   * dialog still shows them as ordinary connector rows, so any one can be
   * edited or removed before hiring.
   */
  defaultConnector?: { label: string; serverUrl: string; toolName: string }
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
  /**
   * This step is a PEER REVIEW of another step's deliverable, named by that
   * step's roleId. It becomes the delegation's `reviewOf` (lib/delegation.ts
   * ②), which means the reviewed step's escrow is held until this reviewer
   * approves — and, since the revision round-trip, a REVISE is handed back to
   * the reviewed step's own worker with the note rather than to a human.
   *
   * Office templates could not express review at all before this: the hire
   * action only ever emitted dependsOn, so a template could sequence work but
   * never gate it. The reviewed step is added to this step's dependencies
   * automatically — a reviewer posted before its target delivers has nothing
   * to read.
   */
  reviewOfRoleId?: string
  /**
   * The search query a tool-backed worker on this step should send, instead
   * of its whole brief. Appended to the brief as an `[mcp-query]` line, which
   * lib/mcp-client.ts's extractMcpQuery reads.
   *
   * Necessary because the worker call passes the brief as the tool's single
   * string argument: measured against AWS's own docs server, a full brief
   * returned the wrong pages while the short query under it returned the right
   * one first. `{scope}` is substituted the same way it is everywhere else.
   * Only meaningful for a role wired to a search-shaped tool; harmless
   * otherwise, where it reads as a hint about what to look up.
   */
  mcpQuery?: string
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
 * the whole on-chain layer. tests/delegation-payers.test.ts asserts the two
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

/**
 * The connectors and role bindings a template ships pre-filled, ready for the
 * hire dialog to show as ordinary editable rows.
 *
 * Deduplicated by server URL, so two roles reading the same docs server share
 * one connector row rather than opening two sessions to the same host and
 * showing the person a duplicate to maintain. Pure; returns empty for a
 * template whose roles declare no default, which is every template written
 * before defaults existed.
 */
export function defaultWiringFor(template: OfficeTemplate): {
  connectors: McpConnector[]
  bindings: Record<string, McpBinding>
} {
  const connectors: McpConnector[] = []
  const bindings: Record<string, McpBinding> = {}
  const idByUrl = new Map<string, string>()
  for (const role of template.roles) {
    const d = role.defaultConnector
    if (!d) continue
    const url = d.serverUrl.trim()
    if (!url || !d.toolName.trim()) continue
    let connectorId = idByUrl.get(url)
    if (!connectorId) {
      connectorId = `preset-${connectors.length + 1}`
      idByUrl.set(url, connectorId)
      connectors.push({ id: connectorId, label: d.label, serverUrl: url })
    }
    // Every shipped default is a search-shaped server, so the deliverable has
    // to be written from what it returns, not be what it returns.
    bindings[role.id] = { connectorId, toolName: d.toolName.trim(), mode: 'assisted' }
  }
  return { connectors, bindings }
}

export type HireOfficeTemplateInput = {
  templateId: string
  primeAgentId: string
  scope: string
  budgetUsd: number
  /**
   * The connectors available to this office. Several, not one: the agent
   * table has carried per-agent mcpServerUrl/mcpToolName all along, and only
   * the hire form forced every role through a single shared URL — so an
   * office could never put a web-search role, a vault role and a market-data
   * role side by side, which is most of the point of an office.
   */
  mcpConnectors?: McpConnector[]
  /** roleId -> which connector it uses and which tool on it. A role left out
   *  stays a plain platform agent; a binding naming an unknown connector, or
   *  missing a tool name, is skipped rather than guessed at. */
  mcpBindings?: Record<string, McpBinding>
  /**
   * Build a second, separate desk instead of reusing the one already in this
   * office slot.
   *
   * Reuse is the default because the alternative was worse in a way nobody
   * could see: a re-hire minted "AWS Reader 2" with a fresh smart account and
   * no ETH, so on a no-paymaster deployment the new desk could not transact
   * at all, while the hand-funded original sat idle beside it. Opting out is
   * for genuinely wanting two of the same desk in one office.
   */
  freshAgents?: boolean
  /**
   * roleId -> which of the account's agents escrows THAT pipeline step's
   * bounty. A step left out is paid by the prime agent, which is what every
   * office did before this existed.
   *
   * An office had exactly one payer only because the delegation posted every
   * job from `delegation.primeAgentId`. Paying is a per-job fact — the escrow
   * comes from whoever posts — so a desk whose research is funded by one
   * budget and whose legal review is funded by another is now expressible.
   * Each named agent must be this account's and provisioned; it pays only for
   * its own steps.
   */
  payerByRoleId?: Record<string, string>
  officeSlot?: number
}

export type HireOfficeTemplateResult = {
  delegationId: string
  hired: Array<{
    roleId: string
    agentId: string
    name: string
    mcpConnected: boolean
    /** Whether the role got an on-chain account. Without one it cannot claim
     *  even its own reserved job — see the comment in lib/office-hire.ts. */
    provisioned: boolean
    /** True when this role is the agent that was already in the office,
     *  keeping its wallet and the gas in it, rather than a new hire. Reported
     *  because "reused" and "created" differ in exactly the way that matters:
     *  a new agent starts with no ETH. */
    reused: boolean
  }>
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
    id: 'securities-floor',
    name: 'Securities Floor',
    blurb:
      'Nine desks that argue before anyone allocates: four analysts feed a quant model, a risk officer peer-reviews it ' +
      '(REVISE goes back to the modeler), a planner drafts the rebalance, a red team reviews that, and a committee chair ' +
      'writes the one decision everyone signed off on — a draft memo, never an executed trade.',
    flowSummary:
      'Chart + News + Flow + Macro → Quant Modeler ⇄ Risk Officer (review) → Rebalance Planner ⇄ Red Team (review) → Committee Chair (decision memo, draft only).',
    exampleScope: 'KRW-BTC, KRW-ETH, KRW-SOL',
    scopeLabel: 'Markets in scope (e.g. KRW-BTC, KRW-ETH, KRW-SOL)',
    usesMarketData: true,
    roles: [
      {
        id: 'chart-analyst',
        name: 'Chart Analyst',
        blurb: 'Reads real candles for trend, support/resistance, momentum and regime.',
        colorIndex: 4,
        customInstructions:
          'You are the chart/technical analyst on a securities floor. Use your connected market-data tool for every ' +
          'number: trend direction, one support and one resistance level with the exact price and date they printed, a ' +
          'momentum read, and the regime belief your tool reports. Cite the tool output verbatim. Never invent a price.',
        mcpHint: 'A candle/price-report tool for the markets in scope.',
      },
      {
        id: 'news-analyst',
        name: 'News Analyst',
        blurb: 'Reads headlines and filings, cites source and date, says "nothing material" when that is the truth.',
        colorIndex: 1,
        customInstructions:
          'You are the news/filings analyst on a securities floor. Use your connected news tool and summarize only what ' +
          'plausibly moves the markets in scope, citing headline, date and source for each item. If your tool returns ' +
          'nothing for a market, say so plainly rather than paraphrasing from memory.',
        mcpHint: 'A news/headline tool for the markets in scope.',
      },
      {
        id: 'flow-analyst',
        name: 'Flow Analyst',
        blurb: 'Order book depth, taker buy/sell tape, volume trend — who is actually pressing.',
        colorIndex: 2,
        customInstructions:
          'You are the order-flow / microstructure analyst. Use your connected flow tool and report, per market: spread, ' +
          'depth imbalance, taker buy share on the recent tape, and the volume trend — then say whether flow confirms or ' +
          'contradicts the chart picture. Numbers come only from the tool output; label anything it did not return as absent.',
        mcpHint: 'An order-book / trade-tape tool for the markets in scope.',
      },
      {
        id: 'macro-analyst',
        name: 'Macro Analyst',
        blurb: 'Dollar, equities, VIX, yields, gold, BTC correlation — the backdrop the basket trades in.',
        colorIndex: 7,
        customInstructions:
          'You are the macro / cross-asset analyst. Use your connected macro tool and give the floor a risk-on/risk-off ' +
          'read grounded only in the closes, changes and correlations the tool returned. State what would flip your read. ' +
          'Do not invent a data point the tool did not provide.',
        mcpHint: 'A cross-asset daily-close tool (dollar index, S&P 500, VIX, yields, gold, BTC).',
      },
      {
        id: 'quant-modeler',
        name: 'Quant Modeler',
        blurb: 'Fits regime + volatility models and proposes a weight per market, reconciling the four analysts.',
        colorIndex: 3,
        customInstructions:
          'You are the quant modeler. You receive the chart, news, flow and macro deliverables AND your own connected ' +
          'quant tool (regime belief, volatility forecast, VaR/ES, Kelly cap). Propose a target weight per market with a ' +
          'one-line reason each, say explicitly where the analysts agreed and where they conflicted and which side you ' +
          'took, and keep every position at or under the Kelly cap the tool reports. A reviewer will challenge this: ' +
          'if you receive a REVISE note, answer each point and resubmit the revised weights.',
        mcpHint: 'A quant tool that fits regime/volatility models on real candles.',
      },
      {
        id: 'risk-officer',
        name: 'Risk Officer',
        blurb: 'Peer-reviews the quant model with basket-level risk numbers; can send it back for revision.',
        colorIndex: 0,
        customInstructions:
          "You are the risk officer and you are REVIEWING the quant modeler's deliverable. Run your connected basket-risk " +
          'tool on the same markets and check the proposal against it: concentration, correlation (is the basket one ' +
          'bet?), VaR/ES, drawdown. Verdict APPROVE only if every weight is defensible against those numbers; otherwise ' +
          'REVISE with the specific weight and the specific number that contradicts it. You are paid the same either way — ' +
          'approve when the numbers support it, revise when they do not.',
        mcpHint: 'A basket-risk tool (correlation matrix, basket VaR/ES, drawdown).',
      },
      {
        id: 'rebalance-planner',
        name: 'Rebalance Planner',
        blurb: 'Turns the reviewed weights into a concrete draft order list — proposal only, never auto-executed.',
        colorIndex: 6,
        customInstructions:
          "You are the rebalance planner. Given the quant model's reviewed weights and the risk officer's verdict, produce " +
          'a concrete proposed order list per market (buy/sell, target weight, notional to move) using your connected ' +
          'rebalance tool for the arithmetic. This is a DRAFT for review — you have no authority to submit real orders, ' +
          'and the deliverable must say plainly that it is a draft, not an executed trade.',
        mcpHint: 'A rebalance-draft tool that turns weights into a proposed order list.',
      },
      {
        id: 'red-team',
        name: 'Red Team',
        blurb: 'Adversarially reviews the rebalance draft: backtests the thesis, hunts for the unsourced number.',
        colorIndex: 5,
        customInstructions:
          "You are the red team and you are REVIEWING the rebalance planner's draft. Use your connected backtest tool on " +
          'the markets in the draft and attack the proposal: does the historical evidence support the tilt after costs? ' +
          'Is any number in the draft unsourced or contradicted upstream? Verdict APPROVE if the draft survives; REVISE ' +
          'with the exact line that fails and why. Do not rewrite the draft yourself.',
        mcpHint: 'A backtest tool for the markets in scope.',
      },
      {
        id: 'chair',
        name: 'Investment Committee Chair',
        blurb: 'Reads everything, records where the floor agreed and disagreed, and writes the single decision memo.',
        colorIndex: 8,
        customInstructions:
          'You chair the investment committee. You receive the rebalance draft and the red-team review (and through them ' +
          'the whole floor). Write the decision memo: what was proposed, what the reviewers objected to, what changed, and ' +
          'the final target weight per market with the deciding argument for each. Where the floor disagreed, say who won ' +
          'and why. This memo is a draft allocation for the trading desk to apply to its paper ledger; it is not an ' +
          'executed trade and you place no orders. If the brief specifies a machine-readable closing block, end with it exactly.',
        mcpHint: 'None needed — this role synthesizes the floor; it holds no data tool of its own.',
      },
    ],
    pipeline: [
      {
        roleId: 'chart-analyst',
        title: 'Chart analysis — {scope}',
        brief:
          'Pull recent candles for {scope} and summarize, per market: trend direction, one support and one resistance ' +
          'level with the exact price and date, a momentum call, and the regime belief your tool reports. Every number ' +
          'from the tool output, none from memory.',
        acceptanceCriteria:
          'Every market in {scope} gets a trend read, a support level, a resistance level (each with a price and a date) ' +
          'and a momentum call, all traceable to the tool output.',
        dependsOnRoleIds: [],
        mcpQuery: '{scope}',
      },
      {
        roleId: 'news-analyst',
        title: 'News & filings analysis — {scope}',
        brief:
          'Review recent headlines for {scope} and summarize what is actually relevant to price, citing headline, date ' +
          'and source for each item. A market with nothing material gets an explicit "nothing material found".',
        acceptanceCriteria:
          'Every market in {scope} gets at least one cited item (headline, date, source) or an explicit "nothing material ' +
          'found" backed by a genuine tool call.',
        dependsOnRoleIds: [],
        mcpQuery: '{scope}',
      },
      {
        roleId: 'flow-analyst',
        title: 'Order-flow analysis — {scope}',
        brief:
          'Report the order book and trade tape for {scope}: spread, depth imbalance, taker buy share, volume trend — ' +
          'and whether flow confirms or contradicts the price trend. Only numbers the tool returned.',
        acceptanceCriteria:
          'Every market in {scope} gets spread, depth imbalance, taker buy share and a volume-trend line, each a number ' +
          'from the tool output, plus a one-line confirm/contradict call.',
        dependsOnRoleIds: [],
        mcpQuery: '{scope}',
      },
      {
        roleId: 'macro-analyst',
        title: 'Macro & cross-asset read — {scope}',
        brief:
          'Give the floor the macro backdrop for trading {scope}: dollar, equities, VIX, yields, gold and BTC ' +
          'correlation from your tool, a risk-on/risk-off read, and what would flip it.',
        acceptanceCriteria:
          'Cites last close and 20-day change for at least five cross-asset series from the tool output, states a ' +
          'risk-on/risk-off read, and names the condition that would flip it.',
        dependsOnRoleIds: [],
        mcpQuery: 'macro backdrop for {scope}',
      },
      {
        roleId: 'quant-modeler',
        title: 'Quant model — weights for {scope}',
        brief:
          'Read the chart, news, flow and macro deliverables for {scope} and, with your own quant tool, propose a target ' +
          'weight per market under the Kelly cap. State per market which analyses agreed, which conflicted, and which ' +
          'side you took. Expect a risk review; answer any REVISE point by point.',
        acceptanceCriteria:
          'Every market in {scope} gets an explicit target weight with a reason, each weight is at or under the Kelly ' +
          'cap the tool reports, and at least one agreement and one conflict among the upstream analyses is named.',
        dependsOnRoleIds: ['chart-analyst', 'news-analyst', 'flow-analyst', 'macro-analyst'],
        bountyWeight: 2,
        mcpQuery: '{scope}',
      },
      {
        roleId: 'risk-officer',
        title: 'Risk review of the quant model — {scope}',
        brief:
          "Review the quant model's weights for {scope} against your basket-risk tool: concentration, pairwise " +
          'correlation, basket VaR/ES, drawdown. APPROVE only if every weight is defensible; otherwise REVISE naming the ' +
          'weight and the number that contradicts it.',
        acceptanceCriteria:
          'Cites the basket correlation and VaR/ES numbers from the tool, checks every weight in the model against them, ' +
          'and ends with an explicit APPROVE or REVISE verdict with reasons.',
        dependsOnRoleIds: [],
        reviewOfRoleId: 'quant-modeler',
        mcpQuery: '{scope}',
      },
      {
        roleId: 'rebalance-planner',
        title: 'Rebalance proposal (draft — not executed) — {scope}',
        brief:
          "Turn the reviewed weights for {scope} into a concrete proposed order list (market, buy/sell, target weight, " +
          'notional to move) using your rebalance tool. State explicitly that this is a draft for review, not an ' +
          'executed trade.',
        acceptanceCriteria:
          'Every market with a nonzero weight change gets a concrete buy/sell line with a target weight, and the ' +
          'deliverable states explicitly that it is a draft, not an executed order.',
        dependsOnRoleIds: ['quant-modeler', 'risk-officer'],
        mcpQuery: '{scope}',
      },
      {
        roleId: 'red-team',
        title: 'Red-team challenge of the rebalance draft — {scope}',
        brief:
          "Attack the rebalance draft for {scope}: backtest the tilt with your tool, check every number against the " +
          'upstream deliverables, and find the unsourced claim. APPROVE if it survives; REVISE with the exact failing line.',
        acceptanceCriteria:
          'Cites backtest figures from the tool for the markets in the draft, checks the draft line by line against ' +
          'upstream numbers, and ends with an explicit APPROVE or REVISE verdict with reasons.',
        dependsOnRoleIds: [],
        reviewOfRoleId: 'rebalance-planner',
        mcpQuery: '{scope}',
      },
      {
        roleId: 'chair',
        title: 'Investment committee decision — {scope}',
        brief:
          'Read the rebalance draft and the red-team review for {scope} and write the decision memo: what was proposed, ' +
          'what reviewers objected to, what changed, the final target weight per market with its deciding argument, and ' +
          'who won each disagreement. It is a draft allocation for a paper ledger, not an executed trade. If the scope ' +
          'text specifies a closing machine-readable block, end with it exactly as specified.',
        acceptanceCriteria:
          'Names at least one objection raised in review and how it was resolved, gives a final target weight per market ' +
          'in {scope} with a reason, states the memo is a draft and not an executed trade, and ends with any closing ' +
          'block the scope demanded.',
        dependsOnRoleIds: ['rebalance-planner', 'red-team'],
        bountyWeight: 2,
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
  {
    // The template that exercises the three things an office can do that a
    // list of parallel contractors cannot: one shared source every role reads
    // (lib/office-source-brief.ts), a different wallet behind different steps
    // (payerAgentId), and a review that actually goes back to the worker
    // (reviewOfRoleId → lib/delegation.ts's revision round-trip). Diligence is
    // the honest fit for all three — it is a real job where several
    // specialists read one data room and a partner's memo gets challenged
    // before anyone signs.
    id: 'due-diligence-desk',
    name: 'Due Diligence Desk',
    blurb:
      'Three specialists read the same deal file from different angles, a partner writes the memo, and a red team ' +
      'sends it back until it holds.',
    flowSummary:
      'Commercial + Financial + Legal read one shared file → Partner writes the IC memo → Red Team reviews it, and a REVISE goes back to the Partner (up to 2 rounds).',
    exampleScope:
      'Acquiring Northwind Logistics — a 40-person third-party logistics operator in Rotterdam, asking €12M, ' +
      'flat revenue for two years, one customer at 38% of turnover.',
    scopeLabel: 'The deal or decision under diligence (what is being bought, signed, or committed to)',
    roles: [
      {
        id: 'commercial',
        name: 'Commercial Analyst',
        blurb: 'Reads the market position: customers, concentration, pricing power, what happens if the biggest one leaves.',
        colorIndex: 1,
        customInstructions:
          'You assess the commercial reality of a deal. Work from the shared file in your brief first — it is the ' +
          'actual document under diligence, and what it says beats anything you assume. Where it is silent, use ' +
          'your tool to look outside it and say plainly that you did. Concentration, switching costs, pricing ' +
          'power and renewal risk are your subject; valuation and legal exposure belong to other people at this ' +
          'desk, so do not duplicate them. Every material claim names where it came from: a section of the shared ' +
          'file, or a source you retrieved. An unknown written as "the file does not say" is worth more here than ' +
          'a confident guess — a diligence memo built on a guess is how a bad deal gets signed.',
        mcpHint: 'A web-search tool for market and customer checks — Exa: server https://mcp.exa.ai/mcp, tool "web_search_exa".',
      },
      {
        id: 'financial',
        name: 'Financial Reviewer',
        blurb: 'Reads the numbers: unit economics, working capital, and which figures in the file do not reconcile.',
        colorIndex: 2,
        customInstructions:
          'You review the numbers in a deal file. Start from the figures actually in the shared file and check ' +
          'them against each other — margin against pricing, working capital against revenue, growth against ' +
          'headcount. Say explicitly which figures the file does not contain; a missing number is a diligence ' +
          'finding, not something to fill in. Where two figures in the file disagree, quote both and name the ' +
          'contradiction rather than picking one. You are not valuing the business and not recommending anything: ' +
          'your output is what the numbers support and what they do not.',
        mcpHint: 'Optional — a spreadsheet, database or document MCP tool if the real figures live somewhere the file only summarizes.',
      },
      {
        id: 'legal',
        name: 'Legal & Compliance Reader',
        blurb: 'Reads for liabilities: contracts, change-of-control, licensing, regulatory exposure.',
        colorIndex: 4,
        customInstructions:
          'You read a deal file for legal and regulatory exposure: contract terms, change-of-control clauses, ' +
          'licensing, employment obligations, anything that survives the transaction. Quote the clause or the ' +
          'passage you are relying on rather than characterising it. Where the shared file does not include a ' +
          'document you would need, list it as a diligence request instead of speculating about what it probably ' +
          'says. You are not giving legal advice and you say so; you are listing exposure a lawyer should look at, ' +
          'ranked by how much it could cost.',
        mcpHint: 'Optional — a document-search or vault MCP tool pointed at the contracts, if they are not in the shared file.',
      },
      {
        id: 'partner',
        name: 'Partner',
        blurb: 'Writes the investment-committee memo: one recommendation, with the case against it stated.',
        colorIndex: 5,
        customInstructions:
          'You write the memo the committee decides from. You have three specialist reads and the shared file. ' +
          'Give one recommendation — proceed, proceed with conditions, or walk — in the first line, then the case ' +
          'for it, then the strongest case against it stated as well as its own advocate would put it. Where the ' +
          'specialists disagree with each other, name the disagreement instead of averaging it away. Every ' +
          'material claim traces to a specialist read or to the shared file. A red team will challenge this memo ' +
          'and can send it back to you: when it does, fix what it identified and return the whole memo again, and ' +
          'where you think it is wrong, keep your position and say why.',
        mcpHint: 'None needed — this role works from the three upstream reads and the shared file.',
      },
      {
        id: 'red-team',
        name: 'Red Team',
        blurb: "Challenges the memo before anyone signs, and sends it back if it doesn't hold.",
        colorIndex: 3,
        customInstructions:
          'You are the last check before a decision. Judge the memo against its acceptance criteria and reply ' +
          'APPROVE or REVISE on the first line with a one-line reason. REVISE is a successful outcome for your ' +
          'job — approving a memo that rests on an unsupported claim is the failure. Look for: a recommendation ' +
          'stronger than the evidence under it, a specialist finding that was quietly dropped, a disagreement ' +
          'averaged away, and a case-against that is a straw man. Your note goes back to the author, so make it ' +
          'specific enough to act on — name the claim and what is missing, not "needs more rigour". Judge only ' +
          'what the criteria ask for; do not invent new requirements between rounds.',
        mcpHint: 'None needed — the memo and the upstream reads are the material. A search tool only if you want to check a specific claim.',
      },
    ],
    pipeline: [
      {
        roleId: 'commercial',
        title: 'Commercial read — {scope}',
        brief:
          'Assess the commercial position of this deal:\n\n{scope}\n\nCover customer concentration, pricing ' +
          'power, switching costs and renewal risk. Ground every material claim in the shared file where it says ' +
          'something, and say so explicitly where it does not. Leave valuation and legal exposure to the others.',
        acceptanceCriteria:
          'Every material claim is either traced to the shared file or marked as retrieved from outside it, and ' +
          'the gaps the file does not answer are listed rather than filled in.',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'financial',
        title: 'Financial read — {scope}',
        brief:
          'Review the numbers behind this deal:\n\n{scope}\n\nCheck the figures in the shared file against each ' +
          'other and name every contradiction you find, quoting both sides. List the figures a buyer would need ' +
          'that the file does not contain. Do not value the business and do not recommend anything.',
        acceptanceCriteria:
          'Names every internal contradiction it found (or states plainly that it found none after checking), and ' +
          'lists the missing figures as diligence requests. Contains no valuation and no recommendation.',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'legal',
        title: 'Legal & regulatory read — {scope}',
        brief:
          'Read this deal for exposure that survives the transaction:\n\n{scope}\n\nContract terms, ' +
          'change-of-control, licensing, employment and regulatory obligations. Quote the passage you rely on. ' +
          'Where a document you would need is not in the shared file, list it as a request. Rank what you find by ' +
          'potential cost, and state that this is not legal advice.',
        acceptanceCriteria:
          'Each exposure quotes the passage it rests on or is listed as a document request, findings are ranked by ' +
          'potential cost, and the note that this is not legal advice is present.',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'partner',
        title: 'Investment committee memo — {scope}',
        brief:
          'Write the IC memo for this decision:\n\n{scope}\n\nOne recommendation on the first line — proceed, ' +
          'proceed with conditions, or walk. Then the case for it, then the strongest case against it. Name any ' +
          'disagreement between the three specialist reads instead of averaging it. Every material claim traces to ' +
          'a specialist read or to the shared file.',
        acceptanceCriteria:
          'Opens with exactly one of proceed / proceed with conditions / walk, contains a case against stated at ' +
          'full strength, names any specialist disagreement rather than averaging it, and traces every material ' +
          'claim to a named upstream read or to the shared file.',
        dependsOnRoleIds: ['commercial', 'financial', 'legal'],
        bountyWeight: 2,
      },
      {
        roleId: 'red-team',
        title: 'Red team challenge — the memo before anyone signs',
        brief:
          'Challenge the investment committee memo above. Reply APPROVE or REVISE on the first line with a ' +
          'one-line reason. Look for a recommendation stronger than its evidence, a specialist finding that was ' +
          'dropped, a disagreement averaged away, and a straw-man case-against. If you send it back, name the ' +
          'specific claim and what is missing — your note goes to the author, who will return a corrected memo.',
        acceptanceCriteria:
          'Replies APPROVE or REVISE on the first line with a reason, and any REVISE names the specific claim at ' +
          'fault and what would fix it rather than asking for more rigour in general.',
        dependsOnRoleIds: ['partner'],
        // The memo's escrow is held until this passes, and a REVISE goes back
        // to the Partner with the note — up to MAX_REVISION_ROUNDS.
        reviewOfRoleId: 'partner',
        bountyWeight: 1,
      },
    ],
  },
  {
    // The desk that works the moment you hire it. Every other template hands
    // you an mcpHint — a sentence saying "go find a web-search tool" — and an
    // office that needs an afternoon of MCP setup before it can answer
    // anything is not useful, it is a shape. Here all four connectors are real
    // endpoints, probed with this repo's own client and answering with no key
    // (docs/office-connectors.md records what was run).
    //
    // The question it answers is one where a model's memory is actively
    // dangerous: cloud limits, quotas and tiers change quarterly, and an
    // answer from training data is confidently a year stale. Each vendor's
    // claim here comes from that vendor's own current documentation, and a
    // fourth agent checks the whole thing against sources none of the vendors
    // control — because no vendor's docs will ever say its own service is the
    // wrong choice.
    id: 'cloud-options-desk',
    name: 'Cloud Options Desk',
    blurb:
      "Three vendor docs and an independent check, each read live: what AWS, Azure and Cloudflare's own current " +
      'documentation actually say about your requirement — not what a model remembers.',
    flowSummary:
      'AWS · Azure · Cloudflare read their own live docs → Independent Check corroborates outside the vendors → Architect writes the comparison → Red Team sends it back until every figure is sourced.',
    exampleScope:
      'A webhook receiver taking 5M requests a month, p99 under 300ms, bursty (10x for ~2 minutes a few times a day), ' +
      'each request does one outbound HTTP call and one small write.',
    scopeLabel: 'The workload and its requirements (traffic, latency, burst shape, what each request does)',
    roles: [
      {
        id: 'aws',
        name: 'AWS Reader',
        blurb: "Answers only from AWS's own live documentation, and says so when the docs don't.",
        colorIndex: 1,
        customInstructions:
          "You answer questions about AWS from AWS's own current documentation, retrieved live with your tool — " +
          'never from memory. Cloud limits, quotas and pricing tiers change every quarter, so a remembered figure ' +
          'is worse than no figure: it is wrong in a way nobody can see. Quote the documented number and name the ' +
          'page it came from. Where the documentation does not state something, write that it does not — an ' +
          'unspecified limit is a real finding here. Never compare AWS to another cloud: other agents at this desk ' +
          'cover those, and your value is being the one who only reports what AWS itself publishes.',
        mcpHint: 'Pre-wired to the AWS Knowledge MCP server (no key needed).',
        defaultConnector: {
          label: 'AWS Knowledge (official docs)',
          serverUrl: 'https://knowledge-mcp.global.api.aws',
          toolName: 'aws___search_documentation',
        },
      },
      {
        id: 'azure',
        name: 'Azure Reader',
        blurb: "Same job for Microsoft Learn — Azure's own published limits, quoted and sourced.",
        colorIndex: 2,
        customInstructions:
          'You answer questions about Azure from Microsoft Learn, retrieved live with your tool — never from ' +
          'memory. Quote the documented figure and name the page. Where Learn does not state something, say so ' +
          'rather than estimating it. Do not compare Azure to another cloud; another agent covers each of those. ' +
          'Be careful with service tiers: a limit that holds on one plan often does not hold on another, so name ' +
          'the plan every figure belongs to.',
        mcpHint: 'Pre-wired to the Microsoft Learn MCP server (no key needed).',
        defaultConnector: {
          label: 'Microsoft Learn (official docs)',
          serverUrl: 'https://learn.microsoft.com/api/mcp',
          toolName: 'microsoft_docs_search',
        },
      },
      {
        id: 'cloudflare',
        name: 'Cloudflare Reader',
        blurb: "Cloudflare's own developer docs — the limits that decide whether Workers fits at all.",
        colorIndex: 4,
        customInstructions:
          "You answer questions about Cloudflare from Cloudflare's own developer documentation, retrieved live " +
          'with your tool — never from memory. Quote the documented figure and name the page. Cloudflare\'s model ' +
          'differs enough from the others that a like-for-like number sometimes does not exist: where the ' +
          'documentation measures something differently (CPU time rather than wall-clock duration, for one), say ' +
          'that plainly instead of converting it into a comparable-looking figure. Do not compare against other ' +
          'clouds.',
        mcpHint: 'Pre-wired to the Cloudflare docs MCP server (no key needed).',
        defaultConnector: {
          label: 'Cloudflare Docs (official)',
          serverUrl: 'https://docs.mcp.cloudflare.com/mcp',
          toolName: 'search_cloudflare_documentation',
        },
      },
      {
        id: 'independent',
        name: 'Independent Check',
        blurb: "Searches outside all three vendors, because no vendor's docs say its own product is the wrong pick.",
        colorIndex: 3,
        customInstructions:
          'You check vendor claims against sources the vendors do not control. Every reader at this desk quotes ' +
          "its own vendor's documentation, which is accurate about limits and silent about everything the vendor " +
          'would rather not publish: real-world cold starts, what the pricing does at the edges, the failure modes ' +
          'people actually hit. Search for independent measurements, incident write-ups and migration reports, and ' +
          'carry the source URL and date on every one. Where you find nothing independent, write "no independent ' +
          'source found" — that is an honest and useful answer, and inventing corroboration is the one thing that ' +
          'would make this desk worse than not having you.',
        mcpHint: 'Pre-wired to Exa web search (no key needed).',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'architect',
        name: 'Architect',
        blurb: 'Writes the comparison and the recommendation, with every figure carrying whose doc it came from.',
        colorIndex: 5,
        customInstructions:
          'You write the decision document from three vendor reads and one independent check. Lead with a ' +
          'recommendation and the single requirement that drove it. Then a comparison where every figure names ' +
          'the vendor doc it came from — a number with no source does not go in. Where the vendors measure ' +
          'something differently, say so instead of forcing a shared unit; where the independent check contradicts ' +
          'a vendor claim, put both side by side and say which you are relying on and why. If the readers found a ' +
          'limit unspecified, it stays unspecified in your document. Close with what would change the ' +
          'recommendation.',
        // Not "none needed": a role with no connector hires as a 'platform'
        // agent, which needs the external Python runtime — absent on both
        // public deployments — and the auto-mine sweep covers only cloud/mcp,
        // so wave 2 could never run autonomously and nothing said so
        // (docs/failure-modes.md section 61). The upstream reads arrive in the
        // brief either way; the connector is this role's WRITING runtime, and
        // assisted exa is the wiring the first completed pipeline actually ran on.
        mcpHint: 'Pre-wired to Exa web search (assisted) — the upstream reads arrive in the brief; the connector is what lets this role run unattended.',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'red-team',
        name: 'Red Team',
        blurb: 'Sends the document back until every number is sourced and the recommendation matches the evidence.',
        colorIndex: 0,
        customInstructions:
          'You are the last check before this document is used to pick a platform. Reply APPROVE or REVISE on the ' +
          'first line with a one-line reason. REVISE is a successful outcome for your job. Look for: a figure with ' +
          'no vendor doc behind it, a remembered-sounding number, a recommendation stronger than the evidence ' +
          'under it, an unspecified limit quietly filled in, and an independent finding that was dropped because ' +
          'it was inconvenient. Your note goes back to the author, so name the specific claim and what is missing. ' +
          'Judge only against the acceptance criteria; do not add new requirements between rounds.',
        // Same reason as the architect role above: without a connector this
        // reviewer hires as an un-runnable 'platform' agent. The document
        // under review arrives in the brief; exa lets the reviewer check
        // claims against sources — the role it played, passing grading, in
        // the first completed pipeline.
        mcpHint: 'Pre-wired to Exa web search (assisted) — the document arrives in the brief; the connector lets the reviewer verify claims and run unattended.',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
    ],
    pipeline: [
      {
        roleId: 'aws',
        title: 'AWS read — {scope}',
        brief:
          "Report what AWS's own current documentation says about hosting this workload:\n\n{scope}\n\nCover the " +
          'limits that decide whether it fits at all — execution duration, memory, concurrency, payload size, and ' +
          'the request-rate quotas — and for each say whether it is adjustable by quota increase or fixed. Quote ' +
          'the figure and name the page. Anything the documentation does not state, mark unspecified rather than ' +
          'estimating. Do not compare against other clouds.',
        acceptanceCriteria:
          'Every limit carries a figure quoted from AWS documentation with the page it came from, adjustable-vs-' +
          'fixed is stated for each, and anything the docs do not specify is marked unspecified rather than ' +
          'estimated. No comparison to another cloud.',
        // Short and subject-first: this is what the docs server actually
        // searches on, and the brief above would drown it. See
        // lib/mcp-client.ts's extractMcpQuery.
        mcpQuery:
          'AWS service quotas and limits for: {scope} — throughput, size, retention, concurrency, duration, pricing; which are adjustable',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'azure',
        title: 'Azure read — {scope}',
        brief:
          'Report what Microsoft Learn says about hosting this workload on Azure:\n\n{scope}\n\nCover execution ' +
          'duration, memory, concurrency/scale-out, payload size and request-rate limits, and name the plan or ' +
          'tier each figure belongs to — a limit that holds on one plan often does not hold on another. Quote the ' +
          'figure and name the page. Mark anything Learn does not state as unspecified. Do not compare against ' +
          'other clouds.',
        acceptanceCriteria:
          'Every limit carries a figure quoted from Microsoft Learn with its page and the plan or tier it applies ' +
          'to, and anything Learn does not specify is marked unspecified rather than estimated. No comparison to ' +
          'another cloud.',
        mcpQuery:
          'Azure service limits and quotas for: {scope} — throughput, size, retention, scale-out, timeout, per-tier quotas',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'cloudflare',
        title: 'Cloudflare read — {scope}',
        brief:
          "Report what Cloudflare's own developer documentation says about hosting this workload on Workers:\n\n" +
          '{scope}\n\nCover CPU time, wall-clock duration, memory, subrequest limits, request size and the ' +
          'per-plan differences. Where Cloudflare measures something on a different basis than a duration limit ' +
          'would suggest, say so plainly rather than converting it into a comparable-looking number. Quote the ' +
          'figure and name the page. Do not compare against other clouds.',
        acceptanceCriteria:
          'Every limit carries a figure quoted from Cloudflare documentation with its page and plan, any metric ' +
          'measured on a different basis than the others is called out as such rather than converted, and ' +
          'anything undocumented is marked unspecified. No comparison to another cloud.',
        mcpQuery:
          'Cloudflare limits and pricing for: {scope} — CPU time, duration, memory, subrequests, size, free vs paid plan',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'independent',
        title: 'Independent check — outside all three vendors',
        brief:
          'Find what sources the vendors do not control say about running this workload:\n\n{scope}\n\nReal ' +
          'measured cold starts, real bills at this scale, incident write-ups, migration reports. Every finding ' +
          'carries its source URL and date. Where you find nothing independent for a point, write "no independent ' +
          'source found" for it — do not substitute a vendor page, and do not fill the gap with something that ' +
          'sounds right.',
        acceptanceCriteria:
          'Every finding carries a source URL and a date and none of them is a vendor page for the vendor being ' +
          'checked; points with nothing independent behind them are written as "no independent source found" ' +
          'rather than filled in.',
        mcpQuery:
          'independent benchmark, real cost and production limits, AWS vs Azure vs Cloudflare, for: {scope}',
        dependsOnRoleIds: [],
        bountyWeight: 1,
      },
      {
        roleId: 'architect',
        title: 'Platform recommendation — {scope}',
        brief:
          'Write the decision document for this workload:\n\n{scope}\n\nOpen with a recommendation and the one ' +
          'requirement that drove it. Then the comparison, every figure naming the vendor doc it came from. Where ' +
          'the vendors measure something on different bases, say so rather than forcing a shared unit. Where the ' +
          'independent check contradicts a vendor claim, show both and say which you rely on and why. A limit the ' +
          'readers marked unspecified stays unspecified. Close with what would change the recommendation.',
        acceptanceCriteria:
          'Opens with one recommendation and the requirement that drove it; every figure in the comparison names ' +
          'the vendor document it came from; differently-measured metrics are called out rather than converted; ' +
          'each contradiction between a vendor claim and the independent check is shown with both sides and a ' +
          'stated choice; nothing marked unspecified upstream appears as a number; and it ends with what would ' +
          'change the recommendation.',
        dependsOnRoleIds: ['aws', 'azure', 'cloudflare', 'independent'],
        bountyWeight: 2,
      },
      {
        roleId: 'red-team',
        title: 'Red team — every number sourced before anyone picks a platform',
        brief:
          'Challenge the recommendation above. Reply APPROVE or REVISE on the first line with a one-line reason. ' +
          'Look for a figure with no vendor doc behind it, a number that reads as remembered rather than ' +
          'retrieved, a recommendation stronger than its evidence, an unspecified limit quietly filled in, and an ' +
          'independent finding dropped for being inconvenient. If you send it back, name the specific claim and ' +
          'what would fix it.',
        acceptanceCriteria:
          'Replies APPROVE or REVISE on the first line with a reason, and any REVISE names the specific claim at ' +
          'fault and what would fix it rather than asking for more rigour in general.',
        dependsOnRoleIds: ['architect'],
        reviewOfRoleId: 'architect',
        bountyWeight: 1,
      },
    ],
  },
  {
    // The marketing office, promoted from a hand-hired desk to a template —
    // and shaped by the one thing this platform can add to marketing that a
    // single copywriting model cannot: an ESCROW-ENFORCED claim check. Most
    // marketing copy fails in exactly one way — claims stronger than their
    // evidence — and most "review" of it is the author re-reading their own
    // work. Here the copywriter's bounty is held until an independent agent
    // rules on every factual claim, and a REVISE goes back to the copywriter
    // with the note (the same revision round-trip the diligence desk uses).
    // Hype dies in escrow, not in a style guide.
    //
    // The distributor's settlement split makes it a real agent-to-agent
    // economy: when the launch kit settles, cuts of that bounty move
    // on-chain to the copywriter and positioning analyst whose material it
    // repackaged — royalties, not a metaphor.
    id: 'growth-studio',
    name: 'Growth Studio',
    blurb:
      'Marketing whose claims survive a fact check. One agent researches what is actually defensible about the ' +
      'product, a copywriter turns it into launch copy, an independent claim red-team holds the copy’s escrow ' +
      'until every factual statement is either sourced or clearly labeled aspiration, and a distributor packages ' +
      'the approved copy per channel — paying the writers a cut when it settles.',
    flowSummary:
      'Positioning (researches, sources) → Copywriter (drafts) ⇄ Claim Red-Team (escrow-gated APPROVE/REVISE) → Distributor (channel kit; splits 15% to the copywriter, 10% to positioning).',
    exampleScope:
      'Handsel (https://handsel-main.vercel.app) — a labor market where AI agents hire, pay, and ' +
      'extend credit to other AI agents: on-chain escrow, independent grading, pay-only-on-pass, a signed proof ' +
      'per deliverable, and a credit score earned from real settled work. Audience: developers building AI agents ' +
      'and people following the agent-economy space. Goal: a launch-style post and landing copy that make the ' +
      'strongest claims the evidence actually supports, and not one claim more.',
    scopeLabel: 'What are we promoting? (product, link, audience, goal — the more specific the better)',
    roles: [
      {
        id: 'positioning',
        name: 'Positioning Analyst',
        blurb: 'Researches what is true and defensible about the product before anyone writes a word.',
        colorIndex: 4,
        customInstructions:
          'You research positioning, not adjectives. Establish from real sources what the product verifiably does, ' +
          'who else does something similar and how this differs, and which claims the evidence actually supports — ' +
          'each with its source URL. Sort your findings into DEFENSIBLE (sourced, checkable), ASPIRATIONAL (the ' +
          'product intends it but it is not demonstrated), and DO-NOT-CLAIM (contradicted or unverifiable). A ' +
          'short list of strong defensible claims is worth more than a long list of maybes — downstream, a ' +
          'red-team will strike anything you overstated.',
        mcpHint: 'Pre-wired to Exa web search (no key needed).',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'copywriter',
        name: 'Copywriter',
        blurb: 'Writes the launch copy — every factual claim traceable to the positioning brief.',
        colorIndex: 0,
        customInstructions:
          'You write marketing copy under one constraint that outranks style: every factual claim in your copy ' +
          'must trace to a DEFENSIBLE finding in the positioning brief, and anything from its ASPIRATIONAL list ' +
          'must read as intent ("built to", "designed for"), never as accomplished fact. Specific beats ' +
          'superlative — "escrow releases only on a passing grade" sells harder than "revolutionary". Your copy ' +
          'goes to an independent claim red-team that holds your bounty until it passes; a claim you cannot point ' +
          'to a source for will come back to you with a note, so write as if every sentence will be checked, ' +
          'because it will.',
        mcpHint: 'None needed — this role works from the positioning brief, not live data of its own.',
      },
      {
        id: 'claim-check',
        name: 'Claim Red-Team',
        blurb: 'Holds the copy’s escrow until every factual claim is sourced or clearly labeled aspiration.',
        colorIndex: 7,
        customInstructions:
          'You review marketing copy adversarially, and you are the reason this desk is trustworthy. Go claim by ' +
          'claim: a factual claim must trace to a DEFENSIBLE positioning finding (re-check the source yourself ' +
          'when in doubt); an aspirational statement must be worded as intent, not fact; a superlative must be ' +
          'either substantiated or struck. You are not editing for taste — voice and style are the copywriter’s ' +
          'call, truthfulness is yours. Finding a claim to send back is a successful outcome of your job, not a ' +
          'failure of politeness.',
        mcpHint: 'The same web-search tool as Positioning — re-checking a source needs independent access to it.',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'distributor',
        name: 'Distribution Planner',
        blurb: 'Turns the approved copy into a per-channel launch kit — and pays the writers a cut when it settles.',
        colorIndex: 8,
        customInstructions:
          'You package APPROVED copy for real channels — you never rewrite claims, only reshape length, tone and ' +
          'format per channel. Produce a concrete launch kit: which channels, in what order, what each post says ' +
          '(adapted from the approved copy, with each channel’s length and norms respected), and what to watch ' +
          'to know if it worked. If the red-team’s review struck something, it stays struck in every variant — ' +
          'reintroducing a rejected claim in a "shorter version" is the failure mode you exist to prevent.',
        mcpHint: 'None needed — this role works from the approved upstream deliverables.',
      },
    ],
    pipeline: [
      {
        roleId: 'positioning',
        title: 'Positioning — what can we defensibly claim about {scope}',
        brief:
          'Research the product below with your search tool and produce a positioning brief:\n\n{scope}\n\n' +
          'Sort every finding into DEFENSIBLE (with source URL), ASPIRATIONAL (intended, not demonstrated), or ' +
          'DO-NOT-CLAIM (contradicted or unverifiable). Name the closest alternatives and the sharpest honest ' +
          'differentiator. Do not write copy — write the ground truth copy will be held to.',
        acceptanceCriteria:
          'Every finding is sorted DEFENSIBLE / ASPIRATIONAL / DO-NOT-CLAIM; every DEFENSIBLE finding carries a ' +
          'source URL; at least one named alternative is compared honestly.',
        dependsOnRoleIds: [],
        bountyWeight: 2,
      },
      {
        roleId: 'copywriter',
        title: 'Launch copy — claims no stronger than the evidence',
        brief:
          'Write the launch copy for the scope using the positioning brief above: a launch-style announcement post ' +
          'and short landing-page copy (headline, subhead, three benefit blocks, call to action). Every factual ' +
          'claim traces to a DEFENSIBLE finding; ASPIRATIONAL items may appear only worded as intent; DO-NOT-CLAIM ' +
          'items appear nowhere. An independent red-team will check every sentence before your bounty releases.',
        acceptanceCriteria:
          'Contains a launch post and landing copy; every factual claim is traceable to a DEFENSIBLE positioning ' +
          'finding; no DO-NOT-CLAIM item appears; aspirational statements are worded as intent, not accomplished fact.',
        dependsOnRoleIds: ['positioning'],
        bountyWeight: 2,
      },
      {
        roleId: 'claim-check',
        title: 'Claim check — hype dies in escrow',
        brief:
          'Review the launch copy above claim by claim. Reply APPROVE or REVISE on the first line with a one-line ' +
          'reason. Look for: a factual claim with no DEFENSIBLE finding behind it, an aspirational statement ' +
          'worded as accomplished fact, a struck or DO-NOT-CLAIM item smuggled back in, and a superlative with ' +
          'nothing under it. If you send it back, quote the exact sentence at fault and say what wording the ' +
          'evidence would support.',
        acceptanceCriteria:
          'Replies APPROVE or REVISE on the first line with a reason, and any REVISE quotes the exact sentence at ' +
          'fault and the wording the evidence supports rather than asking for restraint in general.',
        dependsOnRoleIds: ['copywriter'],
        // The copy's escrow is held until this passes; a REVISE goes back to
        // the copywriter with the note — up to MAX_REVISION_ROUNDS.
        reviewOfRoleId: 'copywriter',
        bountyWeight: 1,
      },
      {
        roleId: 'distributor',
        title: 'Launch kit — the approved copy, per channel',
        brief:
          'Package the copy above into a concrete launch kit: channels in order, the adapted post for each ' +
          '(respecting each channel’s length and norms), and what to watch to know whether it worked. The copy ' +
          'you received already survived an independent claim check — reshape its form per channel, never its ' +
          'strength: no variant may state a claim more strongly than the copy does, and nothing absent from the ' +
          'copy may be added as fact.',
        acceptanceCriteria:
          'Names concrete channels in a stated order with an adapted post for each; no variant strengthens a claim ' +
          'beyond the upstream copy or adds a factual claim absent from it; ends with what to measure.',
        // Only the copywriter — and that is already the approval gate: a
        // reviewed step's output is RELEASED (lib/delegation.ts, doneOutputs)
        // only when its reviewer APPROVEs, so this step cannot start, or see
        // the copy, until the claim check passes. Depending on the review
        // step itself would be a first-in-any-template edge for no added
        // guarantee.
        dependsOnRoleIds: ['copywriter'],
        // Royalties, on-chain: when the kit settles, the writers whose
        // material it repackaged get their cut of THIS bounty.
        splitBpsByRoleId: { copywriter: 1500, positioning: 1000 },
        bountyWeight: 1,
      },
    ],
  },
  {
    // Venture Lab — idea generation with a kill filter attached.
    //
    // Business ideation is the single easiest thing to fake with an LLM: ask
    // for twenty startup ideas and you get twenty fluent paragraphs, none of
    // which anybody checked against a person who actually has the problem.
    // The generation is not the scarce part. The scarce part is the honest
    // NO — and a desk that only generates has no reason to say it.
    //
    // So the escrow does. The ideator's bounty is held by an independent Kill
    // Screen whose job is to find, for each idea, the strongest reason it
    // fails — already built, nobody pays, no distribution, regulated shut. It
    // is paid for the search, not for the verdict, so killing an idea costs
    // it nothing and letting a weak one through costs it its own grading.
    //
    // Everything upstream of the ideator is evidence, not brainstorming: the
    // Demand Scout looks for people describing a problem in their own words
    // and paying to work around it, with the URL. An idea traceable to a
    // stranger's complaint is a different object from an idea traceable to a
    // model's fluency, and only one of them survives the screen.
    id: 'venture-lab',
    name: 'Venture Lab',
    blurb:
      'Business ideas that survive an adversarial screen. A demand scout finds people describing a problem in ' +
      'their own words and paying to work around it, an ideator turns that evidence into ventures with a named ' +
      'buyer and a day-one revenue line, an independent kill screen holds the ideator’s escrow while it hunts ' +
      'for the reason each one fails, and a business case prices what survives — paying the scout and ideator a ' +
      'cut when it settles.',
    flowSummary:
      'Demand Scout (sourced evidence of unmet demand) → Venture Ideator (candidate ventures) ⇄ Kill Screen ' +
      '(escrow-gated APPROVE/REVISE — its job is to find the reason each fails) → Business Case (unit economics; ' +
      'splits 15% to the ideator, 10% to the scout).',
    exampleScope:
      'Solo developers and small teams building AI agents in 2026. Where do they lose time or money today, what ' +
      'do they pay for, and what are they hacking around with spreadsheets, cron jobs and Discord threads? Goal: ' +
      'ventures a two-person team could ship in a quarter and charge for in the same quarter — not platform bets ' +
      'that need a funding round before anyone can pay.',
    scopeLabel: 'Who are we finding ideas for? (the people, their world, and what counts as shippable — be specific)',
    roles: [
      {
        id: 'demand-scout',
        name: 'Demand Scout',
        blurb: 'Finds people describing the problem in their own words — and paying to work around it.',
        colorIndex: 4,
        customInstructions:
          'You look for evidence of demand, never for market-size figures. A market-size number is a fact about a ' +
          'report; a person writing "I built a script to do this every Monday because nothing does it" is a fact ' +
          'about demand. Hunt for the second kind: complaints, workarounds, job posts hiring for the manual ' +
          'version, threads asking for a tool that does not exist, and anything somebody is already paying for ' +
          'badly. Every finding carries its source URL and, where you can see it, what the person currently does ' +
          'instead and what that costs them. Sort findings into PAID (money already moves for a bad version), ' +
          'HACKED (they built their own workaround) and WISHED (asked for, nobody is doing anything about it) — ' +
          'the first two are worth far more than the third, and the difference is the whole brief.',
        mcpHint: 'Pre-wired to Exa web search (no key needed).',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'ideator',
        name: 'Venture Ideator',
        blurb: 'Turns sourced demand into ventures with a named buyer and a day-one revenue line.',
        colorIndex: 0,
        customInstructions:
          'You turn evidence into ventures, and you may not invent the evidence. Every idea you propose names the ' +
          'PAID or HACKED finding it comes from, the specific person who has the problem (a role, not "SMBs"), the ' +
          'wedge you would ship first, who writes the cheque and roughly what for, and why this is possible now ' +
          'and was not two years ago. Fewer, sharper ideas beat a long list — an independent kill screen holds ' +
          'your bounty while it hunts for the reason each one fails, so an idea you cannot defend is worse than an ' +
          'idea you did not submit. If the evidence only supports two real ventures, submit two and say so.',
        mcpHint: 'None needed — this role works from the demand brief, not live data of its own.',
      },
      {
        id: 'kill-screen',
        name: 'Kill Screen',
        blurb: 'Holds the ideator’s escrow while it hunts for the reason each idea fails.',
        colorIndex: 7,
        customInstructions:
          'You are paid to look for the reason each venture fails, and finding one is you doing your job well, not ' +
          'you being difficult. Take each idea and search: is it already built and shipping (name the product and ' +
          'link it), is anybody actually paying for this or only wishing, could the team reach these buyers at all ' +
          'or is distribution the real business, does a licence or regulation close it, and is the wedge a feature ' +
          'the incumbent ships next quarter. Judge each idea against the evidence it cites — an idea whose cited ' +
          'finding was WISHED rather than PAID or HACKED needs a much stronger reason to survive. Approve only ' +
          'what you genuinely could not kill, and say for each survivor what would have to stay true.',
        mcpHint: 'The same web-search tool as the scout — "is this already built?" cannot be answered from memory.',
        defaultConnector: {
          label: 'Exa web search',
          serverUrl: 'https://mcp.exa.ai/mcp',
          toolName: 'web_search_exa',
        },
      },
      {
        id: 'business-case',
        name: 'Business Case',
        blurb: 'Prices what survived — who pays, how much, what it costs to serve, what must be true.',
        colorIndex: 8,
        customInstructions:
          'You price the survivors and you never resurrect the dead. For each surviving venture write the case a ' +
          'sceptical partner would ask for: who the first ten customers are by name or by precise type, what they ' +
          'pay and how often, what it costs to serve one of them, how the first customer is reached without a ' +
          'budget, and the three things that would have to be true for this to work — each phrased so it could be ' +
          'checked in a week rather than believed. Where the numbers are estimates, say they are estimates and ' +
          'show the arithmetic. An idea the kill screen struck stays struck: reintroducing it inside a "broader ' +
          'opportunity" is the failure mode you exist to prevent.',
        mcpHint: 'None needed — this role works from the approved upstream deliverables.',
      },
    ],
    pipeline: [
      {
        roleId: 'demand-scout',
        title: 'Demand evidence — who is already paying, badly, for {scope}',
        brief:
          'Research the people below with your search tool and produce a demand brief:\n\n{scope}\n\n' +
          'Find them describing the problem in their own words. Sort every finding into PAID (money already moves ' +
          'for a bad version), HACKED (they built their own workaround) or WISHED (asked for, nothing exists), ' +
          'each with its source URL and, where visible, what they do instead today and what that costs them. Do ' +
          'not propose solutions — the evidence is the deliverable, and the ideas it has to survive come next.',
        acceptanceCriteria:
          'Every finding is sorted PAID / HACKED / WISHED and carries a source URL; at least one PAID or HACKED ' +
          'finding is present; no finding is a market-size figure standing in for a person; no solutions are proposed.',
        dependsOnRoleIds: [],
        bountyWeight: 2,
      },
      {
        roleId: 'ideator',
        title: 'Candidate ventures — each traceable to a real complaint',
        brief:
          'Propose the ventures the demand brief above actually supports. For each: the finding it comes from ' +
          '(quote it), the specific person with the problem, the wedge you would ship first, who pays and roughly ' +
          'what for on day one, and why now. Prefer few and defensible — an independent kill screen will hunt for ' +
          'the reason each one fails before your bounty releases, and an idea you cannot defend costs you more ' +
          'than an idea you left out.',
        acceptanceCriteria:
          'Every venture quotes the specific demand finding behind it, names a specific buyer rather than a ' +
          'segment, states a day-one revenue line, and answers why now; no venture rests on a finding absent from ' +
          'the brief.',
        dependsOnRoleIds: ['demand-scout'],
        bountyWeight: 2,
      },
      {
        roleId: 'kill-screen',
        title: 'Kill screen — the strongest reason each one fails',
        brief:
          'Screen the ventures above adversarially. Reply APPROVE or REVISE on the first line with a one-line ' +
          'reason. For each idea search for: it is already built and shipping (name and link it), nobody is ' +
          'actually paying (only wishing), distribution is the real business and the team has none, a licence or ' +
          'regulation closes it, or the wedge is a feature the incumbent ships next quarter. If you send it back, ' +
          'name the idea and the specific reason with your evidence — not a request for more rigour in general.',
        acceptanceCriteria:
          'Replies APPROVE or REVISE on the first line with a reason; each idea is screened against being already ' +
          'built, unpaid, undistributable, or closed by regulation, with links where the claim is that something ' +
          'exists; any REVISE names the idea and the specific killing reason; each survivor states what must stay true.',
        dependsOnRoleIds: ['ideator'],
        // The ideator's escrow is held until this passes; a REVISE goes back
        // to the ideator with the note — same gate the growth studio uses.
        reviewOfRoleId: 'ideator',
        bountyWeight: 1,
      },
      {
        roleId: 'business-case',
        title: 'Business case — what the survivors would cost and earn',
        brief:
          'Write the case for the ventures that survived the screen: first ten customers, price and cadence, cost ' +
          'to serve one, how the first customer is reached with no budget, and the three things that would have to ' +
          'be true — each checkable in a week. Estimates must be labelled as estimates with their arithmetic shown. ' +
          'Anything the screen struck stays struck.',
        acceptanceCriteria:
          'Covers only surviving ventures; each has first customers, price and cadence, cost to serve, a no-budget ' +
          'first-customer route, and three checkable must-be-trues; estimates are labelled and shown; no struck ' +
          'idea reappears.',
        // Only the ideator — which IS the approval gate: a reviewed step's
        // output reaches downstream (lib/delegation.ts, doneOutputs) only once
        // its reviewer APPROVEs, so this cannot start, or see the ventures,
        // until the kill screen passes.
        dependsOnRoleIds: ['ideator'],
        // Royalties, on-chain: the scout whose evidence and the ideator whose
        // ventures this prices get their cut of THIS bounty when it settles.
        splitBpsByRoleId: { ideator: 1500, 'demand-scout': 1000 },
        bountyWeight: 1,
      },
    ],
  }
]
