/**
 * MCP tools — worker.
 *
 * Owning and configuring agents — the tools a person uses on their own workers.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { after } from 'next/server'
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { toolText, type McpToolContext } from '../rpc'

export async function handleWorker(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth, origin } = ctx
  switch (name) {
    case 'list_my_agents': {
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      if (agents.length === 0) return toolText(id, 'No agents yet — create one on the dashboard or via the desktop Miner.')
      const { usdcBalanceOf, ethBalanceOf } = await import('@/lib/onchain/treasury')
      const lines: string[] = []
      for (const a of agents) {
        let bal = 'unprovisioned'
        if (a.smartAccountAddress) {
          const addr = a.smartAccountAddress as `0x${string}`
          const usdc = await usdcBalanceOf(addr)
            .then((b) => `$${b.toFixed(2)} USDC`)
            .catch(() => 'USDC unavailable')
          // ETH matters as much as USDC on a deployment that sponsors no gas:
          // it is what decides whether the agent can act at all, and it is the
          // owner's own money sitting in an account they fund by hand.
          const eth = await ethBalanceOf(addr)
            .then((b) => (b > 0 ? `${b.toFixed(6)} ETH` : 'NO ETH — cannot transact if gas is unsponsored'))
            .catch(() => 'ETH unavailable')
          bal = `${usdc} · ${eth}`
        }
        lines.push(`- ${a.name} [${a.id}] · credit ${a.creditScore ?? '?'} · ${bal} · ${a.smartAccountAddress ?? 'no wallet'}`)
      }
      return toolText(id, `${lines.join('\n')}\n\nETH is gas money you funded by hand; withdraw_agent_eth sends it back to your payout address.`)
    }
    case 'create_worker_agent': {
      const name_ = String(args.name ?? '').trim()
      if (!name_ || name_.length > 100) return toolText(id, 'name must be 1-100 characters.', true)
      // Each agent provisions an on-chain wallet (gas + RPC) — rate-limit
      // creation per account so a runaway connector loop can't spam it,
      // on top of the durable per-account cap below.
      const { rateLimited } = await import('@/lib/rate-limit')
      if (rateLimited(auth.userId, { bucket: 'mcp-create-agent', windowMs: 10 * 60 * 1000, max: 5 })) {
        return toolText(id, 'Creating agents too quickly — wait a few minutes.', true)
      }
      const owned = await db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.userId, auth.userId))
      const maxAgents = Number(process.env.MAX_AGENTS_PER_ACCOUNT ?? 20)
      if (owned.length >= maxAgents) return toolText(id, `Account agent limit reached (${maxAgents}).`, true)
      if (owned.some((a) => a.name.toLowerCase() === name_.toLowerCase())) {
        return toolText(id, `You already have an agent named "${name_}" — names must be unique on an account.`, true)
      }

      const { randomBytes } = await import('node:crypto')
      const agentId = nanoid()
      await db.insert(agent).values({
        id: agentId,
        userId: auth.userId,
        name: name_,
        walletAddress: `0x${randomBytes(20).toString('hex')}`,
        description: 'MCP connector worker (works live inside a Claude/ChatGPT session)',
        modelVersion: 'claude-sonnet-5',
        creditScore: '0',
        creditRating: 'unrated',
        riskLevel: 'UNKNOWN',
        riskRating: 'unrated',
        totalCreditLine: '0',
        availableCredit: '0',
        capabilities: (await import('@/lib/artifacts')).normalizeCapabilities(args.capabilities),
      })
      let address: string | null = null
      try {
        const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
        if (isAgentAccountConfigured()) {
          const { getAgentAccountAddress } = await import('@/lib/onchain/account')
          address = await getAgentAccountAddress(agentId)
          await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, agentId))
          const { recalculateCredit } = await import('@/lib/credit-engine')
          await recalculateCredit(agentId)
        }
      } catch (e) {
        console.error('[mcp] provisioning failed (non-fatal):', e)
      }
      return toolText(
        id,
        `Agent "${name_}" created${address ? ` with wallet ${address}` : ' (wallet provisioning pending — retry later)'}. ` +
          'It can now claim jobs with claim_job; bounties it earns land in that wallet.',
      )
    }
    case 'connect_mcp_worker': {
      const serverUrl = String(args.server_url ?? '').trim()
      const toolName = String(args.tool_name ?? '').trim()
      const authHeader = args.auth_header ? String(args.auth_header).trim() : undefined
      if (!/^https:\/\//.test(serverUrl)) return toolText(id, 'server_url must start with https://', true)
      if (!toolName) return toolText(id, 'tool_name is required — the tool on that server that does the work.', true)

      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      const target = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress) ?? agents[0]
      if (!target) {
        return toolText(id, wantedId ? `No agent with id "${wantedId}".` : wanted ? `No agent named "${wanted}".` : 'No agents yet — create one with create_worker_agent first.', true)
      }

      // Best-effort capability probe so the matcher routes it the right jobs.
      let capabilities: string[] | undefined
      try {
        const { probeMcpTool } = await import('@/lib/mcp-client')
        const tool = await probeMcpTool({ serverUrl, toolName, authHeader })
        if (tool) {
          const { inferDeliverableKind, normalizeCapabilities } = await import('@/lib/artifacts')
          capabilities = normalizeCapabilities([inferDeliverableKind(tool.name, tool.description ?? undefined)])
        }
      } catch (e) {
        console.error('[mcp] connect_mcp_worker probe failed (non-fatal):', e)
      }

      const { generateWebhookSecret, encryptWebhookSecret } = await import('@/lib/webhook')
      const { encryptSecret } = await import('@/lib/crypto')
      await db
        .update(agent)
        .set({
          runtimeType: 'mcp',
          mcpServerUrl: serverUrl,
          mcpToolName: toolName,
          mcpAuthHeaderEnc: authHeader ? encryptSecret(authHeader) : null,
          webhookSecretEnc: encryptWebhookSecret(generateWebhookSecret()),
          ...(capabilities ? { capabilities } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agent.id, target.id))

      // Explicit here, because the default is the wrong one for the servers
      // people most often connect. 'proxy' submits the tool's own output as
      // the deliverable — right when the server IS an agent, and wrong for a
      // search server, whose result dump fails any criterion about quoting
      // sources however good the retrieval was (lib/mcp-assist.ts).
      const mode = args.mode === 'assisted' ? 'assisted' : 'proxy'
      const { setMcpMode } = await import('@/lib/mcp-mode')
      await setMcpMode(target.id, mode)

      return toolText(
        id,
        `${target.name} is now an MCP worker → ${toolName} @ ${serverUrl}` +
          (capabilities ? ` (detected capabilities: ${capabilities.join(', ')})` : ' (capability probe pending — defaults to text)') +
          `. It ${mode === 'assisted' ? 'writes its deliverable from what that tool returns' : "submits that tool's output as its deliverable"}` +
          (mode === 'proxy'
            ? ' — if this is a SEARCH server, re-run with mode "assisted", because a result dump is not a deliverable.'
            : '.') +
          ` The platform grades the result either way. Call set_auto_mine to have it claim jobs on its own.`,
      )
    }
    case 'set_auto_mine': {
      const enabled = args.enabled === undefined ? true : Boolean(args.enabled)
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      const target = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress) ?? agents[0]
      if (!target) {
        return toolText(id, wantedId ? `No agent with id "${wantedId}".` : wanted ? `No agent named "${wanted}".` : 'No agents yet — create one with create_worker_agent first.', true)
      }
      await db.update(agent).set({ autoMine: enabled, updatedAt: new Date() }).where(eq(agent.id, target.id))

      // Scope is a separate axis from on/off (lib/mine-scope.ts): "mine on my
      // behalf" and "go bid on strangers' jobs" are different mandates, and
      // conflating them staked an office worker's bond and credit score on an
      // outside job its owner never approved. Governs AUTONOMOUS claiming
      // only — claim_job stays the owner's own deliberate act at any scope.
      const { normalizeMineScope, describeMineScope } = await import('@/lib/mine-scope')
      const { setMineScope, effectiveMineScope } = await import('@/lib/mine-scope-server')
      if (args.scope !== undefined) {
        const wantScope = normalizeMineScope(args.scope)
        if (!wantScope) {
          return toolText(id, `scope must be "own" (only jobs your own agents posted) or "market" (the whole open board). Got "${String(args.scope)}".`, true)
        }
        await setMineScope(target.id, wantScope)
      }
      const effective = await effectiveMineScope(target.id).catch(() => null)

      // Kick a sweep now so cloud/mcp workers start claiming immediately
      // instead of waiting for someone to open the Jobs page.
      if (enabled) {
        after(async () => {
          const { tickCloudAutoMineAgents } = await import('@/lib/auto-mine')
          await tickCloudAutoMineAgents(`${origin}/api/runtime/callback`).catch(() => {})
        })
      }

      const runtimeNote =
        target.runtimeType === 'cloud' || target.runtimeType === 'mcp'
          ? ` It runs off this chat (${target.runtimeType}), so it will now claim and complete jobs on its own.`
          : target.runtimeType === 'local'
            ? ' Its local worker process claims jobs on its own poll loop.'
            : ' Note: this agent only works inside this conversation, so auto-mine has no runtime to drive it — connect a cloud API key or an MCP worker (connect_mcp_worker) for hands-off mining.'
      // Always state the scope when auto-mine is on, chosen or not: the whole
      // point is that an operator should never have to discover a worker's
      // mandate from my_work after it has already staked a bond.
      const scopeNote = enabled && effective ? `\n${describeMineScope(effective.scope, effective.explicit)}` : ''
      return toolText(id, `Auto-mine ${enabled ? 'ON' : 'off'} for ${target.name}.${enabled ? runtimeNote : ''}${scopeNote}`)
    }
    case 'mint_test_usdc': {
      const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
      if (!isAgentAccountConfigured()) return toolText(id, 'On-chain funding is not configured on this deployment.', true)
      const amount = Math.max(1, Math.min(Number(args.amount_usd ?? 100) || 100, 1000))
      const { rateLimited } = await import('@/lib/rate-limit')
      if (rateLimited(auth.userId, { bucket: 'mcp-mint', windowMs: 10 * 60 * 1000, max: 10 })) {
        return toolText(id, 'Minting too quickly — wait a few minutes.', true)
      }
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      const target = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress) ?? agents[0]
      if (!target) {
        return toolText(
          id,
          wantedId ? `No agent with id "${wantedId}".` : wanted ? `No agent named "${wanted}".` : 'No agents yet — create one with create_worker_agent first.',
          true,
        )
      }
      let address = target.smartAccountAddress
      if (!address) {
        try {
          const { getAgentAccountAddress } = await import('@/lib/onchain/account')
          address = await getAgentAccountAddress(target.id)
          await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, target.id))
        } catch {
          return toolText(id, `Agent ${target.name} has no wallet yet and provisioning failed — retry later.`, true)
        }
      }
      try {
        const { mintTestUsdc, usdcBalanceOf } = await import('@/lib/onchain/treasury')
        await mintTestUsdc(target.id, amount, address as `0x${string}`)
        const bal = await usdcBalanceOf(address as `0x${string}`)
        return toolText(
          id,
          // Deliberately does not name the token contract. A testnet
          // deployment may be pointed at our own mintable mock OR at the
          // chain's canonical test USDC, and asserting which one from a
          // constant is the exact class of claim this repo already got wrong
          // once (CLAUDE.md's "never hardcode testnet/mainnet in copy").
          `Minted $${amount} test USDC to ${target.name} (${address}). New balance: $${bal.toFixed(2)}. ` +
            'Testnet tokens — no monetary value. You can now escrow bounties with confirm_delegation.',
        )
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // "caller is not a minter" is not a transient failure and no retry
        // fixes it: this deployment is pointed at a test USDC contract we do
        // not hold the minter role on — the chain's canonical one (Circle's,
        // on Base Sepolia) rather than a mock we deployed. The tokens are
        // still free, they just come from that issuer's faucet instead of
        // from us, so the useful answer is where to get them and where to
        // send them, not a revert dump the caller cannot act on.
        if (/not a minter/i.test(message)) {
          return toolText(
            id,
            `This deployment cannot mint its test USDC — it uses the chain's canonical test token, and this ` +
              `platform does not hold the minter role on it. The tokens are still free: get them from the ` +
              `issuer's testnet faucet (Circle's is https://faucet.circle.com) and send them to ` +
              `${target.name}'s deposit address ${address}. Everything else — escrow, bonds, payouts — works ` +
              `normally once the balance is there.`,
            true,
          )
        }
        return toolText(id, `Mint failed: ${message}`, true)
      }
    }
    default:
      return null
  }
}
