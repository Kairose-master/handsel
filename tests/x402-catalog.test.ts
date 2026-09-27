import { describe, expect, it } from 'vitest'
import { STOREFRONT_COMMISSIONS } from '@/lib/storefront-pricing'
import { BAZAAR_DESCRIPTION_MAX, X402_RESOURCES, routeConfigFor, x402Listing, x402RoutesConfig } from '@/lib/x402-catalog'
import { cdpJwt, cdpKeyFromEnv, cdpFacilitator, CDP_FACILITATOR_URL } from '@/lib/cdp-facilitator'
import { decodeProtectedHeader, decodeJwt } from 'jose'

/**
 * The Bazaar indexes what the paywall describes. These pin the listing
 * requirements the CDP docs state (description ≤ 500 chars, discoverable,
 * an input schema and an output example per resource), that the price map
 * still carries every storefront template at its pinned price, and that the
 * CDP auth JWT has the exact shape CDP's own SDK produces.
 */
describe('x402 catalog — Bazaar-ready metadata', () => {
  it('every resource is discoverable with a description under the Bazaar cap and an output example', () => {
    for (const r of X402_RESOURCES) {
      expect(r.description.length, r.route).toBeLessThanOrEqual(BAZAAR_DESCRIPTION_MAX)
      expect(r.description.length, r.route).toBeGreaterThan(40)
      expect(r.outputSchema.example, r.route).toBeTruthy()
      const cfg = routeConfigFor(r, 'base')
      expect(cfg.config.discoverable).toBe(true)
      expect(cfg.config.inputSchema).toBeDefined()
    }
  })
  it('a POST resource declares its JSON body fields', () => {
    for (const r of X402_RESOURCES.filter((x) => x.route.startsWith('POST'))) {
      expect(r.inputSchema.bodyType, r.route).toBe('json')
      expect(Object.keys(r.inputSchema.bodyFields ?? {}).length, r.route).toBeGreaterThan(0)
    }
  })
  it('carries every storefront template at its pinned price', () => {
    const map = x402RoutesConfig('base-sepolia')
    for (const c of STOREFRONT_COMMISSIONS) {
      expect(map[`POST /api/storefront/${c.templateId}/commission`]?.price).toBe(`$${c.priceUsd.toFixed(2)}`)
    }
    expect(map['GET /api/market/index']?.price).toBe('$0.01')
    expect(map['GET /api/agents/*/report']?.price).toBe('$0.01')
    expect(map['POST /api/jobs/external']?.price).toBe('$0.10')
  })
  it('the public listing turns route patterns into absolute URLs', () => {
    const listing = x402Listing('https://handsel.example', 'base', '0x' + 'ab'.repeat(20))
    expect(listing.resources.find((r) => r.url === 'https://handsel.example/api/market/index')?.method).toBe('GET')
    expect(listing.resources.length).toBe(X402_RESOURCES.length)
  })
})

describe('CDP facilitator auth', () => {
  it('is off without both env vars', () => {
    expect(cdpKeyFromEnv({})).toBeNull()
    expect(cdpKeyFromEnv({ CDP_API_KEY_ID: 'k' })).toBeNull()
  })
  it('unescapes a literal \\n in the secret', () => {
    expect(cdpKeyFromEnv({ CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: 'a\\nb' })?.secret).toBe('a\nb')
  })
  it('signs an EdDSA JWT with the CDP claim shape from a 64-byte base64 secret', async () => {
    // A throwaway Ed25519 seed + (any) 32 more bytes, base64 — the format CDP hands out.
    const seed = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
    const secret = Buffer.concat([Buffer.from(seed), Buffer.alloc(32)]).toString('base64')
    const key = { id: '6b6e4e2a-0000-4000-8000-000000000000', secret }
    const jwt = await cdpJwt(key, 'POST', '/platform/v2/x402/settle')
    const header = decodeProtectedHeader(jwt)
    expect(header.alg).toBe('EdDSA')
    expect(header.kid).toBe(key.id)
    expect(String(header.nonce)).toMatch(/^[0-9a-f]{16}$/)
    const claims = decodeJwt(jwt)
    expect(claims.sub).toBe(key.id)
    expect(claims.iss).toBe('cdp')
    expect(claims.aud).toEqual(['cdp_service'])
    expect(claims.uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/x402/settle'])
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(120)
    const f = cdpFacilitator(key)
    expect(f.url).toBe(CDP_FACILITATOR_URL)
    const headers = await f.createAuthHeaders()
    expect(headers.verify.Authorization).toMatch(/^Bearer /)
    expect(headers.settle['Correlation-Context']).toContain('source=x402')
  })
})
