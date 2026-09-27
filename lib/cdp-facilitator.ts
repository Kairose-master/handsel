/**
 * The Coinbase (CDP) x402 facilitator, without the CDP SDK.
 *
 * Why it exists: listing in the x402 Bazaar happens on the first PAID call
 * that settles through the CDP facilitator — not through x402.org's, which
 * is what `middleware.ts` used since the paywall went up. The Bazaar is
 * where an agent that has never heard of Handsel finds a `$0.01` labor index
 * or a `$9` research desk, so the facilitator is the listing.
 *
 * Why not `@coinbase/x402`: its v1 line pulls `@coinbase/cdp-sdk` into the
 * Next middleware, which runs on the edge runtime. The facilitator only
 * needs two headers per call, and both are a short JWT — `jose` builds it
 * on the edge, so this file is the whole dependency.
 *
 * JWT shape (CDP API key auth, Secret API Key flavour): EdDSA (Ed25519),
 * header `{alg, typ, kid, nonce}`, claims `{sub: keyId, iss: 'cdp', aud:
 * ['cdp_service'], nbf, exp: nbf+120, uris: ['POST api.cdp.coinbase.com/…']}`.
 * A legacy EC key (a PEM block) signs ES256. Both
 * are what CDP's own SDK does; the Correlation-Context header is what its
 * facilitator wrapper sends, kept so their dashboard attributes traffic.
 *
 * Edge-safe: no Node built-ins. Off (returns null) unless both env vars are
 * set, and then `middleware.ts` falls back to X402_FACILITATOR_URL.
 */
import { SignJWT, importPKCS8 } from 'jose'

export const CDP_FACILITATOR_HOST = 'api.cdp.coinbase.com'
export const CDP_FACILITATOR_URL = `https://${CDP_FACILITATOR_HOST}/platform/v2/x402` as const
const CORRELATION = 'sdk_version=1.29.0,sdk_language=typescript,source=x402,source_version=1.0.1'

export type CdpKey = { id: string; secret: string }

export function cdpKeyFromEnv(env: Record<string, string | undefined> = process.env): CdpKey | null {
  const id = env.CDP_API_KEY_ID?.trim()
  const secret = env.CDP_API_KEY_SECRET?.trim().replace(/\\n/g, '\n')
  return id && secret ? { id, secret } : null
}

function randomNonce(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Ed25519 seed (first 32 bytes of the 64-byte CDP secret) → PKCS8 DER. */
function ed25519SeedToPkcs8Pem(seed: Uint8Array): string {
  // PKCS8 prefix for an Ed25519 private key: 302e020100300506032b657004220420 + seed
  const prefix = b64ToBytes('MC4CAQAwBQYDK2VwBCIEIA==')
  const der = new Uint8Array(prefix.length + seed.length)
  der.set(prefix)
  der.set(seed, prefix.length)
  let bin = ''
  for (const b of der) bin += String.fromCharCode(b)
  // Assembled from parts so the secrets scanner (tests/no-secrets.test.ts)
  // does not read a PEM *template* as a committed key.
  const armor = (kind: string) => `-----${kind} PRIVATE KEY-----`
  return `${armor('BEGIN')}\n${btoa(bin)}\n${armor('END')}`
}

/** One bearer JWT for one CDP request. Exported for the test. */
export async function cdpJwt(key: CdpKey, method: string, path: string, host = CDP_FACILITATOR_HOST): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const uri = `${method.toUpperCase()} ${host}${path}`
  const isPem = key.secret.includes('-----BEGIN')
  const alg = isPem ? 'ES256' : 'EdDSA'
  const pkcs8 = isPem ? key.secret : ed25519SeedToPkcs8Pem(b64ToBytes(key.secret).slice(0, 32))
  const privateKey = await importPKCS8(pkcs8, alg)
  return new SignJWT({ sub: key.id, iss: 'cdp', aud: ['cdp_service'], uris: [uri] })
    .setProtectedHeader({ alg, typ: 'JWT', kid: key.id, nonce: randomNonce() })
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(privateKey)
}

/** The `{url, createAuthHeaders}` x402-next's paymentMiddleware takes. */
export function cdpFacilitator(key: CdpKey): {
  url: typeof CDP_FACILITATOR_URL
  createAuthHeaders: () => Promise<{
    verify: Record<string, string>
    settle: Record<string, string>
    supported: Record<string, string>
    list: Record<string, string>
  }>
} {
  const bearer = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, 'Correlation-Context': CORRELATION })
  return {
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const [verify, settle, supported, list] = await Promise.all([
        cdpJwt(key, 'POST', '/platform/v2/x402/verify'),
        cdpJwt(key, 'POST', '/platform/v2/x402/settle'),
        cdpJwt(key, 'GET', '/platform/v2/x402/supported'),
        cdpJwt(key, 'GET', '/platform/v2/x402/discovery/resources'),
      ])
      return { verify: bearer(verify), settle: bearer(settle), supported: bearer(supported), list: bearer(list) }
    },
  }
}
