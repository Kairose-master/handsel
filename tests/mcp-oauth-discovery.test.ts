/**
 * The OAuth discovery chain an MCP client (Claude, ChatGPT, the Inspector)
 * walks before it can show a login button:
 *
 *   POST /api/mcp (no token) → 401 + WWW-Authenticate: Bearer resource_metadata="…"
 *     → GET /.well-known/oauth-protected-resource → authorization_servers[0]
 *       → GET /.well-known/oauth-authorization-server → authorize / token / register
 *
 * Every link is pinned here because the chain was once diagnosed as absent
 * from a raw `401 {"error":"invalid_token"}` alone — the header on that very
 * response is link one. If any of these change shape, the connector's
 * "Authenticate" button stops knowing where to go.
 */
import { describe, expect, it } from 'vitest'
import { unauthorizedMcp, requestOrigin, isAllowedRedirectUri } from '@/lib/oauth'
import { GET as protectedResource } from '@/app/api/oauth/protected-resource/route'
import { GET as serverMetadata } from '@/app/api/oauth/metadata/route'

const ORIGIN = 'https://handsel-main.vercel.app'
const req = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { host: 'handsel-main.vercel.app', 'x-forwarded-proto': 'https' } })

describe('MCP OAuth discovery chain', () => {
  it('401 carries the RFC 9728 resource_metadata pointer (link one)', async () => {
    const res = unauthorizedMcp(ORIGIN)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    )
    expect(await res.json()).toEqual({ error: 'invalid_token' })
  })

  it('protected-resource metadata names /api/mcp and points at this origin as the AS (link two)', async () => {
    const body = await (await protectedResource(req('/.well-known/oauth-protected-resource'))).json()
    expect(body.resource).toBe(`${ORIGIN}/api/mcp`)
    expect(body.authorization_servers).toEqual([ORIGIN])
    expect(body.bearer_methods_supported).toContain('header')
  })

  it('authorization-server metadata exposes authorize, token and registration with PKCE S256 (link three)', async () => {
    const body = await (await serverMetadata(req('/.well-known/oauth-authorization-server'))).json()
    expect(body.issuer).toBe(ORIGIN)
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`)
    expect(body.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`)
    expect(body.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`)
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.response_types_supported).toEqual(['code'])
    // Public clients: Claude registers without a secret and proves possession with PKCE.
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('the pointer in link one resolves to the same origin the metadata is issued for', () => {
    // The 401 header is built from the request origin, the metadata from the
    // same helper — a proxy header mismatch would send clients to the wrong host.
    expect(requestOrigin(req('/api/mcp'))).toBe(ORIGIN)
    const pointer = unauthorizedMcp(requestOrigin(req('/api/mcp'))).headers.get('www-authenticate')
    expect(pointer).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`)
  })
})

describe('dynamic registration redirect_uri policy (RFC 8252 loopback)', () => {
  it('accepts https anywhere and plain http only on loopback', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:51234/callback')).toBe(true) // Claude Code
    expect(isAllowedRedirectUri('http://127.0.0.1:51234/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://[::1]:51234/callback')).toBe(true)
  })

  it('rejects everything that could carry a code off the machine in the clear', () => {
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false)
    expect(isAllowedRedirectUri('http://localhost.evil.com/callback')).toBe(false)
    expect(isAllowedRedirectUri('http://127.0.0.1.evil.com/callback')).toBe(false)
    expect(isAllowedRedirectUri('ftp://localhost/callback')).toBe(false)
    expect(isAllowedRedirectUri('not a url')).toBe(false)
  })
})
