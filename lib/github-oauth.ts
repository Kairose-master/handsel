/**
 * GitHub sign-in / account linking (user-to-server OAuth).
 *
 * Reuses the SAME GitHub App that opens pull requests for repo jobs — a
 * GitHub App has a client id/secret and supports user authorization, so
 * there is no second OAuth App to create or keep in sync. One consent, one
 * install surface: the account you sign in as is the account whose
 * installations we can see.
 *
 * The pure parts (state minting/verification, redirect building, email
 * selection) live here and are unit-tested; the routes stay thin.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const GITHUB_STATE_COOKIE = 'gh_oauth_state'
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

export type GithubOauthConfig = { clientId: string; clientSecret: string }

/** Config comes from env first, then the encrypted platform_secrets KV —
 *  the same pattern the App credentials use. Unset ⇒ the feature is simply
 *  not offered (no button, no route action). */
export async function githubOauthConfig(): Promise<GithubOauthConfig | null> {
  const fromEnv = (name: string) => process.env[name]?.trim() || null
  let clientId = fromEnv('GITHUB_CLIENT_ID')
  let clientSecret = fromEnv('GITHUB_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    const { getPlatformSecret } = await import('@/lib/platform-secret')
    clientId = clientId ?? (await getPlatformSecret('github_client_id'))
    clientSecret = clientSecret ?? (await getPlatformSecret('github_client_secret'))
  }
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export async function isGithubLoginEnabled(): Promise<boolean> {
  return (await githubOauthConfig()) !== null
}

/**
 * CSRF state: a random nonce plus the post-login destination, signed so the
 * callback can trust the `next` it gets back. The cookie holds the same
 * value; the callback requires both to match.
 */
export function mintState(next: string, secret: string, nonce = randomBytes(16).toString('hex')): string {
  const safeNext = safeNextPath(next)
  const payload = `${nonce}.${Buffer.from(safeNext).toString('base64url')}`
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Verifies the signature and that the cookie carries the identical state.
 *  Returns the destination path, or null when anything fails. */
export function verifyState(state: string, cookieState: string | null, secret: string): string | null {
  if (!state || !cookieState) return null
  const a = Buffer.from(state)
  const b = Buffer.from(cookieState)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [nonce, nextB64, sig] = parts
  const expected = createHmac('sha256', secret).update(`${nonce}.${nextB64}`).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  try {
    return safeNextPath(Buffer.from(nextB64, 'base64url').toString('utf8'))
  } catch {
    return '/'
  }
}

/** Only same-origin paths may be redirected to — an open redirect here would
 *  turn our sign-in into a phishing hop. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  return next
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
  })
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`
}

export type GithubEmail = { email: string; primary: boolean; verified: boolean }

/**
 * The email we may safely match an existing account against: GitHub's
 * primary VERIFIED address. An unverified address must never link to an
 * existing password account — that would let anyone who can type a victim's
 * address into GitHub take over their Handsel account.
 */
export function pickVerifiedEmail(emails: GithubEmail[] | null | undefined): string | null {
  if (!Array.isArray(emails)) return null
  const primary = emails.find((e) => e.primary && e.verified)
  if (primary) return primary.email.toLowerCase()
  const anyVerified = emails.find((e) => e.verified)
  return anyVerified ? anyVerified.email.toLowerCase() : null
}

/** Placeholder address for a GitHub account with no verified email — keeps
 *  the NOT NULL/unique email column satisfied without inventing a real one
 *  that could collide with somebody's actual inbox. */
export function noreplyEmailFor(githubUserId: string, login: string): string {
  return `${githubUserId}+${login.toLowerCase()}@users.noreply.github.com`
}
