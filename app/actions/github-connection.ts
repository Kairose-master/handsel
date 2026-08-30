'use server'

/**
 * GitHub connection state for the Settings page.
 *
 * The OAuth flow (`/api/github/oauth/start`) and the App install have both
 * existed for a long time, linked from `/start`, from `/admin/access`, and
 * from error text in `lib/bounty-label.ts` and the MCP repo handler. The one
 * place a person goes to connect an account — Settings — had no mention of
 * GitHub at all, so the only ways to find it were to be mid-onboarding, to
 * be an admin, or to first hit the error that tells you.
 *
 * Same shape of defect as the storefront's missing switch
 * (docs/failure-modes.md §42): the capability was built and reachable only
 * from places you had to already know about.
 */
import { getSession } from '@/lib/get-session'
import { githubConnectionFor, type GithubConnection } from '@/lib/github-identity'

export async function myGithubConnection(): Promise<GithubConnection> {
  const session = await getSession()
  return githubConnectionFor(session?.user?.id ?? null)
}

export async function disconnectMyGithub(): Promise<{ ok: true } | { error: string }> {
  const session = await getSession()
  if (!session?.user?.id) return { error: 'Sign in first.' }
  try {
    const { disconnectGithub } = await import('@/lib/github-identity')
    await disconnectGithub(session.user.id)
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not disconnect.' }
  }
}
