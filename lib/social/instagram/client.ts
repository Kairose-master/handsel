/**
 * The one HTTP door to the Instagram Graph API.
 *
 * Every module in lib/social/instagram/ goes through `igFetch` — token
 * handling, retry policy, and error parsing live here once so they cannot
 * drift between endpoints.
 *
 * Configuration is env-only and OPTIONAL, per the repo convention: unset env
 * disables the feature and nothing else (`getInstagramConfig()` returns null,
 * callers surface "not configured"). The token travels in the Authorization
 * header — never in the URL, because request paths end up in host logs
 * (same reasoning as CRON_SECRET in .env.example).
 */
import { InstagramApiError, isNetworkError, redactToken, type GraphApiErrorBody } from './errors'
import type { InstagramConfig, RequestOptions } from './types'

/** Falls back safely; bump deliberately when Meta retires the version. */
export const DEFAULT_API_VERSION = 'v25.0'

/**
 * Default host serves the "Instagram API with Instagram Login" flow (no
 * Facebook Page required). Tokens issued via Facebook Login for Business
 * need INSTAGRAM_GRAPH_HOST=graph.facebook.com instead.
 */
export const DEFAULT_GRAPH_HOST = 'graph.instagram.com'

/**
 * Read the Instagram env. Null (not a throw) when the integration is not
 * configured — mirror of the X402_PAY_TO pattern. Empty strings count as
 * unset (see the .env.example warning about empty values).
 */
export function getInstagramConfig(): InstagramConfig | null {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim()
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim()
  if (!accessToken || !accountId) return null
  return {
    accessToken,
    accountId,
    apiVersion: process.env.INSTAGRAM_API_VERSION?.trim() || DEFAULT_API_VERSION,
    graphHost: process.env.INSTAGRAM_GRAPH_HOST?.trim() || DEFAULT_GRAPH_HOST,
  }
}

export function isInstagramConfigured(): boolean {
  return getInstagramConfig() !== null
}

const MAX_RETRIES_DEFAULT = 3
const BACKOFF_BASE_MS = 1000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Perform one Graph API call with transient-failure retries.
 *
 * Retry policy (Phase 4 requirement, enforced here for every endpoint):
 * exponential backoff (1s, 2s, 4s…) for network errors, 5xx and rate limits;
 * ZERO retries for auth/permission/validation errors — those can never
 * succeed on a replay and retrying a dead token invites token invalidation.
 */
export async function igFetch<T>(
  config: InstagramConfig,
  path: string,
  init: {
    method?: 'GET' | 'POST'
    /** Sent as query string for GET, urlencoded body for POST. */
    params?: Record<string, string | number | boolean | undefined>
  } = {},
  options: RequestOptions = {},
): Promise<T> {
  const retries = options.retries ?? MAX_RETRIES_DEFAULT
  const backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS
  const doFetch = config.fetchImpl ?? fetch
  const method = init.method ?? 'GET'

  const entries = Object.entries(init.params ?? {}).filter(
    (pair): pair is [string, string | number | boolean] => pair[1] !== undefined,
  )
  const encoded = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))

  const base = `https://${config.graphHost}/${config.apiVersion}/${path.replace(/^\//, '')}`
  const url = method === 'GET' && encoded.size > 0 ? `${base}?${encoded}` : base

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffBaseMs * 2 ** (attempt - 1))
    try {
      const res = await doFetch(url, {
        method,
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: method === 'POST' ? encoded.toString() : undefined,
      })

      const text = await res.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = undefined
      }

      if (!res.ok) {
        const body = (json as { error?: GraphApiErrorBody } | undefined)?.error
        const err = new InstagramApiError(
          res.status,
          body,
          redactToken(`Instagram API ${method} ${path} failed with HTTP ${res.status}`, config.accessToken),
        )
        if (err.isTransient && attempt < retries) {
          lastError = err
          continue
        }
        throw err
      }

      return json as T
    } catch (e) {
      if (e instanceof InstagramApiError) throw e
      // fetch itself threw — network-level. Retry within budget.
      if (isNetworkError(e) && attempt < retries) {
        lastError = e
        continue
      }
      throw e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Instagram API call failed after retries')
}
