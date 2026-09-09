import { db } from '@/lib/db'
import { oauthToken, user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/** Canonical public origin of this deployment, derived from proxy headers
 *  (works on Vercel and locally). Used as the OAuth issuer. */
export function requestOrigin(request: Request): string {
  const h = request.headers
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export interface McpAuth {
  userId: string
  email: string
  clientId: string
}

/** Validate a `Bearer lmk_…` token from an MCP request. Returns null when
 *  missing/expired — the caller answers 401 + WWW-Authenticate so the
 *  connector knows to run the OAuth flow. */
export async function resolveMcpAuth(request: Request): Promise<McpAuth | null> {
  const raw = request.headers.get('authorization')
  const token = raw?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) return null

  try {
    const [row] = await db.select().from(oauthToken).where(eq(oauthToken.token, token))
    if (!row || row.expiresAt < new Date()) return null
    const [u] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, row.userId))
    if (!u) return null
    return { userId: u.id, email: u.email, clientId: row.clientId }
  } catch {
    return null // table missing until migration runs
  }
}

/**
 * Which redirect_uri a dynamically-registering MCP client may name. HTTPS
 * anywhere, or plain HTTP on a loopback interface (RFC 8252 §7.3: native
 * apps listen on an ephemeral port for the browser's callback). Claude Code
 * registers `http://localhost:<port>/callback`; other native clients use
 * `127.0.0.1` or `[::1]` for the same thing — rejecting those turned the
 * connector's "Authenticate" button into a registration error.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
}

export function unauthorizedMcp(origin: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      // RFC 9728 pointer — this is how MCP clients discover the OAuth flow.
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  })
}
