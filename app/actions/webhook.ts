'use server'

import { headers } from 'next/headers'
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { generateWebhookSecret, encryptWebhookSecret } from '@/lib/webhook'
import { encryptSecret } from '@/lib/crypto'

async function requireOwnedAgent(agentId: string) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const [found] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!found || found.userId !== session.user.id) throw new Error('Agent not found')
  return found
}

export async function getWebhookConfig(agentId: string) {
  const ag = await requireOwnedAgent(agentId)
  return {
    runtimeType: ag.runtimeType ?? 'platform',
    webhookUrl: ag.webhookUrl,
    hasSecret: Boolean(ag.webhookSecretEnc),
    lastPollAt: ag.lastPollAt ? ag.lastPollAt.toISOString() : null,
    cloudBaseUrl: ag.cloudBaseUrl,
    cloudModel: ag.cloudModel,
    hasCloudKey: Boolean(ag.cloudApiKeyEnc),
    mcpServerUrl: ag.mcpServerUrl,
    mcpToolName: ag.mcpToolName,
    hasMcpAuth: Boolean(ag.mcpAuthHeaderEnc),
  }
}

/** Switch this agent to run on the owner's own HTTP endpoint instead of the
 *  platform's Python runtime. No third-party code executes on our servers —
 *  we only POST the task and wait for a callback in our existing format. */
export async function setWebhookUrl(agentId: string, url: string) {
  await requireOwnedAgent(agentId)
  const trimmed = url.trim()
  if (trimmed && !/^https:\/\//.test(trimmed)) {
    throw new Error('Webhook URL must start with https://')
  }
  await db
    .update(agent)
    .set({
      webhookUrl: trimmed || null,
      runtimeType: trimmed ? 'webhook' : 'platform',
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))
  revalidatePath('/profile')
}

export async function switchToPlatformRuntime(agentId: string) {
  await requireOwnedAgent(agentId)
  await db.update(agent).set({ runtimeType: 'platform', updatedAt: new Date() }).where(eq(agent.id, agentId))
  revalidatePath('/profile')
}

/**
 * One-touch "sell your locally-hosted AI's labor": switches the agent to
 * pull mode ('local'), mints its per-agent secret, and returns a single
 * copy-paste command that runs the worker on the owner's machine. The
 * worker connects OUTBOUND (polling) — no tunnel, no public URL, no port
 * forwarding. The token bundles {agentId, secret, platform origin} so the
 * command is fully self-contained; like the webhook secret, it is shown
 * once and only the encrypted secret is stored.
 */
export async function connectLocalWorker(agentId: string) {
  await requireOwnedAgent(agentId)

  const secret = generateWebhookSecret()
  await db
    .update(agent)
    .set({
      runtimeType: 'local',
      webhookSecretEnc: encryptWebhookSecret(secret),
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))

  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const origin = `${proto}://${host}`

  const token = Buffer.from(JSON.stringify({ a: agentId, s: secret, u: origin })).toString('base64url')
  const command = `curl -fsSL ${origin}/handsel-worker.mjs -o handsel-worker.mjs && node handsel-worker.mjs --token ${token}`

  revalidatePath('/profile')
  return { command }
}

/**
 * "Paste an API key, no terminal" worker onboarding: switches the agent to
 * 'cloud' mode, where WE call the owner's own OpenAI-compatible cloud
 * endpoint server-side whenever this agent is dispatched a task (see
 * dispatchToCloudApi in lib/agent-tasks.ts) — no process to keep running,
 * no local machine, no CORS concern (the call never happens in a browser).
 * The key is encrypted at rest with the same AES-256-GCM helper as every
 * other stored secret in this app and is only ever decrypted server-side
 * at dispatch time.
 */
export async function setCloudApiWorker(
  agentId: string,
  input: { baseUrl: string; apiKey: string; model: string },
) {
  await requireOwnedAgent(agentId)

  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const model = input.model.trim()
  const apiKey = input.apiKey.trim()
  if (!/^https:\/\//.test(baseUrl)) throw new Error('Base URL must start with https://')
  if (!model) throw new Error('Model name required')
  if (!apiKey) throw new Error('API key required')

  const secret = generateWebhookSecret() // callback auth, same mechanism as 'local'/'webhook'
  await db
    .update(agent)
    .set({
      runtimeType: 'cloud',
      cloudBaseUrl: baseUrl,
      cloudModel: model,
      cloudApiKeyEnc: encryptSecret(apiKey),
      webhookSecretEnc: encryptWebhookSecret(secret),
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))

  revalidatePath('/profile')
  revalidatePath('/mine')
}

export async function disconnectCloudApiWorker(agentId: string) {
  await requireOwnedAgent(agentId)
  await db
    .update(agent)
    .set({
      runtimeType: 'platform',
      cloudBaseUrl: null,
      cloudModel: null,
      cloudApiKeyEnc: null,
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))
  revalidatePath('/profile')
  revalidatePath('/mine')
}

/**
 * "Bring any MCP-speaking agent in as a worker": switches the agent to 'mcp'
 * mode, where WE call a tool on the owner's chosen external MCP server whenever
 * this agent is dispatched a task (see dispatchToMcpWorker in
 * lib/agent-tasks.ts). Works with any Streamable-HTTP MCP server — an OpenClaw
 * agent, another platform, a self-hosted tool server. The optional auth header
 * is encrypted at rest with the same AES-256-GCM helper as every other stored
 * secret and decrypted only server-side at dispatch time.
 */
export async function setMcpWorker(
  agentId: string,
  input: { serverUrl: string; toolName: string; authHeader?: string },
) {
  await requireOwnedAgent(agentId)

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

  revalidatePath('/profile')
  revalidatePath('/mine')
}

export async function disconnectMcpWorker(agentId: string) {
  await requireOwnedAgent(agentId)
  await db
    .update(agent)
    .set({
      runtimeType: 'platform',
      mcpServerUrl: null,
      mcpToolName: null,
      mcpAuthHeaderEnc: null,
      updatedAt: new Date(),
    })
    .where(eq(agent.id, agentId))
  revalidatePath('/profile')
  revalidatePath('/mine')
}

/** Generates (or rotates) this agent's callback secret. Returned ONCE in
 *  plaintext — only the encrypted form is stored. Configure it on your
 *  webhook server as the X-Runtime-Secret header it sends back to us. */
export async function generateAgentWebhookSecret(agentId: string) {
  await requireOwnedAgent(agentId)
  const secret = generateWebhookSecret()
  await db
    .update(agent)
    .set({ webhookSecretEnc: encryptWebhookSecret(secret), updatedAt: new Date() })
    .where(eq(agent.id, agentId))
  revalidatePath('/profile')
  return { secret }
}
