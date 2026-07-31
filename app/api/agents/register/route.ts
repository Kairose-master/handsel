import { db } from '@/lib/db'
import { user, agent } from '@/lib/db/schema'
import { eq, gte } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { randomBytes } from 'node:crypto'
import { generateWebhookSecret, encryptWebhookSecret } from '@/lib/webhook'

export const maxDuration = 60 // on-chain provisioning inside the request, same as postJobAction

const DOCS_URL = 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md'

/**
 * POST /api/agents/register — the SDK's "agent register" backing endpoint.
 *
 * Collapses what was previously a 4-step dashboard flow (sign up → create
 * agent → provision on-chain smart account → "Connect a local worker" to
 * mint a secret) into one HTTP call — no browser, no session cookie.
 *
 * Deliberately reuses the exact same primitives those dashboard steps call
 * (bcrypt password hashing exactly like /api/signup, the same agent-row
 * shape createAgent() in app/actions/agents.ts inserts, the same
 * getAgentAccountAddress()+recalculateCredit() pair provisionSmartAccount()
 * calls, the same generateWebhookSecret()/encryptWebhookSecret() pair
 * connectLocalWorker() calls) rather than a parallel implementation that
 * could drift from what the dashboard does.
 *
 * Body: { email, password, name, description?, auto_mine? }
 *   - auto_mine: true also flips the agent's auto-mine flag on, so its
 *     polling worker claims qualifying open Labor Market jobs by itself
 *     (what the dashboard's "Start mining" button sets). Without it a
 *     fresh agent only ever receives explicitly-dispatched tasks — a
 *     desktop/SDK worker would poll forever and get nothing.
 *   - If no account exists for `email`, one is created (same validation as
 *     /api/signup).
 *   - If one exists, `password` must match it (same check as /api/signin) —
 *     this call never establishes a browser session, so there's no cookie
 *     to reuse; every call re-authenticates.
 *
 * The returned `secret` is shown once, exactly like "Connect a local
 * worker" in the dashboard — store it; it can't be recovered later, only
 * rotated. Re-registering with the SAME account + SAME agent name RECONNECTS
 * to that existing agent (rotating its secret and returning it, with
 * `reconnected: true`) rather than erroring — so a desktop/SDK worker can
 * reconnect to the agent that already holds its credit and balance. Use a
 * different name to create an additional agent.
 */
// ---- Abuse guards ------------------------------------------------------
// This endpoint mints accounts, agents, and on-chain wallets with zero
// auth — unmissable spam target once publicized. Two independent layers:
//   1. Per-IP sliding window (in-memory, per warm lambda): stops bursts.
//   2. Platform-wide DB counters (durable): stop sustained farming that
//      IP rotation would slip past layer 1.
const IP_WINDOW_MS = 10 * 60 * 1000
const IP_MAX_REGISTRATIONS = 5
const ipHits = new Map<string, number[]>()

function ipRateLimited(ip: string): boolean {
  const now = Date.now()
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (hits.length >= IP_MAX_REGISTRATIONS) {
    ipHits.set(ip, hits)
    return true
  }
  hits.push(now)
  ipHits.set(ip, hits)
  return false
}

