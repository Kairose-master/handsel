/**
 * Hiring a whole office template — the core, with no session in it.
 *
 * Lifted out of app/actions/office.ts unchanged so the MCP connector
 * (lib/mcp/handlers/office.ts) can hire an office too. A server action
 * resolves the caller from the session and must never take a userId from its
 * argument — that is forgeable — so the action stays the thin wrapper that
 * calls requireUser() and this takes the id it resolved.
 *
 * The types live in lib/office-world-data.ts rather than here, because the
 * hire dialog needs them and this module imports the database. A 'use server'
 * module must also never re-export an imported type: the transform leaves a
 * runtime reference behind and every action in the file throws
 * (tests/server-action-type-reexport.test.ts).
 */
import { db } from '@/lib/db'
import { agent, delegation } from '@/lib/db/schema'
import { inArray, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { randomBytes } from 'crypto'
import { MIN_SUBTASK_BOUNTY_USD, type DelegationSubtask } from '@/lib/delegation'
import { fetchQuote, fetchHeadlines } from '@/lib/market-data'
import { setAgentOfficeSlot, getOfficeSource } from '@/lib/office'
import { briefWithOfficeSource } from '@/lib/office-source-brief'
import {
  OFFICE_TEMPLATES,
  officeStepBounties,
  resolveRoleConnector,
  type McpConnector,
  type HireOfficeTemplateInput,
  type HireOfficeTemplateResult,
} from '@/lib/office-world-data'

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

export async function hireOfficeTemplateFor(
  userId: string,
  input: HireOfficeTemplateInput,
): Promise<HireOfficeTemplateResult | { error: string }> {

  const template = OFFICE_TEMPLATES.find((t) => t.id === input.templateId)
  if (!template) return { error: 'Unknown office template' }

  const scope = input.scope.trim()
  if (scope.length < 2) return { error: 'Describe what this office should deliver' }

  const [prime] = await db.select().from(agent).where(eq(agent.id, input.primeAgentId))
  if (!prime || prime.userId !== userId) return { error: 'Agent not found' }
  if (!prime.smartAccountAddress) return { error: 'Provision the prime agent first — it escrows the bounties' }

  // Per-step payers. Validated here so a bad pick is a form error the user
  // can fix, rather than a throw at confirm time — but this is convenience,
  // not the security boundary: postDelegationJobs re-checks ownership of
  // every payer against the delegation owner because the stored plan is
  // jsonb and can be edited in between.
  const payerIds = [...new Set(Object.values(input.payerByRoleId ?? {}).map((id) => id.trim()).filter(Boolean))]
  const payerById = new Map<string, { id: string; name: string; provisioned: boolean }>()
  if (payerIds.length) {
    const rows = await db
      .select({ id: agent.id, name: agent.name, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
      .from(agent)
      .where(inArray(agent.id, payerIds))
    for (const r of rows) {
      if (r.userId !== userId) continue
      payerById.set(r.id, { id: r.id, name: r.name, provisioned: Boolean(r.smartAccountAddress) })
    }
    for (const id of payerIds) {
      const found = payerById.get(id)
      if (!found) return { error: 'A step names a paying agent that is not on this account' }
      if (!found.provisioned) {
        return { error: `Provision ${found.name} before it can pay for a step — it escrows that step's bounty` }
      }
    }
  }

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

  const mcpConnectors: McpConnector[] = input.mcpConnectors ?? []

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

    // Each role resolves its OWN connector, so one office can run several at
    // once. A binding that names a connector which isn't in the list, or
    // carries no tool name, is skipped — never silently pointed at some
    // other role's server.
    let mcpConnected = false
    const wiring = resolveRoleConnector(mcpConnectors, input.mcpBindings, role.id)
    if (wiring) {
      try {
        // The lib, never the server action. hireOfficeTemplateFor runs on BOTH
        // surfaces, and an action resolves its caller from the session cookie —
        // which the MCP path does not have. Called that way it threw
        // Unauthorized into the catch below, so hire_office created six agents
        // and silently wired none of them: every reader came out a plain
        // platform agent answering from memory, which is the exact failure this
        // desk exists to prevent.
        const { setMcpWorkerFor } = await import('@/lib/mcp-worker-wiring')
        await setMcpWorkerFor(userId, agentId, wiring)
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
  // step's bounty out of the same total. The arithmetic lives in
  // lib/office-world-data.ts so the hire dialog shows the same numbers this
  // escrows — a person picking who pays for which step is reading real
  // amounts, not a second implementation of them.
  const bountyByRoleId = officeStepBounties(template, input.budgetUsd)
  const titleByRoleId = new Map(template.pipeline.map((s) => [s.roleId, s.title.replaceAll('{scope}', scope)]))
  // The one document every role in this office reads. Resolved once, here,
  // so a step's brief is fixed at hire time — see lib/office.ts's
  // ensureOfficeSourceTable comment for why editing it later must not rewrite
  // an office already hired.
  const sharedSource = await getOfficeSource(userId, input.officeSlot ?? 1)

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
      description: briefWithOfficeSource(
        step.brief.replaceAll('{scope}', scope) +
          (snapshot ? `\n\n${snapshot}` : '') +
          // The query a tool-backed worker sends instead of the whole brief.
          // Position doesn't matter — extractMcpQuery scans line by line, and
          // the marker and its query share one line — so this survives the
          // shared source being appended after it and the collaboration DSL
          // being prepended before it. An LLM worker just sees a line naming
          // what to look up.
          (step.mcpQuery ? `\n\n[mcp-query] ${step.mcpQuery.replaceAll('{scope}', scope)}` : ''),
        sharedSource,
      ),
      acceptanceCriteria: step.acceptanceCriteria.replaceAll('{scope}', scope),
      bountyUsd: bountyByRoleId.get(step.roleId)!,
      deliverableKind: 'text' as const,
      // Reserve this step for the role it was written for — an office's own
      // hired worker does the office's own work, instead of racing whoever
      // else is watching the public board when the job posts.
      assignedAgentId: agentIdByRoleId.get(step.roleId),
      // A review always depends on what it reviews, whether or not the
      // template said so — a reviewer posted before its target delivers has
      // nothing to read. Deduped, so naming it in both places is harmless.
      ...(() => {
        const deps = [
          ...new Set(
            [...step.dependsOnRoleIds, ...(step.reviewOfRoleId ? [step.reviewOfRoleId] : [])].map(
              (rid) => titleByRoleId.get(rid)!,
            ),
          ),
        ]
        return deps.length ? { dependsOn: deps } : {}
      })(),
      // Peer review (lib/delegation.ts ②): the reviewed step's escrow is held
      // until this one approves, and a REVISE goes back to that step's own
      // worker with the note rather than to a human.
      ...(step.reviewOfRoleId ? { reviewOf: titleByRoleId.get(step.reviewOfRoleId)! } : {}),
      ...(splitRecipients.length ? { splitSpec: { recipients: splitRecipients } } : {}),
      // Absent = the prime pays, exactly as before per-step payers existed.
      ...(payerById.has(input.payerByRoleId?.[step.roleId] ?? '')
        ? { payerAgentId: input.payerByRoleId![step.roleId] }
        : {}),
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

  return { delegationId, hired }
}
