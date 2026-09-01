/**
 * Flip one of the caller's agents to a LOCAL worker and mint its one-line
 * `npx handsel-worker --token …` command.
 *
 * Shared by two MCP tools that are the same act with different entry points:
 * `connect_local_worker` (name the agent directly) and `wire_office_agent`
 * with server_url "local" (rewire an office role — the wiring verb people
 * already reach for when reshaping a desk). Same reconnect semantics as
 * POST /api/agents/register: runtimeType 'local', rotate the worker secret.
 * The token embeds the fresh secret, so it is shown once — exactly like the
 * dashboard's "Connect a local worker" card.
 */
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export type LocalWorkerConnection = {
  agentId: string
  agentName: string
  autoMine: boolean
  /** base64url {a, s, u} — exactly what handsel-worker --token takes. */
  token: string
}

export async function connectLocalWorker(userId: string, agentId: string): Promise<LocalWorkerConnection | null> {
  const [target] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!target || target.userId !== userId) return null

  const { generateWebhookSecret, encryptWebhookSecret } = await import('@/lib/webhook')
  const secret = generateWebhookSecret()
  await db
    .update(agent)
    .set({ runtimeType: 'local', webhookSecretEnc: encryptWebhookSecret(secret), updatedAt: new Date() })
    .where(eq(agent.id, target.id))

  const { origin } = await import('@/lib/origin')
  const token = Buffer.from(JSON.stringify({ a: target.id, s: secret, u: origin() })).toString('base64url')
  return { agentId: target.id, agentName: target.name, autoMine: target.autoMine, token }
}

/** The user-facing text both tools answer with — one voice, one place. */
export function localWorkerInstructions(conn: LocalWorkerConnection): string {
  return (
    `${conn.agentName} is now a LOCAL worker: its jobs queue on this platform until a worker process you run polls them, does the work with a real coding harness (Claude Code, Codex, OpenCode, Cline, Gemini), and submits. Nothing runs on our servers.\n\n` +
    `Start it on the machine that should do the work:\n\n` +
    `  npx handsel-worker --token ${conn.token}\n\n` +
    `Add --harness claude (or codex, opencode, cline, gemini) to choose how the work runs, and --workdir <dir> to scope its file access. Those five are adapters whose flags were read off each tool's own CLI reference, so prefer them over hand-rolling --harness-cmd; that flag is for a tool the registry does not know. This token embeds a fresh worker secret — shown once, so save it (the worker's --remember does). Reconnecting later rotates it again.` +
    (conn.autoMine
      ? " Auto-mine is already on: an idle poll claims this agent's qualifying jobs by itself."
      : ' Call set_auto_mine to have an idle poll claim qualifying jobs by itself.')
  )
}
