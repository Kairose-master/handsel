'use server'

/**
 * Office connections — server actions for "visit another account's office
 * with a code." See lib/office.ts for what a connection actually means (a
 * discovery relationship, not an access grant — the market stays open).
 */
import { getSession } from '@/lib/get-session'
import { officeCodeFor, regenerateOfficeCode, redeemOfficeCode, connectedOfficesOf } from '@/lib/office'
import { buildOfficeSnapshot } from '@/lib/office-world-server'
import { OFFICE_TEMPLATES, type OfficeSnapshot } from '@/lib/office-world-data'
import { db } from '@/lib/db'
import { user, agent, delegation } from '@/lib/db/schema'
import { inArray, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { MIN_SUBTASK_BOUNTY_USD, type DelegationSubtask } from '@/lib/delegation'
import { fetchQuote, fetchHeadlines } from '@/lib/market-data'

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

/** The live pixel-office snapshot for my own account — real agent roster,
 *  real state (lib/office-world-data.ts). Polled by the /office page. */
export async function myOfficeWorld(): Promise<OfficeSnapshot> {
  const session = await requireUser()
  return buildOfficeSnapshot(session.user.id, session.user.name ?? 'Owner')
}

export type HireStaffInput = {
  name: string
  description?: string
  mcp?: { serverUrl: string; toolName: string; authHeader?: string }
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
  symbols: string
  budgetUsd: number
  /** Optional shared MCP server all opted-in roles connect through. */
  mcpServerUrl?: string
  mcpAuthHeader?: string
  /** roleId -> tool name, only for the roles the owner wants MCP-wired. Any
   *  role left out stays a plain platform agent — never a fabricated tool. */
  mcpToolNames?: Record<string, string>
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

  const symbols = input.symbols.trim()
  if (symbols.length < 2) return { error: 'List at least one ticker/symbol' }

  const [prime] = await db.select().from(agent).where(eq(agent.id, input.primeAgentId))
  if (!prime || prime.userId !== userId) return { error: 'Agent not found' }
  if (!prime.smartAccountAddress) return { error: 'Provision the prime agent first — it escrows the bounties' }

  const minBudget = template.pipeline.length * MIN_SUBTASK_BOUNTY_USD
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < minBudget) {
    return { error: `Budget must be at least $${minBudget} (roughly $${MIN_SUBTASK_BOUNTY_USD} per pipeline step)` }
  }

  const hired: HireOfficeTemplateResult['hired'] = []
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
      autoMine: true,
    })
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
    hired.push({ roleId: role.id, agentId, name, mcpConnected })
  }

  // Real, no-signup snapshots baked into the brief text so the pipeline
  // actually runs without anyone connecting an MCP server first — see
  // lib/market-data.ts's header. Best-effort per symbol: one bad ticker or
  // a flaky upstream degrades to a note in the brief, never blocks the hire.
  const symbolList = symbols.split(',').map((s) => s.trim()).filter(Boolean)
  const snapshotByRoleId = await buildDataSnapshots(symbolList)

  const perStep = Math.max(MIN_SUBTASK_BOUNTY_USD, Math.round((input.budgetUsd / template.pipeline.length) * 100) / 100)
  const titleByRoleId = new Map(template.pipeline.map((s) => [s.roleId, s.title.replaceAll('{symbols}', symbols)]))
  const subtasks: DelegationSubtask[] = template.pipeline.map((step) => {
    const snapshot = snapshotByRoleId.get(step.roleId)
    return {
      title: titleByRoleId.get(step.roleId)!,
      description: step.brief.replaceAll('{symbols}', symbols) + (snapshot ? `\n\n${snapshot}` : ''),
      acceptanceCriteria: step.acceptanceCriteria.replaceAll('{symbols}', symbols),
      bountyUsd: perStep,
      deliverableKind: 'text' as const,
      ...(step.dependsOnRoleIds.length
        ? { dependsOn: step.dependsOnRoleIds.map((rid) => titleByRoleId.get(rid)!) }
        : {}),
    }
  })

  const totalBounty = Math.round(subtasks.reduce((s, x) => s + x.bountyUsd, 0) * 100) / 100
  const delegationId = `dlg-${nanoid(10)}`
  await db.insert(delegation).values({
    id: delegationId,
    userId,
    primeAgentId: input.primeAgentId,
    task: `${template.name}: ${symbols}`,
    budgetUsd: totalBounty.toFixed(2),
    status: 'planned',
    subtasks,
    autoVerify: true,
  })

  revalidatePath('/office')
  revalidatePath('/delegate')
  return { delegationId, hired }
}
