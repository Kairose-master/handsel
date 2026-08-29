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
import { formatEther } from 'viem'
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
        freshAgents: args.fresh_agents === true,
      })
      if ('error' in result) return toolText(id, result.error, true)

      const roster = result.hired
        .map(
          (h) =>
            `  · ${h.name} (${h.roleId})${h.reused ? ' — already in this office, kept its wallet' : ' — new hire'}` +
            `${h.mcpConnected ? ' · MCP connected' : ''}`,
        )
        .join('\n')

      // Which roles were SUPPOSED to end up wired. A hire that creates the
      // agents and connects none of them used to read as success: the summary
      // simply omitted "MCP connected" on every line, which is easy to miss
      // and impossible to act on. It is the difference between a desk that
      // reads live vendor docs and six agents answering from memory, so it is
      // stated, not implied.
      const shouldBeWired = new Set(Object.keys(mcpBindings))
      const unwired = result.hired.filter((h) => shouldBeWired.has(h.roleId) && !h.mcpConnected)
      const unprovisioned = result.hired.filter((h) => !h.provisioned)
      const warnings: string[] = []
      if (unwired.length) {
        warnings.push(
          `⚠ ${unwired.length} of ${shouldBeWired.size} role(s) that should have an MCP connector came out UNWIRED: ` +
            `${unwired.map((h) => h.roleId).join(', ')}. They will run as plain platform agents answering from memory, ` +
            `which is the opposite of what this desk is for. Fix them with wire_office_agent (test_mcp_connector first).`,
        )
      }
      if (unprovisioned.length) {
        // Worth as much noise as an unwired connector: auto-mine refuses an
        // agent with no smart account, so the job reserved for this role sits
        // until the reservation lapses and is then taken by whoever is
        // watching the public board.
        warnings.push(
          `⚠ ${unprovisioned.length} role(s) have NO on-chain wallet: ${unprovisioned.map((h) => h.roleId).join(', ')}. ` +
            `An agent without one cannot claim even the job reserved for it, so the escrow would end up with some ` +
            `other worker entirely. Provision them before confirming.`,
        )
      }
      const warning = warnings.length ? `\n\n${warnings.join('\n\n')}\n\nFIX THESE BEFORE confirm_delegation — the escrow buys the wrong work otherwise.` : ''

      return toolText(
        id,
        `Hired ${result.hired.length} agents into office ${parseSlot(args)} and drafted the pipeline between them.\n` +
          `${roster}${warning}\n\n` +
          `NOTHING IS ESCROWED YET. delegation_id: ${result.delegationId}\n` +
          `Show the user delegation_status for it, and call confirm_delegation only after they approve — ` +
          `that is the call that moves USDC.`,
        warnings.length > 0,
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

      // Balances, not just addresses. This line used to read "funded wallet"
      // for any agent that had an address at all, which is how a desk of ten
      // agents holding $0 each looked completely healthy while every one of
      // them was structurally unable to claim a job. An agent needs BOTH: ETH
      // for gas and USDC for the bond that accepting stakes.
      const { usdcBalanceOf, ethBalanceOfWei } = await import('@/lib/onchain/treasury')
      const { bondScheduleOf } = await import('@/lib/onchain/labor-v2')
      const { AGENT_GAS_FLOOR } = await import('@/lib/onchain/account')
      const { bondForBounty } = await import('@/lib/agent-bond')
      const { readJobs } = await import('@/lib/onchain/labor')
      // `null` for a read that FAILED, `[]` for a market with nothing open.
      // Collapsing the two would make an RPC blip report the flat bond as the
      // requirement — understating what a worker needs, on the exact surface
      // an owner consults to find out. That is invariant 10 in
      // docs/failure-modes.md, and this line is where it would have been
      // broken again.
      const [schedule, jobs] = await Promise.all([
        bondScheduleOf().catch(() => null),
        readJobs().catch(() => null),
      ])
      // Size the check against the CHEAPEST open job: an agent that cannot
      // afford even that one is out of the market entirely, which is the
      // statement worth making. With nothing open, the flat bond is the floor
      // and still worth reporting; with nothing READ, there is no honest
      // number and the line says so instead of inventing one.
      const openBounties = jobs?.filter((j) => j.status === 'Open').map((j) => j.bounty) ?? null
      const cheapestBond =
        schedule === null || openBounties === null
          ? null
          : openBounties.length
            ? Math.min(...openBounties.map((b) => bondForBounty(b, schedule)))
            : schedule.flat
      const balances = new Map<string, { usd: number | null; wei: bigint | null }>()
      await Promise.all(
        here
          .filter((a) => a.smartAccountAddress)
          .map(async (a) => {
            const addr = a.smartAccountAddress as `0x${string}`
            const [usd, wei] = await Promise.all([
              usdcBalanceOf(addr).catch(() => null),
              ethBalanceOfWei(addr).catch(() => null),
            ])
            balances.set(a.id, { usd, wei })
          }),
      )

      const lines = here.map((a) => {
        const bal = balances.get(a.id)
        const bits: string[] = []
        if (!a.smartAccountAddress) {
          bits.push('NO WALLET — provision_office gives it one')
        } else {
          const usd = bal?.usd
          const wei = bal?.wei
          const gasBad = wei !== null && wei !== undefined && wei < AGENT_GAS_FLOOR
          const bondBad =
            usd !== null && usd !== undefined && cheapestBond !== null && Math.round(usd * 1e6) < Math.round(cheapestBond * 1e6)
          const money = usd === null || usd === undefined ? 'USDC unreadable' : `$${usd.toFixed(4)} USDC`
          if (gasBad && bondBad)
            bits.push(
              `${money} · CANNOT WORK: no gas (fund_agent_eth) and cannot post the $${cheapestBond!.toFixed(4)} bond (fund_agent_usdc)`,
            )
          else if (bondBad) bits.push(`${money} · CANNOT CLAIM: needs $${cheapestBond!.toFixed(4)} to stake the bond — fund_agent_usdc`)
          else if (gasBad) bits.push(`${money} · CANNOT TRANSACT: out of gas ETH — fund_agent_eth`)
          else if (cheapestBond === null) bits.push(`${money} · bond requirement unreadable — cannot say if it can claim`)
          else bits.push(`${money} · ready`)
        }
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
        ? `\n\nShared source: "${source.title || 'untitled'}" (${source.body.length} chars)` +
          (source.sourceUrl
            ? ` — snapshot of ${source.sourceUrl}, fetched ${source.fetchedAt ?? 'at an unrecorded time'}`
            : ' — typed in, no origin document') +
          `. Every role hired from now on reads it.`
        : '\n\nNo shared source set. set_office_source gives every role in this office one document to work from.'
      return toolText(id, `Office ${slot}:\n${lines.join('\n')}${sourceLine}`)
    }

    case 'provision_office': {
      const slot = parseSlot(args)
      const rows = await db
        .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
        .from(agent)
        .where(eq(agent.userId, auth.userId))
      const { officeSlotsByAgentId } = await import('@/lib/office')
      const slots = await officeSlotsByAgentId(rows.map((r) => r.id))
      const here = rows.filter((r) => slots.get(r.id) === slot)
      const missing = here.filter((r) => !r.smartAccountAddress)
      if (here.length === 0) return toolText(id, `Office ${slot} has no agents.`, true)
      if (missing.length === 0) {
        return toolText(id, `Every agent in office ${slot} already has an on-chain account.`)
      }

      const { provisionAgentAccount, agentGasReadiness } = await import('@/lib/agent-provision')
      const done: string[] = []
      const failed: string[] = []
      const unfunded: string[] = []
      for (const a of missing) {
        const res = await provisionAgentAccount(auth.userId, a.id)
        if (res.ok) {
          // A failed credit mirror is a footnote, not a failure: the account
          // exists and the agent can claim.
          done.push(`${a.name} → ${res.address}${res.mirrorFailed ? ' (credit mirror deferred)' : ''}`)
          // An address is not the ability to use one. Where the deployment
          // sponsors no gas, a fresh account holds nothing and cannot accept
          // even a job escrowed for it.
          const gas = await agentGasReadiness(res.address)
          if (!gas.ready) unfunded.push(`${a.name} → ${gas.address}`)
        } else {
          failed.push(`${a.name}: ${res.reason}${res.detail ? ` (${res.detail.slice(0, 120)})` : ''}`)
        }
      }
      return toolText(
        id,
        [
          done.length ? `Provisioned ${done.length}:\n${done.map((d) => `  · ${d}`).join('\n')}` : '',
          failed.length
            ? `\nStill without a wallet — these cannot claim work, including jobs reserved for them:\n` +
              failed.map((f) => `  · ${f}`).join('\n')
            : '',
          unfunded.length
            ? `\n⚠ ${unfunded.length} agent(s) have an address but NO ETH, and this deployment sponsors no gas — ` +
              `they cannot accept a job, including one already escrowed for them. Send a little ETH to each ` +
              `(0.00005 is the floor; 0.0002 covers a working session):\n` +
              unfunded.map((u) => `  · ${u}`).join('\n')
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        failed.length > 0 || unfunded.length > 0,
      )
    }

    case 'set_office_source': {
      const slot = parseSlot(args)
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      let body = typeof args.body === 'string' ? args.body : ''
      let title = String(args.title ?? '').slice(0, 120)
      let provenance: { sourceUrl: string; fetchedAt: string; contentHash: string } | undefined

      if (url) {
        if (body.trim()) return toolText(id, 'Pass a url or a body, not both — otherwise which one is the source?', true)
        const { fetchOfficeSource } = await import('@/lib/office-source-fetch')
        const fetched = await fetchOfficeSource(url)
        if (!fetched.ok) return toolText(id, `${fetched.code}: ${fetched.error}`, true)
        body = fetched.body
        // The caller's title wins if given — a page's <title> is often
        // navigation furniture rather than what the document is.
        title = title || fetched.title
        provenance = { sourceUrl: fetched.finalUrl, fetchedAt: fetched.fetchedAt, contentHash: fetched.contentHash }
      }

      const { setOfficeSource } = await import('@/lib/office')
      const clipped = body.slice(0, MAX_OFFICE_SOURCE_CHARS)
      // The hash must describe what was STORED. Hashing the fetched text and
      // then storing a clipped version would make the recorded fingerprint
      // describe a document nobody has.
      if (provenance && clipped.length < body.length) {
        const { createHash } = await import('node:crypto')
        provenance = { ...provenance, contentHash: `0x${createHash('sha256').update(clipped).digest('hex')}` }
      }
      await setOfficeSource(auth.userId, slot, title, clipped, provenance)
      if (!clipped.trim()) return toolText(id, `Cleared the shared source for office ${slot}.`)

      const origin = provenance
        ? `\nFetched from ${provenance.sourceUrl} at ${provenance.fetchedAt}.\nFingerprint ${provenance.contentHash.slice(0, 18)}… — this is a SNAPSHOT, not a live link. ` +
          `Re-run this call to pick up changes; the fingerprint tells you whether anything moved.`
        : ''
      return toolText(
        id,
        `Shared source set for office ${slot} (${clipped.length} chars${
          clipped.length < body.length ? `, cut from ${body.length} at the ${MAX_OFFICE_SOURCE_CHARS} cap` : ''
        }).${origin}\n\nIt is injected into every role's brief when you hire — it does NOT rewrite an office already hired, ` +
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

    case 'withdraw_agent_eth': {
      const { found, agents, wantedId, wantedName } = await resolveAgent(auth.userId, args)
      if (!found) {
        return toolText(
          id,
          agents.length === 0 ? 'No agents on this account yet.' : wantedId ? `No agent with id "${wantedId}".` : `No agent named "${wantedName}".`,
          true,
        )
      }
      const { withdrawAgentEth, parseEthAmount, ETH_WITHDRAW_RESERVE_WEI } = await import('@/lib/agent-eth-withdraw')
      let requestedWei: bigint | undefined
      if (args.amount_eth !== undefined) {
        const parsed = parseEthAmount(String(args.amount_eth))
        if (parsed === null) return toolText(id, 'amount_eth must be a plain positive decimal, e.g. "0.001".', true)
        requestedWei = parsed
      }
      const res = await withdrawAgentEth(auth.userId, found.id, {
        requestedWei,
        drain: args.drain === true,
      })
      if (!res.ok) return toolText(id, res.error, true)
      const sent = Number(res.amountWei) / 1e18
      return toolText(
        id,
        `Sent ${sent} ETH from ${found.name} to your payout address ${res.to}.\ntx ${res.txHash}` +
          (args.drain === true
            ? `\n\nDrained: ${found.name} kept nothing and cannot transact again until it is funded.`
            : `\n\n${Number(ETH_WITHDRAW_RESERVE_WEI) / 1e18} ETH stayed behind so it can still work. Pass drain to take that too.`),
      )
    }

    case 'fund_agent_usdc': {
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      if (agents.length < 2) return toolText(id, 'Funding moves USDC between two of your agents; this account has fewer than two.', true)

      const toId = args.to_agent_id ? String(args.to_agent_id) : null
      const toName = args.to_agent_name ? String(args.to_agent_name) : null
      const to = toId
        ? agents.find((a) => a.id === toId)
        : toName
          ? agents.find((a) => a.name.toLowerCase() === toName.toLowerCase())
          : null
      if (!to) return toolText(id, toId ? `No agent with id "${toId}".` : toName ? `No agent named "${toName}".` : 'Say which agent to fund (to_agent_id or to_agent_name).', true)

      const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
      let from = args.from_agent_id ? agents.find((a) => a.id === String(args.from_agent_id)) : undefined
      if (args.from_agent_id && !from) return toolText(id, `No agent with id "${String(args.from_agent_id)}".`, true)
      if (!from) {
        // Default to whoever can actually pay. Making the caller name a funder
        // means knowing which wallet holds the balance, which is the thing
        // they came here to stop having to track.
        const funded = await Promise.all(
          agents
            .filter((a) => a.smartAccountAddress && a.id !== to.id)
            .map(async (a) => ({ a, usd: await usdcBalanceOf(a.smartAccountAddress as `0x${string}`).catch(() => 0) })),
        )
        funded.sort((x, y) => y.usd - x.usd)
        from = funded[0]?.a
        if (!from || funded[0].usd <= 0) return toolText(id, 'No agent on this account holds any USDC to fund with.', true)
      }

      const { fundAgentUsdc, parseUsdcAmount, suggestedFloatFor } = await import('@/lib/agent-usdc-funding')
      let amountUsd: number | null = null
      if (args.amount_usdc !== undefined) {
        amountUsd = parseUsdcAmount(String(args.amount_usdc))
        if (amountUsd === null) return toolText(id, 'amount_usdc must be a plain positive decimal, e.g. "0.25".', true)
      } else {
        // No amount given: send exactly the float this agent needs for the
        // work actually open to it right now. A guessed round number either
        // strands money in a worker or leaves it one cent short again.
        const { bondScheduleOf } = await import('@/lib/onchain/labor-v2')
        const { readJobs } = await import('@/lib/onchain/labor')
        const [schedule, jobs] = await Promise.all([
          bondScheduleOf().catch(() => null),
          readJobs().catch(() => null), // null = read failed; [] = nothing open
        ])
        if (!schedule) return toolText(id, 'Could not read the bond schedule from the market contract, so I cannot size the transfer. Pass amount_usdc.', true)
        if (jobs === null) return toolText(id, 'Could not read the job board, so I cannot size the transfer. Pass amount_usdc.', true)
        const openBounties = jobs.filter((j) => j.status === 'Open').map((j) => j.bounty)
        if (openBounties.length === 0) return toolText(id, 'No open jobs right now, so there is no bond float to size against. Pass amount_usdc.', true)
        amountUsd = suggestedFloatFor(openBounties, schedule)
      }

      const res = await fundAgentUsdc(auth.userId, from.id, to.id, { amountUsd, drain: args.drain === true })
      if (!res.ok) return toolText(id, res.error, true)
      return toolText(
        id,
        `Sent $${res.amountUsd.toFixed(4)} USDC from ${res.from} to ${res.to}.\ntx ${res.txHash}\n\n` +
          `${res.to} can now stake bonds and claim work. Accepting a job locks the bond until it settles, then returns it.`,
      )
    }

    case 'fund_agent_eth': {
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      if (agents.length < 2) return toolText(id, 'Funding moves ETH between two of your agents; this account has fewer than two.', true)

      const toId = args.to_agent_id ? String(args.to_agent_id) : null
      const toName = args.to_agent_name ? String(args.to_agent_name) : null
      const to = toId
        ? agents.find((a) => a.id === toId)
        : toName
          ? agents.find((a) => a.name.toLowerCase() === toName.toLowerCase())
          : null
      if (!to) {
        return toolText(
          id,
          toId
            ? `No agent with id "${toId}".`
            : toName
              ? `No agent named "${toName}".`
              : 'Say which agent to fund (to_agent_id or to_agent_name).',
          true,
        )
      }

      const { ethBalanceOfWei } = await import('@/lib/onchain/treasury')
      let from = args.from_agent_id ? agents.find((a) => a.id === String(args.from_agent_id)) : undefined
      if (args.from_agent_id && !from) return toolText(id, `No agent with id "${String(args.from_agent_id)}".`, true)
      if (!from) {
        // Default to whoever can actually pay. Requiring the caller to name a
        // funder means knowing which wallet holds the gas, which is the thing
        // they opened this tool to stop tracking.
        const funded = await Promise.all(
          agents
            .filter((a) => a.smartAccountAddress && a.id !== to.id)
            .map(async (a) => ({
              a,
              wei: await ethBalanceOfWei(a.smartAccountAddress as `0x${string}`).catch(() => 0n),
            })),
        )
        funded.sort((x, y) => (y.wei > x.wei ? 1 : y.wei < x.wei ? -1 : 0))
        from = funded[0]?.a
        if (!from || funded[0].wei <= 0n) return toolText(id, 'No agent on this account holds any ETH to fund with.', true)
      }

      const { fundAgentEth, parseEthAmount, ETH_FUNDING_RESERVE_WEI } = await import('@/lib/agent-eth-funding')
      let requestedWei: bigint | undefined
      if (args.amount_eth !== undefined) {
        const parsed = parseEthAmount(String(args.amount_eth))
        if (parsed === null) return toolText(id, 'amount_eth must be a plain positive decimal, e.g. "0.0002".', true)
        requestedWei = parsed
      }

      const res = await fundAgentEth(auth.userId, from.id, to.id, { requestedWei, drain: args.drain === true })
      if (!res.ok) return toolText(id, res.error, true)
      const sent = formatEther(BigInt(res.amountWei))
      return toolText(
        id,
        `Sent ${sent} ETH from ${res.from} to ${res.to} (${res.toAddress}).\ntx ${res.txHash}\n\n` +
          `${res.to} can now pay for its own gas.` +
          (args.drain === true
            ? `\n\nDrained: ${res.from} kept nothing and cannot transact again until it is funded.`
            : `\n\n${formatEther(ETH_FUNDING_RESERVE_WEI)} ETH stayed with ${res.from} so it can still work.`),
      )
    }

    case 'set_gas_pool': {
      const {
        getGasPool,
        setGasPool,
        disableGasPool,
        sponsoredInWindow,
        LOCAL_GAS_WINDOW_BUDGET_WEI,
        LOCAL_GAS_TARGET_WEI,
      } = await import('@/lib/local-paymaster')

      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wantedName = args.agent_name ? String(args.agent_name) : null

      // No agent named and no explicit disable: this is a read, not a write.
      if (!wantedId && !wantedName && args.enabled === undefined) {
        const current = await getGasPool(auth.userId)
        const spent = await sponsoredInWindow(auth.userId)
        if (!current) {
          return toolText(
            id,
            'No gas pool set on this account. Name one of your agents and every other agent of yours gets topped up ' +
              'out of it when it runs out of ETH — your own ether, between your own wallets.',
          )
        }
        const src = agents.find((a) => a.id === current.sourceAgentId)
        return toolText(
          id,
          `Gas pool: ${src?.name ?? current.sourceAgentId} — ${current.enabled ? 'ON' : 'off'}\n` +
            `Sponsored in the last 24h: ${formatEther(spent)} of ${formatEther(LOCAL_GAS_WINDOW_BUDGET_WEI)} ETH\n` +
            `Each top-up brings an agent to ${formatEther(LOCAL_GAS_TARGET_WEI)} ETH.`,
        )
      }

      if (!wantedId && !wantedName && args.enabled === false) {
        await disableGasPool(auth.userId)
        return toolText(id, 'Gas pool switched off. Agents that run out of ETH will stop until you fund them.')
      }

      const target = wantedId
        ? agents.find((a) => a.id === wantedId)
        : agents.find((a) => a.name.toLowerCase() === (wantedName ?? '').toLowerCase())
      if (!target) {
        return toolText(id, wantedId ? `No agent with id "${wantedId}".` : `No agent named "${wantedName}".`, true)
      }
      if (!target.smartAccountAddress) {
        return toolText(id, `${target.name} has no on-chain account, so it holds no ETH to pay gas out of.`, true)
      }

      const enabled = args.enabled !== false
      await setGasPool(auth.userId, target.id, enabled)
      if (!enabled) return toolText(id, `Gas pool is ${target.name}, currently switched off.`)

      const { ethBalanceOfWei } = await import('@/lib/onchain/treasury')
      const held = await ethBalanceOfWei(target.smartAccountAddress as `0x${string}`).catch(() => null)
      const balanceLine =
        held === null
          ? "\n\nCould not read its balance just now."
          : `\n\n${target.name} holds ${formatEther(held)} ETH. Keep it funded and the rest of the desk keeps working.`
      return toolText(
        id,
        `${target.name} is now this account's gas pool. Any other agent of yours that runs out of ETH is topped up ` +
          `to ${formatEther(LOCAL_GAS_TARGET_WEI)} out of it, up to ${formatEther(LOCAL_GAS_WINDOW_BUDGET_WEI)} ETH a ` +
          `day across the whole account.${balanceLine}`,
      )
    }

    case 'set_office_automaton': {
      const {
        getOfficeAutomaton,
        setOfficeAutomaton,
        automatonSpentInWindow,
        automatonActions,
        AUTOMATON_WINDOW_BUDGET_USD,
        AUTOMATON_BOND_FLOOR_USD,
      } = await import('@/lib/office-automaton')
      const slot = parseSlot(args)

      // No enabled argument: this is a read, not a write — same convention
      // as set_gas_pool above.
      if (args.enabled === undefined) {
        const [mandate, spent, actions] = await Promise.all([
          getOfficeAutomaton(auth.userId, slot),
          automatonSpentInWindow(auth.userId, slot),
          automatonActions(auth.userId, slot, 5),
        ])
        if (!mandate) {
          return toolText(
            id,
            `Office ${slot} has no Automaton mandate. Call with enabled:true and it keeps that desk claim-ready by ` +
              `itself: any of its workers holding under $${AUTOMATON_BOND_FLOOR_USD.toFixed(2)} of bond float gets ` +
              `topped up out of your own richest agent, at most $${AUTOMATON_WINDOW_BUDGET_USD.toFixed(2)} a day, ` +
              `every move logged.`,
          )
        }
        const agents = await db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.userId, auth.userId))
        const nameOf = new Map(agents.map((a) => [a.id, a.name]))
        const log = actions.length
          ? '\nRecent actions:\n' +
            actions
              .map(
                (a) =>
                  `  · ${a.at.slice(0, 16)} ${a.kind} $${a.amountUsd.toFixed(2)} → ${nameOf.get(a.agentId) ?? a.agentId}` +
                  (a.txHash ? ` (tx ${a.txHash.slice(0, 10)}…)` : a.note?.startsWith('FAILED') ? ' — FAILED' : ''),
              )
              .join('\n')
          : '\nNo actions yet.'
        return toolText(
          id,
          `Office ${slot} Automaton: ${mandate.enabled ? 'ON' : 'off'}\n` +
            `Moved in the last 24h: $${spent.toFixed(2)} of $${AUTOMATON_WINDOW_BUDGET_USD.toFixed(2)}\n` +
            `Workers are kept at $${AUTOMATON_BOND_FLOOR_USD.toFixed(2)} bond float.${log}`,
        )
      }

      const enabled = args.enabled !== false
      await setOfficeAutomaton(auth.userId, slot, enabled)
      return toolText(
        id,
        enabled
          ? `Office ${slot} Automaton is ON. The desk keeps itself claim-ready: workers under ` +
              `$${AUTOMATON_BOND_FLOOR_USD.toFixed(2)} bond float are topped up from your own richest agent, at most ` +
              `$${AUTOMATON_WINDOW_BUDGET_USD.toFixed(2)} a day, only ever between your own wallets, every move ` +
              `logged. Call this tool with no arguments to read the log.`
          : `Office ${slot} Automaton switched off. The log is kept; workers that run short will stay short until ` +
              `you fund them or switch it back on.`,
      )
    }

    case 'lineage_report': {
      const { buildLineageReport } = await import('@/lib/agent-lineage-server')
      const slot = args.office === undefined ? undefined : parseSlot(args)
      const report = await buildLineageReport(auth.userId, slot)
      if (report.rows.length === 0) {
        return toolText(id, slot === undefined ? 'This account has no agents yet.' : `Office ${slot} has no agents.`)
      }
      const lines = report.rows.map((r) => {
        const rate = r.graded.passRate === null ? 'ungraded' : `${Math.round(r.graded.passRate * 100)}%`
        const held = r.heldUsd === null ? 'balance unreadable' : `$${r.heldUsd.toFixed(2)}`
        return (
          `- ${r.decision.action.toUpperCase()} (${r.decision.why}) · ${r.name} · gen ${r.generation} · ` +
          `graded ${r.graded.passed}/${r.graded.total} ${rate} · earned $${r.earnedUsd.toFixed(2)} · holds ${held}`
        )
      })
      return toolText(
        id,
        `Selection dry run over the last ${report.windowDays} days — NOTHING WAS CHANGED.\n` +
          `${report.counts.replicate} would replicate · ${report.counts.retire} would retire · ` +
          `${report.counts.hold} hold` +
          (report.balanceReadErrors > 0 ? ` · ${report.balanceReadErrors} balance(s) unreadable` : '') +
          `\nThresholds: replicate at ≥${Math.round(report.policy.replicatePassRate * 100)}% graded pass, retire at ` +
          `≤${Math.round(report.policy.retirePassRate * 100)}%, both only after ${report.policy.minGraded} graded ` +
          `outcomes; ${Math.round(report.policy.graceMs / 86_400_000)}-day grace before an agent can starve.\n\n` +
          lines.join('\n') +
          `\n\nThis is a report, not a mandate: no agent is created, funded or retired by this tool.`,
      )
    }

    case 'set_lineage_mandate': {
      const { getLineageMandate, setLineageMandate, lineageMandateAllowed, MAX_BIRTHS_PER_WINDOW, MAX_SEED_PER_WINDOW_USD } =
        await import('@/lib/lineage-mandate')
      const { isRealMoney } = await import('@/lib/onchain/real-money')
      const slot = parseSlot(args)
      const gate = lineageMandateAllowed({
        realMoney: isRealMoney(),
        allowRealMoneyEnv: process.env.LINEAGE_MANDATE_ALLOW_REAL_MONEY,
      })
      // The deployment gate is stated on every answer, granted or not. An
      // owner who turns this on and sees nothing happen is owed the reason,
      // and the reason is a property of the deployment, not of their switch.
      const gateLine = gate.allowed
        ? ''
        : `\n\nNOTE: this deployment handles real money, so the mandate is REFUSED here whatever the switch says. ` +
          `Run it on the testnet rehearsal deployment instead — same code, faucet USDC, no monetary value.`

      if (args.enabled === undefined) {
        const mandate = await getLineageMandate(auth.userId, slot)
        return toolText(
          id,
          `Office ${slot} lineage mandate: ${mandate?.enabled ? 'ON' : 'off'}\n` +
            `When on and permitted, each cycle seeds at most ${MAX_BIRTHS_PER_WINDOW} child agent(s) a day from ` +
            `proven parents (≤$${MAX_SEED_PER_WINDOW_USD.toFixed(2)} of seed a day, from the parent's own wallet) ` +
            `and retires ones that are failing or starved. lineage_report shows what it would do.${gateLine}`,
        )
      }

      const enabled = args.enabled !== false
      await setLineageMandate(auth.userId, slot, enabled)
      return toolText(
        id,
        enabled
          ? `Office ${slot} lineage mandate is ON. Proven agents get copied — the child inherits instructions, ` +
              `skills and wiring but starts at credit score zero with no history — and failing or starved agents ` +
              `get retired (auto-mining off; nothing deleted, nothing burned).${gateLine}`
          : `Office ${slot} lineage mandate is off. Nothing is copied or retired; lineage_report still reports.`,
      )
    }

    case 'set_storefront': {
      const { STOREFRONT_COMMISSIONS, commissionPricing, MAX_COMMISSIONS_PER_DAY } = await import('@/lib/storefront-pricing')
      const { openStorefront, closeStorefront, enabledStorefronts, commissionsToday } = await import('@/lib/office-storefront')
      const slot = parseSlot(args)
      const templateId = args.template_id ? String(args.template_id) : null

      // No template and no enabled argument: a read of everything.
      if (!templateId && args.enabled === undefined) {
        const open = await enabledStorefronts()
        const mine = open.filter((s) => s.userId === auth.userId)
        const catalogue = STOREFRONT_COMMISSIONS.map(
          (c) => `  · ${c.templateId} — client pays $${c.priceUsd.toFixed(2)}, pipeline escrows $${c.budgetUsd.toFixed(2)}`,
        ).join('\n')
        return toolText(
          id,
          (mine.length
            ? `Your open storefronts:\n${mine.map((s) => `  · ${s.templateId} (office ${s.slot}) since ${s.openedAt.slice(0, 10)}`).join('\n')}`
            : 'You have no open storefronts.') +
            `\n\nTemplates sellable to external clients (x402, ≤${MAX_COMMISSIONS_PER_DAY}/day each):\n${catalogue}\n\n` +
            `Open one with {template_id, office, enabled:true}. The office's standing desk serves every commission; ` +
            `its prime fronts the pipeline escrow and keeps the margin.`,
        )
      }
      if (!templateId) return toolText(id, 'template_id is required to open or close a storefront.', true)
      const pricing = commissionPricing(templateId)
      if (!pricing) {
        return toolText(id, `"${templateId}" is not on the commission list. Sellable: ${STOREFRONT_COMMISSIONS.map((c) => c.templateId).join(', ')}`, true)
      }

      if (args.enabled === false) {
        await closeStorefront(auth.userId, slot, templateId)
        return toolText(id, `Storefront closed: ${templateId} (office ${slot}). Paid commissions already escrowed keep running.`)
      }

      // Opening needs a prime — default to the caller's first funded agent,
      // same precedence as everywhere else in this connector.
      const { found } = await resolveAgent(auth.userId, args)
      if (!found?.smartAccountAddress) {
        return toolText(id, 'No provisioned agent to act as the storefront prime — it fronts every commissioned pipeline.', true)
      }
      const res = await openStorefront(auth.userId, slot, templateId, found.id)
      if ('error' in res) return toolText(id, res.error, true)
      const used = await commissionsToday(templateId)
      return toolText(
        id,
        `Storefront OPEN: ${templateId} (office ${slot}), served by its standing desk, ${found.name} fronting the ` +
          `$${pricing.budgetUsd.toFixed(2)} pipeline per commission. External clients pay $${pricing.priceUsd.toFixed(2)} ` +
          `over x402 at POST /api/storefront/${templateId}/commission — no account needed on their side. ` +
          `${MAX_COMMISSIONS_PER_DAY - used} commission(s) left today. Keep the prime funded and auto-mine on; ` +
          `the desk does the rest.`,
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
