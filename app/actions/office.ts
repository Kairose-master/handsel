'use server'

/**
 * Office connections — server actions for "visit another account's office
 * with a code." See lib/office.ts for what a connection actually means (a
 * discovery relationship, not an access grant — the market stays open).
 */
import { getSession } from '@/lib/get-session'
import {
  officeSlotsByAgentId,
  officeCodeFor,
  regenerateOfficeCode,
  redeemOfficeCode,
  connectedOfficesOf,
  listOfficeSlots,
  createOfficeSlot,
  renameOfficeSlot,
  setAgentOfficeSlot,
  getOfficeSource,
  setOfficeSource,
  type StoredOfficeSource,
} from '@/lib/office'
import { MAX_OFFICE_SOURCE_CHARS } from '@/lib/office-source-brief'
import { buildOfficeSnapshot } from '@/lib/office-world-server'
import { buildOfficeTreasury, type OfficeTreasuryView } from '@/lib/office-treasury'
import { buildCompanyTreasury } from '@/lib/company-treasury'
import type { CompanyTreasuryView } from '@/lib/office-world-data'
import {
  MAX_OFFICE_SLOTS,
  type HireOfficeTemplateInput,
  type HireOfficeTemplateResult,
  type OfficeSnapshot,
  type OfficeSlot,
} from '@/lib/office-world-data'
import { db } from '@/lib/db'
import { user, agent } from '@/lib/db/schema'
import { inArray, eq, and, isNotNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { hireOfficeTemplateFor } from '@/lib/office-hire'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

/** My shareable code — generated on first call, stable after that. */
export async function myOfficeCode(): Promise<string> {
  const session = await requireUser()
  return officeCodeFor(session.user.id)
}

/** Invalidate my current code and issue a new one. */
export async function newOfficeCode(): Promise<string> {
  const session = await requireUser()
  return regenerateOfficeCode(session.user.id)
}

export type VisitResult =
  | { connected: true; ownerName: string }
  | { connected: false; reason: 'unknown-code' | 'self' }

/** Redeem someone else's code — connects our two offices. */
export async function visitOffice(code: string): Promise<VisitResult> {
  const session = await requireUser()
  const trimmed = code.trim()
  if (!trimmed) return { connected: false, reason: 'unknown-code' }
  const result = await redeemOfficeCode(trimmed, session.user.id)
  if (!result.connected) return result
  const [owner] = await db.select({ name: user.name }).from(user).where(inArray(user.id, [result.ownerId]))
  return { connected: true, ownerName: owner?.name ?? 'a connected office' }
}

export type ConnectedOffice = { userId: string; name: string }

/** Every office connected to mine, for the visit list. */
export async function myConnectedOffices(): Promise<ConnectedOffice[]> {
  const session = await requireUser()
  const ids = await connectedOfficesOf(session.user.id)
  if (ids.length === 0) return []
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r.name]))
  // Preserve connectedOfficesOf's most-recent-first order even though the
  // IN-clause read doesn't.
  return ids.map((id) => ({ userId: id, name: byId.get(id) ?? 'Unnamed office' }))
}

/** The live pixel-office snapshot for one of my offices (see
 *  myOfficeSlots) — real agent roster, real state (lib/office-world-data.ts).
 *  Polled by the /office page. */
export async function myOfficeWorld(slot: number): Promise<OfficeSnapshot> {
  const session = await requireUser()
  return buildOfficeSnapshot(session.user.id, session.user.name ?? 'Owner', slot)
}

/** The real Treasury numbers for one of my offices — this office's own
 *  agent wallets summed, plus the market contract's own solvency and fee
 *  balance (lib/office-treasury.ts). Fetched on demand (Treasury room
 *  selected), not polled with the rest of the snapshot — on-chain balance
 *  reads across every agent wallet plus the market contract are heavier
 *  than the roster poll and only matter while someone is actually looking
 *  at the room. */
export async function myOfficeTreasury(slot: number): Promise<OfficeTreasuryView> {
  const session = await requireUser()
  return buildOfficeTreasury(session.user.id, slot)
}

/** The account-wide "Company HQ" HUD — every office's agents combined, plus
 *  the account's own local-paymaster gas pool (lib/company-treasury.ts).
 *  Not office-scoped: the gas pool is one per account by design (see that
 *  file's header), and "the company" means every office this account has,
 *  never other accounts'. */
export async function myCompanyTreasury(): Promise<CompanyTreasuryView> {
  const session = await requireUser()
  return buildCompanyTreasury(session.user.id)
}

