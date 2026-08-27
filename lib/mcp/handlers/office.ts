/**
 * MCP tools — office.
 *
 * The office, back out through Handsel's own connector: hire a whole desk,
 * see who is in it and how each one is wired, rewire any of them, and set the
 * one document they all read — from inside Claude Code or ChatGPT.
 *
 * Two rules this group inherits and must not break.
 *
 * Nothing here moves money in one step. `hire_office` creates the agents and
 * drafts the delegation as 'planned'; `confirm_delegation` (the delegation
 * group) is the separate call that escrows. That is the same two-step shape
 * plan_delegation/confirm_delegation already has, and the reason an office is
 * safe to hire from a conversation.
 *
 * A handler answers only for tools it owns — returning null is what lets the
 * router try the next group.
 */
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'
import {
  OFFICE_TEMPLATES,
  MAX_OFFICE_SLOTS,
  officeStepBounties,
  defaultWiringFor,
  type McpConnector,
  type McpBinding,
} from '@/lib/office-world-data'
import { MAX_OFFICE_SOURCE_CHARS } from '@/lib/office-source-brief'

/** Resolve one of the caller's agents by id, then by name, then by "the first
 *  funded one" — the same precedence connect_mcp_worker uses, so an assistant
 *  that learned one tool's addressing does not have to relearn it here. */
async function resolveAgent(userId: string, args: Record<string, unknown>) {
  const agents = await db.select().from(agent).where(eq(agent.userId, userId))
  const wantedId = args.agent_id ? String(args.agent_id) : null
  const wantedName = args.agent_name ? String(args.agent_name) : null
  const found = wantedId
    ? agents.find((a) => a.id === wantedId)
    : wantedName
      ? agents.find((a) => a.name.toLowerCase() === wantedName.toLowerCase())
      : (agents.find((a) => a.smartAccountAddress) ?? agents[0])
  return { agents, found, wantedId, wantedName }
}

function parseSlot(args: Record<string, unknown>): number {
  const raw = Number(args.office ?? args.slot ?? 1)
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_OFFICE_SLOTS ? raw : 1
}

