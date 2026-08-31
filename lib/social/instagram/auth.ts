/**
 * Token verification and (for Instagram-Login tokens) refresh.
 *
 * The token itself is provisioned OUTSIDE this codebase — a human completes
 * Meta's OAuth in a browser and stores the long-lived token
 * (docs/social/instagram.md has the exact clicks). This module only answers
 * "does the token still work, and for which account?" — the doctor-style
 * check the queue runs before flipping a job to NEEDS_AUTH is here too.
 */
import { igFetch } from './client'
import { InstagramApiError } from './errors'
import type { InstagramConfig, RequestOptions } from './types'

export type AccountInfo = {
  id: string
  username?: string
}

/** Resolve the professional account the configured id points at. Throws InstagramApiError on a dead token. */
export async function getAccountInfo(config: InstagramConfig, options?: RequestOptions): Promise<AccountInfo> {
  const res = await igFetch<{ id: string; username?: string }>(
    config,
    config.accountId,
    { params: { fields: 'id,username' } },
    options,
  )
  return { id: res.id, username: res.username }
}

export type AuthCheck =
  | { ok: true; account: AccountInfo }
  | { ok: false; needsAuth: boolean; error: string }

/** Non-throwing token check. `needsAuth: true` means reconnect, not retry. */
export async function checkAuth(config: InstagramConfig): Promise<AuthCheck> {
  try {
    const account = await getAccountInfo(config, { retries: 1 })
    return { ok: true, account }
  } catch (e) {
    const needsAuth = e instanceof InstagramApiError ? e.isAuthError : false
    return { ok: false, needsAuth, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Refresh a long-lived Instagram-Login token (60-day validity; refreshable
 * once it is >24h old). Only meaningful on graph.instagram.com — Facebook
 * Login tokens are refreshed by re-running the OAuth exchange instead.
 * Returns the NEW token; storing it is the caller's job (platform_secrets,
 * never a file, never a log).
 */
export async function refreshAccessToken(
  config: InstagramConfig,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  if (config.graphHost !== 'graph.instagram.com') {
    throw new Error('refresh_access_token is only available for Instagram Login tokens (graph.instagram.com)')
  }
  const res = await igFetch<{ access_token: string; expires_in: number }>(config, 'refresh_access_token', {
    params: { grant_type: 'ig_refresh_token' },
  })
  return { accessToken: res.access_token, expiresInSeconds: res.expires_in }
}