/** Every office on this account (at least one — slot 1 always exists), for
 *  the office-switcher tabs. */
export async function myOfficeSlots(): Promise<OfficeSlot[]> {
  const session = await requireUser()
  return listOfficeSlots(session.user.id)
}

/** One office's Automaton mandate: whether it is on, what it has spent in
 *  the current window against what it may, and the recent audit trail. The
 *  panel view — everything here is real state, nothing is derived client-side. */
export type OfficeAutomatonView = {
  enabled: boolean
  spentUsd: number
  budgetUsd: number
  floorUsd: number
  actions: Array<{ id: string; agentName: string; kind: string; amountUsd: number; txHash: string | null; note: string | null; at: string }>
}

export async function myOfficeAutomaton(slot: number): Promise<OfficeAutomatonView> {
  const session = await requireUser()
  const { getOfficeAutomaton, automatonSpentInWindow, automatonActions, AUTOMATON_WINDOW_BUDGET_USD, AUTOMATON_BOND_FLOOR_USD } =
    await import('@/lib/office-automaton')
  const [mandate, spentUsd, actions] = await Promise.all([
    getOfficeAutomaton(session.user.id, slot),
    automatonSpentInWindow(session.user.id, slot),
    automatonActions(session.user.id, slot, 8),
  ])
  // Resolve agent ids to names for the log — an audit trail an owner has to
  // decode by hand is barely an audit trail.
  const ids = [...new Set(actions.map((a) => a.agentId))]
  const names = ids.length
    ? await db.select({ id: agent.id, name: agent.name }).from(agent).where(inArray(agent.id, ids))
    : []
  const nameOf = new Map(names.map((n) => [n.id, n.name]))
  return {
    enabled: mandate?.enabled ?? false,
    spentUsd,
    budgetUsd: AUTOMATON_WINDOW_BUDGET_USD,
    floorUsd: AUTOMATON_BOND_FLOOR_USD,
    actions: actions.map(({ agentId, ...a }) => ({ ...a, agentName: nameOf.get(agentId) ?? agentId })),
  }
}

/** Grant or revoke this office's Automaton mandate. Revoking keeps the log. */
export async function setMyOfficeAutomaton(slot: number, enabled: boolean): Promise<{ ok: true }> {
  const session = await requireUser()
  const { setOfficeAutomaton } = await import('@/lib/office-automaton')
  await setOfficeAutomaton(session.user.id, slot, enabled)
  return { ok: true }
}

/** Add a new office, up to lib/office.ts's MAX_OFFICE_SLOTS. */
export async function newOfficeSlot(name: string): Promise<{ slot: number } | { error: string }> {
  const session = await requireUser()
  return createOfficeSlot(session.user.id, name)
}

/** Rename an existing office (slot 1's "Main Office" included — it's just
 *  a default, not a fixed name). */
export async function renameOffice(slot: number, name: string): Promise<{ ok: true } | { error: string }> {
  const session = await requireUser()
  return renameOfficeSlot(session.user.id, slot, name)
}

export type HireStaffInput = {
  name: string
  description?: string
  mcp?: { serverUrl: string; toolName: string; authHeader?: string }
  officeSlot?: number
}

/**
 * "Hire staff" — one call for the two-step create-then-wire flow the
 * profile page's Runtime card otherwise makes you do by hand: createAgent,
 * then (only if an external MCP server was given) setMcpWorker to point it
 * there. Handsel is called by that server exactly at claim/submit time —
 * this action only ever registers the address, never polls it.
 *
 * If the MCP step fails (bad URL, server unreachable) the agent still
 * exists as an ordinary platform agent rather than disappearing — a half
 * "hire" should degrade to the safe default, not vanish.
 */
export async function hireStaff(input: HireStaffInput): Promise<{ id: string; mcpConnected: boolean }> {
  const { createAgent } = await import('@/app/actions/agents')
  const created = await createAgent({ name: input.name, description: input.description })
  await setAgentOfficeSlot(created.id, input.officeSlot ?? 1)
  if (!input.mcp) return { id: created.id, mcpConnected: false }

  try {
    const { setMcpWorker } = await import('@/app/actions/webhook')
    await setMcpWorker(created.id, input.mcp)
    return { id: created.id, mcpConnected: true }
  } catch (error) {
    console.error('[office] hireStaff: MCP connect failed, agent kept as a platform agent:', error)
    return { id: created.id, mcpConnected: false }
  }
}


