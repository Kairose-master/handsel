/**
 * Wiring an agent to an external MCP server — the core, with no session in it.
 *
 * Lifted out of app/actions/webhook.ts because the MCP connector needs to do
 * this too, and a server action cannot serve it: an action resolves its caller
 * from the session COOKIE, and an MCP request carries an OAuth token instead.
 * Calling the action from `lib/mcp/handlers/` therefore throws "Unauthorized"
 * at runtime while passing tsc, lint, the test suite and the build — which is
 * exactly what it did, until wire_office_agent was run against the real
 * deployment for the first time.
 *
 * tests/mcp-handlers-no-server-actions.test.ts keeps the class from coming
 * back. Same split as lib/office-hire.ts.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateWebhookSecret, encryptWebhookSecret } from '@/lib/webhook'
import { encryptSecret } from '@/lib/crypto'
import type { McpMode } from '@/lib/mcp-assist'

export type McpWorkerWiring = {
  serverUrl: string
  toolName: string
  authHeader?: string
  /** 'assisted' has the agent WRITE from what the tool returned instead of
   *  submitting it verbatim — the right mode for a search-shaped server, whose
   *  raw output is a result dump and not a deliverable. Omitted keeps whatever
   *  the agent already had (and 'proxy' for a new one), so re-saving a URL
   *  never silently changes how the worker behaves. See lib/mcp-assist.ts. */
  mode?: McpMode
}

/**
 * Point one of `userId`'s agents at an MCP server and tool.
 *
 * Ownership is checked here rather than by the caller, so neither entry point
 * can forget it: the agent must belong to the id passed in, and that id comes
 * from a session on the action path and from a verified OAuth token on the MCP
 * path. Never take it from an argument the client controls.
 */
export async function setMcpWorkerFor(
  userId: string,
  agentId: string,
  input: McpWorkerWiring,
): Promise<void> {
  const [owned] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!owned || owned.userId !== userId) throw new Error('Agent not found')

  const serverUrl = input.serverUrl.trim()
  const toolName = input.toolName.trim()
  const authHeader = input.authHeader?.trim()
  if (!/^https:\/\//.test(serverUrl)) throw new Error('MCP server URL must start with https://')
  if (!toolName) throw new Error('Tool name required (the tool on that server that does the work)')

  // Best-effort: probe the server for the tool and auto-declare what this
  // imported agent can produce, so the capability matcher routes it the right
  // jobs (an image tool shouldn't be handed text-only work, and vice-versa).
  // Non-fatal — a server that's momentarily down still registers as text.
  let capabilities: string[] | undefined
  try {
    const { probeMcpTool } = await import('@/lib/mcp-client')
    const tool = await probeMcpTool({ serverUrl, toolName, authHeader })
    if (tool) {
      const { inferDeliverableKind, normalizeCapabilities } = await import('@/lib/artifacts')
      const kind = inferDeliverableKind(tool.name, tool.description ?? undefined)
      capabilities = normalizeCapabilities([kind])
    }
  } catch (error) {
    console.error('[setMcpWorker] capability probe failed (non-fatal):', error)
  }

  if (input.mode) {
    const { setMcpMode } = await import('@/lib/mcp-mode')
    await setMcpMode(agentId, input.mode)
  }

  // Mint the per-agent callback secret (same as cloud/local/webhook) so the
  // result callback dispatchToMcpWorker posts is authenticated, not open.
  const secret = generateWebhookSecret()
  await db
    .update(agent)
    .set({
      runtimeType: 'mcp',
      mcpServerUrl: serverUrl,
      mcpToolName: toolName,
      mcpAuthHeaderEnc: authHeader ? encryptSecret(authHeader) : null,
      webhookSecretEnc: encryptWebhookSecret(secret),
      ...(capabilities ? { capabilities } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))
}
