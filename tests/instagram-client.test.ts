import { afterEach, describe, expect, it, vi } from 'vitest'
import { getInstagramConfig, igFetch, DEFAULT_GRAPH_HOST } from '@/lib/social/instagram/client'
import { InstagramApiError, isRetryable, redactToken } from '@/lib/social/instagram/errors'
import type { InstagramConfig } from '@/lib/social/instagram/types'

const TOKEN = 'IGQVJtoken_secret_valueXYZ9'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const cfg = (fetchImpl: typeof fetch): InstagramConfig => ({
  accessToken: TOKEN,
  accountId: '17841400000000000',
  apiVersion: 'v25.0',
  graphHost: 'graph.instagram.com',
  fetchImpl,
})

describe('getInstagramConfig', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('returns null when the integration is unconfigured (feature off, nothing broken)', () => {
    delete process.env.INSTAGRAM_ACCESS_TOKEN
    delete process.env.INSTAGRAM_ACCOUNT_ID
    expect(getInstagramConfig()).toBeNull()
  })

  it('treats an empty string as unset — the .env.example warning is enforced', () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = '  '
    process.env.INSTAGRAM_ACCOUNT_ID = '123'
    expect(getInstagramConfig()).toBeNull()
  })

  it('reads token + account and applies defaults', () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = 'tok'
    process.env.INSTAGRAM_ACCOUNT_ID = '123'
    delete process.env.INSTAGRAM_API_VERSION
    delete process.env.INSTAGRAM_GRAPH_HOST
    const c = getInstagramConfig()
    expect(c?.graphHost).toBe(DEFAULT_GRAPH_HOST)
    expect(c?.apiVersion).toMatch(/^v\d+\.\d+$/)
  })
})

describe('igFetch', () => {
  it('sends the token in the Authorization header, never the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }))
    await igFetch(cfg(fetchImpl), 'me', { params: { fields: 'id' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.instagram.com/v25.0/me?fields=id')
    expect(url).not.toContain(TOKEN)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('POSTs params as a urlencoded body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'container1' }))
    await igFetch(cfg(fetchImpl), '178/media', {
      method: 'POST',
      params: { image_url: 'https://cdn.example/a.png', caption: 'hi there', is_carousel_item: undefined },
    })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.instagram.com/v25.0/178/media')
    const body = String(init.body)
    expect(body).toContain('image_url=https%3A%2F%2Fcdn.example%2Fa.png')
    expect(body).toContain('caption=hi+there')
    // undefined params are dropped, not sent as the string "undefined"
    expect(body).not.toContain('is_carousel_item')
  })

  it('retries a 5xx with backoff and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'transient', code: 2 } }, 500))
      .mockResolvedValueOnce(jsonResponse({ id: 'ok' }))
    const res = await igFetch<{ id: string }>(cfg(fetchImpl), 'me', {}, { backoffBaseMs: 1 })
    expect(res.id).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('NEVER retries an OAuth error — a dead token is not a transient failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }, 401),
    )
    const err = (await igFetch(cfg(fetchImpl), 'me', {}, { backoffBaseMs: 1 }).catch((e) => e)) as InstagramApiError
    expect(err).toBeInstanceOf(InstagramApiError)
    expect(err.isAuthError).toBe(true)
    expect(err.isTransient).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry a validation error (code 100) — replay can never succeed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2207023 } }, 400),
    )
    const err = (await igFetch(cfg(fetchImpl), '178/media', { method: 'POST' }, { backoffBaseMs: 1 }).catch((e) => e)) as InstagramApiError
    expect(err).toBeInstanceOf(InstagramApiError)
    expect(err.isTransient).toBe(false)
    expect(err.subcode).toBe(2207023)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats rate limits (429 / code 4) as transient and retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'limit', code: 4 } }, 429))
      .mockResolvedValueOnce(jsonResponse({ id: 'ok' }))
    const res = await igFetch<{ id: string }>(cfg(fetchImpl), 'me', {}, { backoffBaseMs: 1 })
    expect(res.id).toBe('ok')
  })

  it('retries network-level failures, then surfaces the last error when the budget runs out', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const err = (await igFetch(cfg(fetchImpl), 'me', {}, { retries: 2, backoffBaseMs: 1 }).catch((e) => e)) as Error
    expect(err).toBeInstanceOf(TypeError)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(isRetryable(err)).toBe(true)
  })
})

describe('redactToken', () => {
  it('scrubs the full token down to last-4 in any message', () => {
    const scrubbed = redactToken(`request to ?access_token=${TOKEN} failed`, TOKEN)
    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed).toContain(TOKEN.slice(-4))
  })

  it('leaves text alone for a missing or trivially short token', () => {
    expect(redactToken('hello', undefined)).toBe('hello')
    expect(redactToken('hello', 'abc')).toBe('hello')
  })
})
