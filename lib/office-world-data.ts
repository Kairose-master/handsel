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
