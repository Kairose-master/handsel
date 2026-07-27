/**
 * GET /api/github/oauth/callback — the other half of GitHub sign-in.
 *
 * Resolution order, deliberately strict about what may link to an existing
 * account:
 *   1. Already-linked GitHub account  → sign in as that user.
 *   2. Session present                → link GitHub to the signed-in user.
 *   3. GitHub's primary VERIFIED email matches a user → link and sign in.
 *   4. Otherwise                      → create a new passwordless account.
 *
 * Step 3 is the only place a GitHub identity can reach a pre-existing
 * password account, and it requires GitHub to have verified the address —
 * an unverified email must never be enough, or anyone could type a victim's
 * address into GitHub and take the account over.
 *
 * The session it creates is the app's own (`session` row + `auth_session`
 * cookie), identical to /api/signin — this app does not use better-auth's
 * session for sign-in, so a better-auth social session would be invisible
 * to getSession().
 */
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { session, user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  GITHUB_STATE_COOKIE,
  GITHUB_TOKEN_URL,
  githubOauthConfig,
  noreplyEmailFor,
  pickVerifiedEmail,
  verifyState,
  type GithubEmail,
} from '@/lib/github-oauth'
import { getSession } from '@/lib/get-session'
import { saveGithubIdentity, userIdForGithubUser } from '@/lib/github-identity'

function fail(origin: string, reason: string) {
  return Response.redirect(`${origin}/sign-in?error=${encodeURIComponent(reason)}`, 302)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = url.origin

  const config = await githubOauthConfig()
  if (!config) return fail(origin, 'GitHub sign-in is not configured')

  const jar = await cookies()
  const state = url.searchParams.get('state') ?? ''
  const cookieState = jar.get(GITHUB_STATE_COOKIE)?.value ?? null
  const next = verifyState(state, cookieState, config.clientSecret)
  jar.delete(GITHUB_STATE_COOKIE)
  if (next === null) return fail(origin, 'GitHub sign-in expired or was tampered with — try again')

  const code = url.searchParams.get('code')
  if (!code) return fail(origin, url.searchParams.get('error_description') ?? 'GitHub did not return an authorization code')

  // Throttle: this endpoint mints sessions, so it belongs under the same
  // durable limiter as the password paths.
  const { authThrottled, throttleIp } = await import('@/lib/auth-throttle')
  if (await authThrottled('signin', throttleIp(request))) {
    return fail(origin, 'Too many sign-in attempts — try again in a few minutes')
  }

  try {
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: `${origin}/api/github/oauth/callback`,
      }),
    })
    const token = (await tokenRes.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error_description?: string
    }
    if (!token.access_token) return fail(origin, token.error_description ?? 'GitHub refused the authorization code')

    const gh = async <T>(path: string): Promise<T | null> => {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'handsel-auth',
        },
      })
      return res.ok ? ((await res.json()) as T) : null
    }

    const profile = await gh<{ id: number; login: string; name?: string; email?: string; avatar_url?: string }>('/user')
    if (!profile?.id) return fail(origin, 'Could not read your GitHub profile')
    const githubUserId = String(profile.id)
    const verifiedEmail = pickVerifiedEmail(await gh<GithubEmail[]>('/user/emails'))

    // ── Resolve which platform user this is ──────────────────────────
    //
    // A SIGNED-IN user always wins, even when this GitHub account is already
    // linked elsewhere. Both sides are authenticated here — OAuth just proved
    // control of the GitHub account, and the session proves control of the
    // platform account — so "link GitHub to the account I am looking at" is a
    // safe and unambiguous instruction.
    //
    // The alternative (letting an existing link win) silently signs the user
    // into the OTHER account instead, which is exactly the trap this hit in
    // practice: signing in with GitHub while logged out, with a GitHub email
    // that matches no existing account, mints a second account — and then
    // every attempt to "connect GitHub" from the real account bounces the
    // user back into the accidental one, with no way out and no explanation.
    const current = await getSession()
    let userId: string | null = current?.user?.id ?? null

    if (userId) {
      // Moving an identity between accounts: github_user_id is unique, so the
      // stale row has to go before the upsert can claim it.
      const previous = await userIdForGithubUser(githubUserId)
      if (previous && previous !== userId) {
        const { disconnectGithub } = await import('@/lib/github-identity')
        await disconnectGithub(previous)
      }
    } else {
      userId = await userIdForGithubUser(githubUserId)
      if (!userId && verifiedEmail) {
        const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, verifiedEmail))
        if (existing) userId = existing.id
      }
    }

    if (!userId) {
      const email = verifiedEmail ?? noreplyEmailFor(githubUserId, profile.login)
      const [created] = await db
        .insert(user)
        .values({
          id: nanoid(),
          email,
          name: profile.name || profile.login,
          // Passwordless: this account signs in with GitHub. The column is
          // nullable, and /api/signin rejects a null password outright.
          password: null,
          emailVerified: Boolean(verifiedEmail),
          image: profile.avatar_url ?? null,
        })
        .returning({ id: user.id })
      userId = created.id
    }

    await saveGithubIdentity({
      userId,
      githubUserId,
      login: profile.login,
      avatarUrl: profile.avatar_url ?? null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
    })

    const sessionId = nanoid()
    await db.insert(session).values({
      id: sessionId,
      userId,
      token: nanoid(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    jar.set('auth_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    })

    return Response.redirect(`${origin}${next}`, 302)
  } catch (error) {
    console.error('[github/oauth/callback] failed:', error)
    return fail(origin, 'GitHub sign-in failed — try again')
  }
}