/**
 * Hire an entire office template — several role agents at once, plus the
 * delegation pipeline that wires them together. See lib/office-world-data.ts's
 * OFFICE_TEMPLATES header for the two things this deliberately does not do:
 * escrow real money without a review step, and execute real trades.
 *
 * The delegation is saved 'planned' only — the same safe two-step pattern
 * every hand-authored plan on /delegate goes through. Confirming it (which
 * escrows the bounties for real) is a separate, explicit action on that page.
 */
export async function hireOfficeTemplate(
  input: HireOfficeTemplateInput,
): Promise<HireOfficeTemplateResult | { error: string }> {
  const session = await requireUser()
  const result = await hireOfficeTemplateFor(session.user.id, input)
  revalidatePath('/office')
  revalidatePath('/delegate')
  return result
}

/**
 * The account's agents, for the office hire dialog's paying-agent picker.
 *
 * This duplicates getDelegationAgents rather than importing it, on purpose.
 * That one lives in app/actions/delegate.ts, whose module graph pulls in
 * lib/delegation → the Anthropic SDK and the whole on-chain layer; a dialog
 * that only needs id/name/provisioned should not be able to fail because
 * something unrelated in that graph did. Selecting three columns explicitly
 * also avoids `select().from(agent)`'s implicit full column list, which
 * throws whenever schema.ts declares a column the database has not been
 * migrated to yet — the incident class documented at the top of
 * lib/db/ensure-columns.ts.
 */
export async function officeHireAgents(): Promise<Array<{ id: string; name: string; provisioned: boolean }>> {
  const session = await requireUser()
  const rows = await db
    .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, session.user.id))
  return rows.map((a) => ({ id: a.id, name: a.name, provisioned: Boolean(a.smartAccountAddress) }))
}

export type OfficeRosterAgent = {
  id: string
  name: string
  provisioned: boolean
  runtimeType: string | null
  autoMine: boolean
  mcpServerUrl: string | null
  mcpToolName: string | null
  /** How this agent uses its tool — see lib/mcp-assist.ts. */
  mcpMode: 'proxy' | 'assisted'
  /** Native ETH in the agent's account, as ether. Null when the read failed —
   *  distinct from 0, which means the agent genuinely cannot pay for gas on a
   *  deployment that sponsors none. */
  ethBalance: number | null
  /** Whether an Authorization header is stored. The value itself is never
   *  returned — it is encrypted at rest and only decrypted server-side at
   *  dispatch time (app/actions/webhook.ts). */
  hasAuthHeader: boolean
}

/**
 * The roster behind the office dashboard: who is in this office and how each
 * one is wired.
 *
 * Connectors were previously only settable while hiring, which meant a typo
 * in a server URL, a rotated token or an ngrok address that changed all
 * required deleting the agent. The wiring is per-agent in the database and
 * setMcpWorker/disconnectMcpWorker already exist and are owner-checked — they
 * were simply never surfaced here.
 *
 * Columns are selected explicitly: `select().from(agent)` expands to every
 * column schema.ts declares and throws the moment one has not been migrated
 * yet (lib/db/ensure-columns.ts's header).
 */
export async function officeRoster(slot: number): Promise<OfficeRosterAgent[]> {
  const session = await requireUser()
  const rows = await db
    .select({
      id: agent.id,
      name: agent.name,
      smartAccountAddress: agent.smartAccountAddress,
      runtimeType: agent.runtimeType,
      autoMine: agent.autoMine,
      mcpServerUrl: agent.mcpServerUrl,
      mcpToolName: agent.mcpToolName,
      mcpAuthHeaderEnc: agent.mcpAuthHeaderEnc,
    })
    .from(agent)
    .where(eq(agent.userId, session.user.id))
  const slotByAgentId = await officeSlotsByAgentId(rows.map((r) => r.id))
  const kept = rows.filter((r) => slotByAgentId.get(r.id) === slot)
  const { getMcpModes } = await import('@/lib/mcp-mode')
  const modeByAgentId = await getMcpModes(kept.filter((r) => r.mcpServerUrl).map((r) => r.id))

  // ETH per provisioned agent. Read together rather than per-row so one slow
  // RPC doesn't serialise the whole roster, and settled individually so one
  // failure reports as unknown instead of blanking every balance.
  const { ethBalanceOf } = await import('@/lib/onchain/treasury')
  const funded = kept.filter((r) => r.smartAccountAddress)
  const ethResults = await Promise.allSettled(
    funded.map((r) => ethBalanceOf(r.smartAccountAddress as `0x${string}`)),
  )
  const ethByAgentId = new Map<string, number | null>(
    funded.map((r, i) => {
      const res = ethResults[i]
      return [r.id, res.status === 'fulfilled' ? res.value : null]
    }),
  )

  return kept
    .map((r) => ({
      id: r.id,
      name: r.name,
      provisioned: Boolean(r.smartAccountAddress),
      runtimeType: r.runtimeType,
      autoMine: Boolean(r.autoMine),
      mcpServerUrl: r.mcpServerUrl,
      mcpToolName: r.mcpToolName,
      hasAuthHeader: Boolean(r.mcpAuthHeaderEnc),
      mcpMode: modeByAgentId.get(r.id) ?? 'proxy',
      ethBalance: r.smartAccountAddress ? (ethByAgentId.get(r.id) ?? null) : null,
    }))
}

