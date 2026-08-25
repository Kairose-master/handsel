'use server'

/**
 * Office connections — server actions for "visit another account's office
 * with a code." See lib/office.ts for what a connection actually means (a
 * discovery relationship, not an access grant — the market stays open).
 */
import { getSession } from '@/lib/get-session'
import {
  officeCodeFor,
  regenerateOfficeCode,
  redeemOfficeCode,
  connectedOfficesOf,
  listOfficeSlots,
  createOfficeSlot,
  renameOfficeSlot,
  setAgentOfficeSlot,
  type OfficeSlot,
} from '@/lib/office'
import { buildOfficeSnapshot } from '@/lib/office-world-server'
import { OFFICE_TEMPLATES, type OfficeSnapshot } from '@/lib/office-world-data'
import { db } from '@/lib/db'
import { user, agent, delegation } from '@/lib/db/schema'
import { inArray, eq, and, isNotNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { MIN_SUBTASK_BOUNTY_USD, type DelegationSubtask } from '@/lib/delegation'
import { fetchQuote, fetchHeadlines } from '@/lib/market-data'

export type { OfficeSlot }

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

/** Every office on this account (at least one — slot 1 always exists), for
 *  the office-switcher tabs. */
export async function myOfficeSlots(): Promise<OfficeSlot[]> {
  const session = await requireUser()
  return listOfficeSlots(session.user.id)
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

async function uniqueAgentName(userId: string, base: string): Promise<string> {
  const existing = await db.select({ name: agent.name }).from(agent).where(eq(agent.userId, userId))
  const taken = new Set(existing.map((r) => r.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Real quote + headline snapshots, keyed by the role that consumes each —
 *  the zero-setup default for the Securities Office template's read-only
 *  roles. Never throws: a failed fetch becomes a plain-text note in the
 *  brief instead of blocking the hire. */
async function buildDataSnapshots(symbols: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (symbols.length === 0) return out

  const quoteLines: string[] = []
  for (const symbol of symbols) {
    try {
      const q = await fetchQuote(symbol)
      quoteLines.push(`${q.symbol}: ${q.price} ${q.currency} (prev close ${q.prevClose}, high ${q.dayHigh}, low ${q.dayLow}, volume ${q.volume}) as of ${q.asOf}`)
    } catch (error) {
      quoteLines.push(`${symbol}: live quote unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  out.set('chart-analyst', `Live data snapshot (fetched at hire time):\n${quoteLines.join('\n')}`)

  const newsLines: string[] = []
  for (const symbol of symbols) {
    try {
      const headlines = await fetchHeadlines(symbol, 3)
      if (headlines.length === 0) {
        newsLines.push(`${symbol}: no recent headlines found`)
      } else {
        newsLines.push(`${symbol}:`)
        for (const h of headlines) newsLines.push(`  - "${h.title}" — ${h.source}, ${h.pubDate} (${h.link})`)
      }
    } catch (error) {
      newsLines.push(`${symbol}: headline lookup unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  out.set('news-analyst', `Recent headlines (fetched at hire time):\n${newsLines.join('\n')}`)

  return out
}

export type HireOfficeTemplateInput = {
  templateId: string
  primeAgentId: string
  scope: string
  budgetUsd: number
  /** Optional shared MCP server all opted-in roles connect through. */
  mcpServerUrl?: string
  mcpAuthHeader?: string
  /** roleId -> tool name, only for the roles the owner wants MCP-wired. Any
   *  role left out stays a plain platform agent — never a fabricated tool. */
  mcpToolNames?: Record<string, string>
  officeSlot?: number
}

export type HireOfficeTemplateResult = {
  delegationId: string
  hired: Array<{ roleId: string; agentId: string; name: string; mcpConnected: boolean }>
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
  const userId = session.user.id

  const template = OFFICE_TEMPLATES.find((t) => t.id === input.templateId)
  if (!template) return { error: 'Unknown office template' }

  const scope = input.scope.trim()
  if (scope.length < 2) return { error: 'Describe what this office should deliver' }

  const [prime] = await db.select().from(agent).where(eq(agent.id, input.primeAgentId))
  if (!prime || prime.userId !== userId) return { error: 'Agent not found' }
  if (!prime.smartAccountAddress) return { error: 'Provision the prime agent first — it escrows the bounties' }

  const minBudget = template.pipeline.length * MIN_SUBTASK_BOUNTY_USD
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < minBudget) {
    return { error: `Budget must be at least $${minBudget} (roughly $${MIN_SUBTASK_BOUNTY_USD} per pipeline step)` }
  }

  // Only a role that actually appears as a pipeline step's worker should
  // autonomously claim jobs — a role that exists purely to collect a
  // settlement-split cut (Talent Agency's Agency Head/Scout) never delivers
  // anything itself, and autoMine would have it out competing for OTHER
  // people's jobs on the public board, the opposite of its whole point.
  const workingRoleIds = new Set(template.pipeline.map((s) => s.roleId))

  const hired: HireOfficeTemplateResult['hired'] = []
  const agentIdByRoleId = new Map<string, string>()
  for (const role of template.roles) {
    const name = await uniqueAgentName(userId, role.name)
    const agentId = nanoid()
    await db.insert(agent).values({
      id: agentId,
      userId,
      name,
      walletAddress: `0x${randomBytes(20).toString('hex')}`,
      description: role.blurb,
      customInstructions: role.customInstructions,
      modelVersion: 'claude-sonnet-5',
      creditScore: '0',
      creditRating: 'unrated',
      riskLevel: 'UNKNOWN',
      riskRating: 'unrated',
      totalCreditLine: '0',
      availableCredit: '0',
      autoMine: workingRoleIds.has(role.id),
    })
    await setAgentOfficeSlot(agentId, input.officeSlot ?? 1)
    await (await import('@/lib/agent-keys')).ensureAgentKey(agentId)

    let mcpConnected = false
    const toolName = input.mcpToolNames?.[role.id]?.trim()
    if (input.mcpServerUrl?.trim() && toolName) {
      try {
        const { setMcpWorker } = await import('@/app/actions/webhook')
        await setMcpWorker(agentId, {
          serverUrl: input.mcpServerUrl.trim(),
          toolName,
          authHeader: input.mcpAuthHeader?.trim() || undefined,
        })
        mcpConnected = true
      } catch (error) {
        console.error(`[office] hireOfficeTemplate: MCP connect failed for role ${role.id}:`, error)
      }
    }
    agentIdByRoleId.set(role.id, agentId)
    hired.push({ roleId: role.id, agentId, name, mcpConnected })
  }

  // Real, no-signup snapshots baked into the brief text so the pipeline
  // actually runs without anyone connecting an MCP server first — see
  // lib/market-data.ts's header. Best-effort per symbol: one bad ticker or
  // a flaky upstream degrades to a note in the brief, never blocks the hire.
  // Only meaningful for a market-data template (securities-desk) — a plain
  // task description elsewhere isn't a ticker list to look up.
  const snapshotByRoleId = template.usesMarketData
    ? await buildDataSnapshots(scope.split(',').map((s) => s.trim()).filter(Boolean))
    : new Map<string, string>()

  // Budget splits by weight (default 1 — equal split, unchanged for every
  // template that doesn't set one). A weight-2 step gets twice a weight-1
  // step's bounty out of the same total.
  const totalWeight = template.pipeline.reduce((s, step) => s + (step.bountyWeight ?? 1), 0)
  const unitUsd = input.budgetUsd / totalWeight
  const bountyForStep = (step: (typeof template.pipeline)[number]) =>
    Math.max(MIN_SUBTASK_BOUNTY_USD, Math.round(unitUsd * (step.bountyWeight ?? 1) * 100) / 100)
  const titleByRoleId = new Map(template.pipeline.map((s) => [s.roleId, s.title.replaceAll('{scope}', scope)]))
  const subtasks: DelegationSubtask[] = template.pipeline.map((step) => {
    const snapshot = snapshotByRoleId.get(step.roleId)
    // Settlement split (lib/settlement-split.ts): the OTHER hired roles named
    // in this step get a real on-chain cut of THIS step's worker's own
    // settled bounty — resolved to their real agentId now that every role is
    // hired. A role with no smart account yet still gets named (it'll just
    // provision before it can be paid) rather than silently dropped.
    const splitRecipients = step.splitBpsByRoleId
      ? Object.entries(step.splitBpsByRoleId)
          .map(([roleId, bps]) => {
            const recipientAgentId = agentIdByRoleId.get(roleId)
            return recipientAgentId ? { role: roleId, agentId: recipientAgentId, bps } : null
          })
          .filter((r): r is { role: string; agentId: string; bps: number } => r !== null)
      : []
    return {
      title: titleByRoleId.get(step.roleId)!,
      description: step.brief.replaceAll('{scope}', scope) + (snapshot ? `\n\n${snapshot}` : ''),
      acceptanceCriteria: step.acceptanceCriteria.replaceAll('{scope}', scope),
      bountyUsd: bountyForStep(step),
      deliverableKind: 'text' as const,
      // Reserve this step for the role it was written for — an office's own
      // hired worker does the office's own work, instead of racing whoever
      // else is watching the public board when the job posts.
      assignedAgentId: agentIdByRoleId.get(step.roleId),
      ...(step.dependsOnRoleIds.length
        ? { dependsOn: step.dependsOnRoleIds.map((rid) => titleByRoleId.get(rid)!) }
        : {}),
      ...(splitRecipients.length ? { splitSpec: { recipients: splitRecipients } } : {}),
    }
  })

  const totalBounty = Math.round(subtasks.reduce((s, x) => s + x.bountyUsd, 0) * 100) / 100
  const delegationId = `dlg-${nanoid(10)}`
  await db.insert(delegation).values({
    id: delegationId,
    userId,
    primeAgentId: input.primeAgentId,
    task: `${template.name}: ${scope}`,
    budgetUsd: totalBounty.toFixed(2),
    status: 'planned',
    subtasks,
    autoVerify: true,
  })

  revalidatePath('/office')
  revalidatePath('/delegate')
  return { delegationId, hired }
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
