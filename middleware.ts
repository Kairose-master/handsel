import { NextResponse, type NextRequest } from 'next/server'
import { paymentMiddleware } from 'x402-next'
import { cdpFacilitator, cdpKeyFromEnv } from '@/lib/cdp-facilitator'
import { x402RoutesConfig } from '@/lib/x402-catalog'
import { x402NetworkFor } from '@/lib/x402-network'

/**
 * x402 paywall — the first real revenue rail.
 *
 * GET /api/agents/:id/report (the full underwritten credit report) costs
 * $0.01 in USDC per request, paid machine-to-machine over the x402
 * protocol (HTTP 402 + X-PAYMENT header, Linux Foundation standard). This
 * is the "pay-per-query credit check" business model wired up for real:
 * an agent that wants another agent's credit report pays for it, no
 * account, no API key, one HTTP roundtrip.
 *
 * Payment settles via the public x402 facilitator, on the network that
 * matches ONCHAIN_CHAIN — see lib/x402-network.ts.
 *
 * This used to be the literal 'base-sepolia' on every route, justified as the
 * payment rail being "deliberately independent of ONCHAIN_CHAIN, because the
 * payment rail doesn't need to live where the credit contracts live." True of
 * a credit report, which is a data sale. Not true of the two routes that FUND
 * ESCROW: on a Base mainnet deployment they answered a faucet token that costs
 * nothing to mint with real Circle USDC locked in a real escrow. Every guard
 * on those routes bounds how MUCH; none of them checked WHAT.
 *
 * Fully optional, same convention as the rest of the on-chain layer:
 * without X402_PAY_TO set, the paywall disappears and the report is free.
 */
const payTo = process.env.X402_PAY_TO as `0x${string}` | undefined
const X402_NETWORK = x402NetworkFor(process.env.ONCHAIN_CHAIN)

/**
 * Which facilitator settles. The CDP facilitator (lib/cdp-facilitator.ts)
 * whenever CDP_API_KEY_ID + CDP_API_KEY_SECRET are set — that is the one
 * whose settlements list this deployment in the x402 Bazaar. Otherwise the
 * public x402.org facilitator, as before (testnet rehearsal, or a deployment
 * that has not asked to be discovered).
 */
const cdpKey = cdpKeyFromEnv()
const facilitator = cdpKey
  ? cdpFacilitator(cdpKey)
  : { url: (process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator') as `${string}://${string}` }

// The price map lives in lib/x402-catalog.ts — one place that also carries
// each resource's input/output schema and `discoverable: true`, so what the
// Bazaar indexes and what the paywall charges cannot drift apart.
const x402 = payTo ? paymentMiddleware(payTo, x402RoutesConfig(X402_NETWORK), facilitator) : null

export default async function middleware(request: NextRequest) {
  // m.<host> — the mobile surface. A phone hitting the root or the office
  // gets the full-screen touch office at /m (app/(mobile)/m) instead of the
  // desktop deck; every other path behaves the same on both hosts, so
  // sign-in, webhooks and the API need no mobile fork. A REWRITE, not a
  // redirect: the address bar keeps m.<host>.
  const host = request.headers.get('host') ?? ''
  const { pathname } = request.nextUrl
  if (host.startsWith('m.') && (pathname === '/' || pathname === '/office')) {
    const url = request.nextUrl.clone()
    url.pathname = '/m'
    return NextResponse.rewrite(url)
  }

  // A stranger's first click lands on '/', which is the signed-in deck: its
  // client layout fetches /api/me, gets a 401, and only then routes to
  // /guest — so the promo link's first paint was the word "Loading…". Cookie
  // presence is not a session check (the deck layout still verifies), but no
  // session cookie at all means there is nothing to verify: send them
  // straight to the public landing, server-side.
  //
  // `auth_session` is the cookie /api/signin actually sets and
  // lib/get-session.ts actually reads. The first version of this check
  // looked for better-auth's default cookie name instead — which this app's
  // custom signin route never sets — so every LOGGED-IN user was bounced
  // from '/' back to /guest and sign-in appeared to do nothing at all.
  // The better-auth name stays accepted for any session issued that way.
  const hasSession = request.cookies.getAll().some(
    (c) => c.name === 'auth_session' || c.name.endsWith('better-auth.session_token'),
  )
  if (pathname === '/' && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/guest'
    return NextResponse.redirect(url)
  }

  // Everything past here is the x402 paywall, which prices API routes only —
  // the page paths the matcher now also carries must not fall through into
  // it (paymentMiddleware would pass them anyway, but that is its internal
  // behavior, not a contract this file should lean on).
  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (!x402) return NextResponse.next()
  return x402(request)
}

/**
 * Which paths the middleware actually RUNS on.
 *
 * This list and the price map above are two halves of one paywall, and for
 * the whole life of the storefront feature they disagreed: the map priced
 * `POST /api/storefront/<template>/commission`, and this matcher did not
 * include it, so Next never invoked the middleware on that path and the
 * route served for free. A POST with a valid scope and no `X-PAYMENT`
 * header at all came back `{"status":"commissioned"}` — a full escrowed
 * office pipeline, fronted from the prime's own wallet, given away.
 *
 * Nothing surfaced it because both halves looked right in isolation: the
 * price map names every template and is pinned by test against
 * storefront-pricing.ts, and the matcher is three plausible entries. The
 * bug lives only in their relationship. tests/x402-paywall-coverage.test.ts
 * now asserts that every priced route is covered here — see
 * docs/failure-modes.md §43.
 *
 * Next requires this to be statically analyzable, so it stays a literal
 * rather than being derived from STOREFRONT_COMMISSIONS; the test is what
 * keeps the literal honest.
 */
export const config = {
  matcher: [
    '/api/agents/:id/report',
    '/api/jobs/external',
    '/api/market/index',
    '/api/storefront/:template/commission',
    // Not paywall routes: these two exist so the m.<host> rewrite above
    // actually runs on the paths it rewrites.
    '/',
    '/office',
  ],
}