/**
 * Actually call an MCP server and report whether the named tool is there.
 *
 * Before this, a connector's first proof of life was a job that had already
 * escrowed money and came back empty — a typo in a URL, a tool renamed
 * upstream, or a token that expired were all indistinguishable from a worker
 * that did the work badly. probeMcpTool already did the handshake for imported
 * agents; this just makes it reachable from the office, before the hire.
 *
 * Owner-agnostic on purpose: it takes a URL the caller typed and connects to
 * it, which any logged-in user could do from their own machine anyway. It is
 * still behind requireUser so it is not an open proxy, and it returns only
 * what the handshake said — never the response body of a tool call, which it
 * does not make.
 */
export async function testMcpConnector(
  serverUrl: string,
  toolName: string,
  authHeader?: string,
): Promise<{ ok: true; argKey: string; description: string | null } | { ok: false; error: string }> {
  await requireUser()
  const url = serverUrl.trim()
  const tool = toolName.trim()
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'The server URL must start with https://' }
  if (!tool) return { ok: false, error: 'Name the tool to call on that server' }
  try {
    const { probeMcpTool, pickToolArgumentKey } = await import('@/lib/mcp-client')
    const found = await probeMcpTool({ serverUrl: url, toolName: tool, authHeader: authHeader?.trim() || null })
    if (!found) return { ok: false, error: `Connected, but that server advertises no tool called "${tool}"` }
    return {
      ok: true,
      argKey: pickToolArgumentKey(found.inputSchema),
      description: found.description?.replace(/\s+/g, ' ').slice(0, 160) ?? null,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach that server' }
  }
}

export type OfficeSourceView = StoredOfficeSource & { maxChars: number }

/** This office's shared source, for the office dashboard. */
export async function officeSource(slot: number): Promise<OfficeSourceView | null> {
  const session = await requireUser()
  const stored = await getOfficeSource(session.user.id, slot)
  return stored ? { ...stored, maxChars: MAX_OFFICE_SOURCE_CHARS } : null
}

/**
 * Write or clear this office's shared source.
 *
 * Truncated to MAX_OFFICE_SOURCE_CHARS here rather than rejected: the brief
 * carries the whole document once per pipeline step, and silently accepting
 * a document only to have it cut at injection time would mean what the owner
 * saved and what the workers read were different things. Cutting on save
 * makes the stored text the true text, and the dialog shows the count.
 */
export async function saveOfficeSource(
  slot: number,
  title: string,
  body: string,
): Promise<{ ok: true; truncated: boolean } | { error: string }> {
  const session = await requireUser()
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_OFFICE_SLOTS) return { error: 'Unknown office' }
  const clipped = body.slice(0, MAX_OFFICE_SOURCE_CHARS)
  await setOfficeSource(session.user.id, slot, title.slice(0, 120), clipped)
  revalidatePath('/office')
  return { ok: true, truncated: clipped.length < body.length }
}

/** Real, DB-backed progress for the "wiring a real MCP tool" tutorial
 *  (/office/mcp-guide) — a live check, not a step the user just self-reports.
 *  True the moment ANY of this account's agents has a server + tool name set,
 *  same fields hireStaff/hireOfficeTemplate/setMcpWorker write. */
export async function mcpGuideProgress(): Promise<{ hasMcpAgent: boolean }> {
  const session = await requireUser()
  const [row] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.userId, session.user.id), isNotNull(agent.mcpServerUrl), isNotNull(agent.mcpToolName)))
    .limit(1)
  return { hasMcpAgent: Boolean(row) }
}
