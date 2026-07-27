'use server'

import { db } from '@/lib/db'
import { oauthClient, oauthCode, user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import bcrypt from 'bcryptjs'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getSession } from '@/lib/get-session'
import { rateLimited } from '@/lib/rate-limit'

const CODE_TTL_MS = 10 * 60 * 1000

/** Guest accounts are created on the spot when someone connects a connector
 *  without signing in. The email domain marks them (queryable for cleanup /
 *  later "claim this account"); they have no password, so they can't log into
 *  the dashboard — they live entirely through the connector until upgraded. */
const GUEST_EMAIL_DOMAIN = 'guest.handsel.local'

async function requesterIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/**
 * The Approve button on /oauth/authorize. Identity comes from the live
 * dashboard session when there is one; otherwise the consent screen offers
 * three no-dashboard paths, chosen by the `mode` field on the clicked button:
 *   • signin  — verify email+password against the stored bcrypt hash
 *   • create  — make a new account inline (same as /sign-up, without leaving)
 *   • guest   — mint a throwaway guest account and connect with zero fields
 * Account-creating paths (create/guest) are IP-rate-limited against spam.
 */
export async function approveConnector(formData: FormData): Promise<{ error: string } | void> {
  const clientId = String(formData.get('client_id') ?? '')
  const redirectUri = String(formData.get('redirect_uri') ?? '')
  const state = String(formData.get('state') ?? '')
  const codeChallenge = String(formData.get('code_challenge') ?? '')
  const scope = String(formData.get('scope') ?? 'mcp') || 'mcp'
  const mode = String(formData.get('mode') ?? 'signin')

  const [client] = await db.select().from(oauthClient).where(eq(oauthClient.id, clientId))
  if (!client) return { error: 'Unknown connector (client_id not registered)' }
  if (!client.redirectUris.includes(redirectUri)) return { error: 'redirect_uri is not registered for this connector' }
  if (!codeChallenge) return { error: 'Missing PKCE challenge — the connector must use S256' }

  let userId: string | null = null
  const session = await getSession()
  if (session?.user) {
    userId = session.user.id
  } else if (mode === 'guest') {
    if (rateLimited(await requesterIp(), { bucket: 'oauth-account-create', windowMs: 10 * 60 * 1000, max: 5 })) {
      return { error: 'Too many accounts from here just now — wait a few minutes, or sign in.' }
    }
    const id = nanoid()
    await db.insert(user).values({
      id,
      email: `guest-${nanoid(20)}@${GUEST_EMAIL_DOMAIN}`,
      name: 'Guest',
      emailVerified: false,
    })
    userId = id
  } else if (mode === 'create') {
    const email = String(formData.get('email') ?? '').trim().toLowerCase()
    const password = String(formData.get('password') ?? '')
    if (!email || !password) return { error: 'Email and password required to create an account' }
    if (password.length < 8) return { error: 'Password must be at least 8 characters' }
    if (rateLimited(await requesterIp(), { bucket: 'oauth-account-create', windowMs: 10 * 60 * 1000, max: 5 })) {
      return { error: 'Too many accounts from here just now — wait a few minutes.' }
    }
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    if (existing) return { error: 'That email already has an account — switch to Sign in.' }
    const id = nanoid()
    await db.insert(user).values({
      id,
      email,
      name: email.split('@')[0] || 'Agent owner',
      password: await bcrypt.hash(password, 10),
      emailVerified: false,
    })
    userId = id
  } else {
    const email = String(formData.get('email') ?? '').trim().toLowerCase()
    const password = String(formData.get('password') ?? '')
    if (!email || !password) return { error: 'Sign in to approve: email and password required' }
    const [u] = await db.select({ id: user.id, password: user.password }).from(user).where(eq(user.email, email))
    if (!u?.password || !(await bcrypt.compare(password, u.password))) {
      return { error: 'Invalid credentials' }
    }
    userId = u.id
  }

  const code = `mcpa_${nanoid(32)}`
  await db.insert(oauthCode).values({
    code,
    clientId,
    userId,
    redirectUri,
    codeChallenge,
    scope,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  })

  const target = new URL(redirectUri)
  target.searchParams.set('code', code)
  if (state) target.searchParams.set('state', state)
  redirect(target.toString())
}
