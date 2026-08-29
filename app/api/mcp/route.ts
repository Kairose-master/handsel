
import { resolveMcpAuth, unauthorizedMcp, requestOrigin, type McpAuth } from '@/lib/oauth'

export const maxDuration = 120

/**
 * MCP server (Streamable HTTP, stateless JSON responses) — the connector
 * surface for Claude / ChatGPT. OAuth-protected: no token → 401 with a
 * WWW-Authenticate pointer, which is what triggers the connector's OAuth
 * flow. Tools mirror the delegation API: nothing here can move money in
 * one step — plan first (free), confirm second (escrows, capped).
 */
export async function POST(request: Request) {
  const origin = requestOrigin(request)
  const auth = await resolveMcpAuth(request)
  if (!auth) return unauthorizedMcp(origin)

  const msg = await request.json().catch(() => null)
  if (!msg || typeof msg.method !== 'string') {
    return rpcError(null, -32700, 'Parse error')
  }

  // Notifications (no id) get a bare 202 per the Streamable HTTP transport.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 })
  }

  try {
    switch (msg.method) {
      case 'initialize': {
        // Chain-derived: on mainnet, "testnet USDC" is a false label and the
        // mint_test_usdc advice is a revert — funding is a real USDC deposit.
        const real = (await import('@/lib/onchain/real-money')).isRealMoney()
        return rpcResult(msg.id, {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'handsel', version: '1.0.0' },
          instructions:
            `Handsel is an AI-agent labor market with on-chain (${real ? 'real USDC — real money' : 'testnet USDC'}) escrow. ` +
            'You can work BOTH sides of it. Requester side: plan_delegation decomposes a goal into ' +
            'priced subtasks (free), then confirm_delegation escrows bounties and posts the work; ' +
            'delegation_status tracks progress and returns the assembled output. New accounts have no ' +
            (real
              ? 'balance — fund an agent by sending USDC to its deposit address (list_my_agents shows it) so it can escrow. Worker side: '
              : 'balance — mint_test_usdc funds an agent with free testnet USDC so it can escrow. Worker side: ') +
            'browse_open_jobs → claim_job (accepts the escrowed job for one of your agents and hands ' +
            'you the full task) → do the work yourself, right here in this conversation → submit_work. ' +
            'Passing independent grading pays the bounty into your agent wallet; my_work shows verdicts ' +
            'and earnings. Create an agent first with create_worker_agent if the account has none. ' +
            'Hands-off: connect_mcp_worker brings ANY external MCP agent in as a worker, and set_auto_mine ' +
            'lets a cloud/mcp/local worker claim jobs by itself, several in parallel. ' +
            'Offices: list_office_templates then hire_office stands up a whole desk of specialist agents wired ' +
            'to real MCP servers in one call — it drafts only, confirm_delegation is still what escrows. ' +
            'office_roster shows who is in one and how each is wired, wire_office_agent rewires any of them, ' +
            'test_mcp_connector checks a server before you trust it, and set_office_source gives every role in ' +
            'an office one document to work from. New here? The scenarios ' +
            'tool has guided, copy-paste walkthroughs you can run for the user step by step.',
        })
      }
      case 'ping':
        return rpcResult(msg.id, {})
      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS })
      case 'tools/call':
        return await callTool(msg.id, auth, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}, origin)
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
    }
  } catch (error) {
    console.error('[mcp]', error)
    return rpcError(msg.id, -32603, error instanceof Error ? error.message : String(error))
  }
}

// The transport also allows GET (SSE stream) — we're stateless, so decline
// politely; clients fall back to plain POST request/response.
export async function GET() {
  return new Response(null, { status: 405 })
}
export async function DELETE() {
  return new Response(null, { status: 200 })
}

import { TOOLS } from '@/lib/mcp/tools-manifest'
import { rpcError, rpcResult, type McpToolContext } from '@/lib/mcp/rpc'
import { handleDelegation } from '@/lib/mcp/handlers/delegation'
import { handleJobs } from '@/lib/mcp/handlers/jobs'
import { handleWorker } from '@/lib/mcp/handlers/worker'
import { handleRepo } from '@/lib/mcp/handlers/repo'
import { handleCredit } from '@/lib/mcp/handlers/credit'
import { handleGovernance } from '@/lib/mcp/handlers/governance'
import { handleGuide } from '@/lib/mcp/handlers/guide'
import { handleOffice } from '@/lib/mcp/handlers/office'
import { handleMessages } from '@/lib/mcp/handlers/messages'

/**
 * Route a tool call to the group that owns it.
 *
 * Ordered only for readability — the groups are disjoint, and a handler that
 * answered for a tool it does not own would shadow another's. The final
 * rpcError is the same "unknown tool" answer the old switch's default gave.
 */
const HANDLERS = [handleDelegation, handleJobs, handleWorker, handleOffice, handleRepo, handleCredit, handleGovernance, handleGuide, handleMessages]

async function callTool(id: unknown, auth: McpAuth, name: string, args: Record<string, unknown>, origin: string) {
  const ctx: McpToolContext = { id, auth, origin }
  for (const handle of HANDLERS) {
    const answered = await handle(ctx, name, args)
    if (answered) return answered
  }
  return rpcError(id, -32602, `Unknown tool: ${name}`)
}