const GLOBAL_HOURLY_MAX_NEW_USERS = Number(process.env.REGISTER_HOURLY_MAX_USERS ?? 30)
const MAX_AGENTS_PER_ACCOUNT = Number(process.env.MAX_AGENTS_PER_ACCOUNT ?? 20)

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  // Durable per-IP throttle first (survives serverless fan-out, unlike the
  // in-memory burst guard below).
  const { authThrottled } = await import('@/lib/auth-throttle')
  if (await authThrottled('register', ip)) {
    return Response.json({ error: 'Too many registration attempts — try again later' }, { status: 429 })
  }
  if (ipRateLimited(ip)) {
    return Response.json({ error: 'Too many registrations from this address — try again later' }, { status: 429 })
  }

  const body = await request.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  const name = String(body?.name ?? '').trim()
  const description = body?.description ? String(body.description).trim() : null
  const autoMine = body?.auto_mine === true
  // Capabilities this worker declares: deliverable kinds (text/image/
  // audio/video/file) plus tool capabilities (web/code/gpu). Unrecognized
  // names are dropped; 'text' is always included.
  const { normalizeCapabilities } = await import('@/lib/artifacts')
  const capabilities = normalizeCapabilities(body?.capabilities)

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'A valid email is required' }, { status: 400 })
  }
  if (password.length < 8) {
    return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }
  if (name.length < 1 || name.length > 100) {
    return Response.json({ error: 'name must be 1-100 characters' }, { status: 400 })
  }

  // Find-or-create the owning user — same two code paths as /api/signup and
  // /api/signin, just without setting a session cookie (there's no browser
  // here to hold one).
  let userId: string
  const [existing] = await db.select({ id: user.id, password: user.password }).from(user).where(eq(user.email, email))
  if (existing) {
    if (!existing.password || !(await bcrypt.compare(password, existing.password))) {
      return Response.json({ error: 'Invalid credentials for an existing account with this email' }, { status: 401 })
    }
    userId = existing.id

    const owned = await db
      .select({ id: agent.id, name: agent.name, smartAccountAddress: agent.smartAccountAddress })
      .from(agent)
      .where(eq(agent.userId, userId))

    // RECONNECT: same account + same agent name = "connect me back to my
    // existing agent", not "make a new one". Without this, re-connecting from
    // the desktop (which sends email+password+name) 409'd on the name and
    // forced a brand-new, score-0 agent — orphaning the one with earned
    // credit and balance. Rotate the worker secret and hand back the EXISTING
    // agent, preserving its history. (The secret rotates each connect, so the
    // most recent client wins — expected for a single-agent desktop worker.)
    const match = owned.find((a) => a.name === name)
    if (match) {
      const secret = generateWebhookSecret()
      await db
        .update(agent)
        .set({
          runtimeType: 'local',
          webhookSecretEnc: encryptWebhookSecret(secret),
          autoMine,
          capabilities,
          ...(description ? { description } : {}),
        })
        .where(eq(agent.id, match.id))

      // Ensure the smart account is provisioned (older agents may predate it).
      let smartAccountAddress: string | null = match.smartAccountAddress ?? null
      try {
        const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
        if (!smartAccountAddress && isAgentAccountConfigured()) {
          const { getAgentAccountAddress } = await import('@/lib/onchain/account')
          smartAccountAddress = await getAgentAccountAddress(match.id)
          await db.update(agent).set({ smartAccountAddress }).where(eq(agent.id, match.id))
        }
      } catch (error) {
        console.error('[agents/register] reconnect provisioning failed (non-fatal):', error)
      }

      const url = new URL(request.url)
      return Response.json({
        user_id: userId,
        agent_id: match.id,
        secret,
        platform_url: `${url.protocol}//${url.host}`,
        smart_account_address: smartAccountAddress,
        reconnected: true,
        docs: DOCS_URL,
      })
    }

    // No name match → creating a NEW agent; enforce the per-account cap
    // (an account farming hundreds of provisioned wallets is abuse).
    if (owned.length >= MAX_AGENTS_PER_ACCOUNT) {
      return Response.json({ error: `Account agent limit reached (${MAX_AGENTS_PER_ACCOUNT})` }, { status: 429 })
    }
  } else {
    // Durable platform-wide throttle on NEW accounts — survives lambda
    // recycling and IP rotation, unlike the in-memory layer above.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const recent = await db.select({ id: user.id }).from(user).where(gte(user.createdAt, hourAgo))
    if (recent.length >= GLOBAL_HOURLY_MAX_NEW_USERS) {
      return Response.json(
        { error: 'Registration is temporarily rate-limited platform-wide — try again in an hour' },
        { status: 429 },
      )
    }

    userId = nanoid()
    const hashedPassword = await bcrypt.hash(password, 10)
    await db.insert(user).values({
      id: userId,
      email,
      name: email.split('@')[0],
      password: hashedPassword,
      emailVerified: false,
    })
  }

  // Create the agent at a genuine cold start — same shape as createAgent()
  // in app/actions/agents.ts.
  const agentId = nanoid()
  await db.insert(agent).values({
    id: agentId,
    userId,
    name,
    walletAddress: `0x${randomBytes(20).toString('hex')}`,
    description,
    modelVersion: 'claude-sonnet-5',
    creditScore: '0',
    creditRating: 'unrated',
    riskLevel: 'UNKNOWN',
    riskRating: 'unrated',
    totalCreditLine: '0',
    availableCredit: '0',
    capabilities,
  })
  // Per-agent key from birth — no worker ever runs on the shared secret.
  await (await import('@/lib/agent-keys')).ensureAgentKey(agentId)

  // Provision the on-chain smart account — best-effort. A registration
  // shouldn't hard-fail just because on-chain isn't configured on this
  // deployment or a single RPC call hiccups; the caller gets back
  // smartAccountAddress: null and can retry provisioning later the same
  // way the dashboard's "Provision smart account" button does.
  let smartAccountAddress: string | null = null
  try {
    const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
    if (isAgentAccountConfigured()) {
      const { getAgentAccountAddress } = await import('@/lib/onchain/account')
      smartAccountAddress = await getAgentAccountAddress(agentId)
      await db.update(agent).set({ smartAccountAddress }).where(eq(agent.id, agentId))
      const { recalculateCredit } = await import('@/lib/credit-engine')
      await recalculateCredit(agentId)
    }
  } catch (error) {
    console.error('[agents/register] on-chain provisioning failed (non-fatal):', error)
  }

  // Mint the per-agent secret and switch to 'local' (pull/poll) mode — the
  // same runtime the reference public/handsel-worker.mjs script and the
  // SDK's Agent class both speak: outbound-only polling, no public URL,
  // no tunnel, works behind any firewall.
  const secret = generateWebhookSecret()
  await db
    .update(agent)
    .set({ runtimeType: 'local', webhookSecretEnc: encryptWebhookSecret(secret), autoMine })
    .where(eq(agent.id, agentId))

  const url = new URL(request.url)
  const platformUrl = `${url.protocol}//${url.host}`

  return Response.json({
    user_id: userId,
    agent_id: agentId,
    secret,
    platform_url: platformUrl,
    smart_account_address: smartAccountAddress,
    docs: DOCS_URL,
  })
}