export async function handleOffice(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'list_office_templates': {
      const budget = (t: (typeof OFFICE_TEMPLATES)[number]) => t.pipeline.length * 2
      const lines = OFFICE_TEMPLATES.map((t) => {
        const bounties = officeStepBounties(t, budget(t))
        const wired = t.roles.filter((r) => r.defaultConnector)
        const steps = t.pipeline
          .map((s) => {
            const bits = [`$${bounties.get(s.roleId)!.toFixed(2)}`]
            if (s.dependsOnRoleIds.length) bits.push(`after ${s.dependsOnRoleIds.join(' + ')}`)
            if (s.reviewOfRoleId) bits.push(`REVIEWS ${s.reviewOfRoleId} — a REVISE goes back to that worker`)
            return `    · ${s.roleId}: ${s.title} (${bits.join(', ')})`
          })
          .join('\n')
        const connectors = wired.length
          ? wired
              .map((r) => `    · ${r.id} → ${r.defaultConnector!.toolName} on ${r.defaultConnector!.serverUrl}`)
              .join('\n')
          : '    (none — roles run as plain platform agents unless you wire them)'
        return (
          `${t.id} — ${t.name}\n  ${t.flowSummary}\n` +
          `  suggested budget: $${budget(t)}\n  example scope: ${t.exampleScope}\n` +
          `  steps:\n${steps}\n  pre-wired MCP connectors:\n${connectors}`
        )
      })
      return toolText(
        id,
        `${OFFICE_TEMPLATES.length} office templates. Hire one with hire_office (drafts only — ` +
          `confirm_delegation is what escrows).\n\n${lines.join('\n\n')}`,
      )
    }

    case 'hire_office': {
      const templateId = String(args.template_id ?? '').trim()
      const template = OFFICE_TEMPLATES.find((t) => t.id === templateId)
      if (!template) {
        return toolText(
          id,
          `Unknown template "${templateId}". Call list_office_templates for the ids.`,
          true,
        )
      }
      const scope = String(args.scope ?? '').trim()
      if (scope.length < 2) return toolText(id, 'scope is required — what this office should deliver.', true)

      // Hiring provisions one on-chain wallet per role. Rate-limited for the
      // same reason create_worker_agent is: a connector loop must not be able
      // to spend an account's gas on repeated desks.
      const { rateLimited } = await import('@/lib/rate-limit')
      if (rateLimited(auth.userId, { bucket: 'mcp-hire-office', windowMs: 30 * 60 * 1000, max: 3 })) {
        return toolText(id, 'Hiring offices too quickly — wait a few minutes.', true)
      }

      const { found: prime, agents, wantedId, wantedName } = await resolveAgent(auth.userId, {
        agent_id: args.prime_agent_id,
        agent_name: args.prime_agent_name,
      })
      if (!prime) {
        return toolText(
          id,
          agents.length === 0
            ? 'No agents on this account — create_worker_agent first; one of them escrows the bounties.'
            : wantedId
              ? `No agent with id "${wantedId}".`
              : `No agent named "${wantedName}".`,
          true,
        )
      }
      if (!prime.smartAccountAddress) {
        return toolText(id, `${prime.name} has no on-chain wallet yet, so it cannot escrow. Provision it first.`, true)
      }

      const budgetUsd = Number(args.budget_usd ?? template.pipeline.length * 2)
      const minBudget = template.pipeline.length
      if (!Number.isFinite(budgetUsd) || budgetUsd < minBudget) {
        return toolText(id, `budget_usd must be at least $${minBudget} for this template.`, true)
      }

      // Ship the template's own verified connectors unless the caller passed
      // their own. An office hired here should work for the same reason one
      // hired in the dashboard does.
      const wiring = defaultWiringFor(template)
      let mcpConnectors: McpConnector[] = wiring.connectors
      let mcpBindings: Record<string, McpBinding> = wiring.bindings
      if (Array.isArray(args.connectors) && args.connectors.length > 0) {
        mcpConnectors = []
        mcpBindings = {}
        for (const [i, raw] of (args.connectors as unknown[]).entries()) {
          const c = raw as Record<string, unknown>
          const roleId = String(c.role_id ?? '').trim()
          const serverUrl = String(c.server_url ?? '').trim()
          const toolName = String(c.tool_name ?? '').trim()
          if (!template.roles.some((r) => r.id === roleId)) {
            return toolText(id, `connectors[${i}]: "${roleId}" is not a role of ${template.id}.`, true)
          }
          if (!/^https:\/\//i.test(serverUrl)) return toolText(id, `connectors[${i}]: server_url must be https://`, true)
          if (!toolName) return toolText(id, `connectors[${i}]: tool_name is required.`, true)
          const connectorId = `c${i + 1}`
          mcpConnectors.push({
            id: connectorId,
            label: String(c.label ?? serverUrl),
            serverUrl,
            ...(c.auth_header ? { authHeader: String(c.auth_header) } : {}),
          })
          mcpBindings[roleId] = {
            connectorId,
            toolName,
            mode: c.mode === 'proxy' ? 'proxy' : 'assisted',
          }
        }
      }

      const { hireOfficeTemplateFor } = await import('@/lib/office-hire')
      const result = await hireOfficeTemplateFor(auth.userId, {
        templateId: template.id,
        primeAgentId: prime.id,
        scope,
        budgetUsd,
        mcpConnectors,
        mcpBindings,
        officeSlot: parseSlot(args),
      })
      if ('error' in result) return toolText(id, result.error, true)

      const roster = result.hired
        .map((h) => `  · ${h.name} (${h.roleId})${h.mcpConnected ? ' — MCP connected' : ''}`)
        .join('\n')

      // Which roles were SUPPOSED to end up wired. A hire that creates the
      // agents and connects none of them used to read as success: the summary
      // simply omitted "MCP connected" on every line, which is easy to miss
      // and impossible to act on. It is the difference between a desk that
      // reads live vendor docs and six agents answering from memory, so it is
      // stated, not implied.
      const shouldBeWired = new Set(Object.keys(mcpBindings))
      const unwired = result.hired.filter((h) => shouldBeWired.has(h.roleId) && !h.mcpConnected)
      const warning = unwired.length
        ? `\n\n⚠ ${unwired.length} of ${shouldBeWired.size} role(s) that should have an MCP connector came out UNWIRED: ` +
          `${unwired.map((h) => h.roleId).join(', ')}. They will run as plain platform agents answering from memory, ` +
          `which is the opposite of what this desk is for. Fix them with wire_office_agent (test_mcp_connector first) ` +
          `BEFORE confirm_delegation, or the escrow buys the wrong work.`
        : ''

      return toolText(
        id,
        `Hired ${result.hired.length} agents into office ${parseSlot(args)} and drafted the pipeline between them.\n` +
          `${roster}${warning}\n\n` +
          `NOTHING IS ESCROWED YET. delegation_id: ${result.delegationId}\n` +
          `Show the user delegation_status for it, and call confirm_delegation only after they approve — ` +
          `that is the call that moves USDC.`,
        unwired.length > 0,
      )
    }

    case 'office_roster': {
      const slot = parseSlot(args)
      const rows = await db
        .select({
          id: agent.id,
          name: agent.name,
          smartAccountAddress: agent.smartAccountAddress,
          autoMine: agent.autoMine,
          mcpServerUrl: agent.mcpServerUrl,
          mcpToolName: agent.mcpToolName,
        })
        .from(agent)
        .where(eq(agent.userId, auth.userId))
      const { officeSlotsByAgentId } = await import('@/lib/office')
      const slots = await officeSlotsByAgentId(rows.map((r) => r.id))
      const here = rows.filter((r) => slots.get(r.id) === slot)
      if (here.length === 0) return toolText(id, `Office ${slot} has no agents yet. hire_office puts a desk in it.`)

      const { getMcpModes } = await import('@/lib/mcp-mode')
      const modes = await getMcpModes(here.filter((r) => r.mcpServerUrl).map((r) => r.id))
      const lines = here.map((a) => {
        const bits = [a.smartAccountAddress ? 'funded wallet' : 'no wallet']
        if (a.autoMine) bits.push('auto-mine')
        if (a.mcpServerUrl && a.mcpToolName) {
          bits.push(
            `${a.mcpToolName} on ${a.mcpServerUrl} (${
              modes.get(a.id) === 'assisted' ? 'writes from what the tool returns' : "submits the tool's output as-is"
            })`,
          )
        } else {
          bits.push('platform agent')
        }
        return `- ${a.name} [${a.id}] · ${bits.join(' · ')}`
      })

      const { getOfficeSource } = await import('@/lib/office')
      const source = await getOfficeSource(auth.userId, slot)
      const sourceLine = source
        ? `\n\nShared source: "${source.title || 'untitled'}" (${source.body.length} chars) — every role hired from now on reads it.`
        : '\n\nNo shared source set. set_office_source gives every role in this office one document to work from.'
      return toolText(id, `Office ${slot}:\n${lines.join('\n')}${sourceLine}`)
    }

    case 'set_office_source': {
      const slot = parseSlot(args)
      const body = typeof args.body === 'string' ? args.body : ''
      const title = String(args.title ?? '').slice(0, 120)
      const { setOfficeSource } = await import('@/lib/office')
      const clipped = body.slice(0, MAX_OFFICE_SOURCE_CHARS)
      await setOfficeSource(auth.userId, slot, title, clipped)
      if (!clipped.trim()) return toolText(id, `Cleared the shared source for office ${slot}.`)
      return toolText(
        id,
        `Shared source set for office ${slot} (${clipped.length} chars${
          clipped.length < body.length ? `, cut from ${body.length} at the ${MAX_OFFICE_SOURCE_CHARS} cap` : ''
        }). It is injected into every role's brief when you hire — it does NOT rewrite an office already hired, ` +
          `because a brief that changed under a posted job would move the target its worker is graded against.`,
      )
    }

    case 'wire_office_agent': {
      const serverUrl = String(args.server_url ?? '').trim()
      const toolName = String(args.tool_name ?? '').trim()
      if (!/^https:\/\//i.test(serverUrl)) return toolText(id, 'server_url must start with https://', true)
      if (!toolName) return toolText(id, 'tool_name is required.', true)
      const { found, agents, wantedId, wantedName } = await resolveAgent(auth.userId, args)
      if (!found) {
        return toolText(
          id,
          agents.length === 0 ? 'No agents on this account yet.' : wantedId ? `No agent with id "${wantedId}".` : `No agent named "${wantedName}".`,
          true,
        )
      }
      const mode = args.mode === 'proxy' ? 'proxy' : 'assisted'
      // The lib, not the server action: an action reads the caller from the
      // session cookie, which an MCP request does not have.
      const { setMcpWorkerFor } = await import('@/lib/mcp-worker-wiring')
      await setMcpWorkerFor(auth.userId, found.id, {
        serverUrl,
        toolName,
        authHeader: args.auth_header ? String(args.auth_header) : undefined,
        mode,
      })
      return toolText(
        id,
        `${found.name} now calls ${toolName} on ${serverUrl}, and ${
          mode === 'assisted' ? 'writes its deliverable from what comes back' : "submits that tool's output as its deliverable"
        }.` +
          (mode === 'proxy'
            ? ' Note: a SEARCH tool in this mode submits a result dump, which fails any acceptance criterion about quoting sources — use assisted for those.'
            : ''),
      )
    }

    case 'test_mcp_connector': {
      const serverUrl = String(args.server_url ?? '').trim()
      const toolName = String(args.tool_name ?? '').trim()
      if (!/^https:\/\//i.test(serverUrl)) return toolText(id, 'server_url must start with https://', true)
      if (!toolName) return toolText(id, 'tool_name is required.', true)
      try {
        const { probeMcpTool, pickToolArgumentKey } = await import('@/lib/mcp-client')
        const tool = await probeMcpTool({
          serverUrl,
          toolName,
          authHeader: args.auth_header ? String(args.auth_header) : null,
        })
        if (!tool) return toolText(id, `Connected to ${serverUrl}, but it advertises no tool called "${toolName}".`, true)
        const argKey = pickToolArgumentKey(tool.inputSchema)
        const required = ((tool.inputSchema as { required?: string[] } | undefined)?.required ?? []).filter(
          (r) => r !== argKey,
        )
        return toolText(
          id,
          `${toolName} is reachable on ${serverUrl}.\n` +
            `A job would arrive in its "${argKey}" argument.\n` +
            (required.length
              ? `WARNING: it also requires ${required.join(', ')}, which a Handsel worker cannot supply — ` +
                `the call sends exactly one string. This tool will fail as a worker.`
              : 'It takes a single string, so it works as a worker.') +
            (tool.description ? `\n\n${tool.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''),
        )
      } catch (error) {
        return toolText(id, `Could not reach it: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    }

    default:
      return null
  }
}
