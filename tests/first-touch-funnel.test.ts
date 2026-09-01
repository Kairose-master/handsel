import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The first-time visitor's path, walked as a stranger (2026-09-01) against
 * the live promo domain — every pin below is a break that was actually hit:
 *
 *  - /try "Run it now" returned 500 "demo engine not configured" on mainnet:
 *    the demo borrowed the faucet's system user, and the faucet only ever
 *    ran on testnet. The front-door funnel was dead on the exact deployment
 *    the promo points at.
 *  - /start hardcoded the GitHub App slug `handsel-jobs` while the code has
 *    an env-derived resolver (appInstallUrl) — one App per deployment means
 *    a hardcoded slug is wrong on every deployment but one.
 *  - `npx handsel-worker --help` printed a token error (non-TTY) or dropped
 *    the person into the email login prompt (TTY).
 *  - a signed-out click on '/' rendered "Loading…" then client-redirected
 *    to /guest — the promo link's first paint was a spinner.
 *
 * Source pins, same style as job-visibility-scope.test.ts: the call sites
 * read the DB / env at module load, so the wiring is what can be checked.
 */

const raw = (p: string) => readFileSync(p, 'utf8')

describe('/try demo engine works where the faucet never ran', () => {
  it('demo-run self-provisions its system user instead of requiring the faucet feature', () => {
    const src = raw('lib/demo-run.ts')
    expect(src).toContain('ensureFaucetAgent')
    // Provisioning must live inside faucetOwnerId so BOTH the missing-row
    // read sites (media grading and the text path) get it.
    const body = src.slice(src.indexOf('async function faucetOwnerId'))
    expect(body.indexOf('ensureFaucetAgent')).toBeGreaterThan(-1)
    expect(body.indexOf('ensureFaucetAgent')).toBeLessThan(body.indexOf('export async function generateImage'))
  })
})

describe('/start sends the requester to THIS deployment\'s GitHub App', () => {
  it('uses the env-derived install URL, never a hardcoded slug', () => {
    const src = raw('app/start/page.tsx')
    expect(src).toContain('appInstallUrl()')
    expect(src).not.toContain('apps/handsel-jobs')
  })
})

describe('npx handsel-worker --help is help, not a login prompt', () => {
  it('handles --help/-h before any token or login logic', () => {
    const src = raw('public/handsel-worker.mjs')
    const helpAt = src.indexOf("args.includes('--help')")
    expect(helpAt).toBeGreaterThan(-1)
    expect(src.slice(helpAt)).toContain("args.includes('-h')")
    expect(helpAt).toBeLessThan(src.indexOf('async function loginFlow'))
    expect(helpAt).toBeLessThan(src.indexOf("flag('token')"))
    // Help exits cleanly — it must not fall through into the poll loop.
    const helpBlock = src.slice(helpAt, src.indexOf('process.exit(0)', helpAt) + 20)
    expect(helpBlock).toContain('process.exit(0)')
  })
})

describe("a stranger's click on '/' lands on the public landing server-side", () => {
  it('middleware redirects a session-less / to /guest', () => {
    const src = raw('middleware.ts')
    const at = src.indexOf('better-auth.session_token')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 400)
    expect(block).toContain("url.pathname = '/guest'")
    expect(block).toContain('NextResponse.redirect')
    // The matcher must actually run the middleware on '/'.
    expect(src).toContain("'/',")
  })

  it("the mobile m.<host> rewrite still wins over the guest redirect", () => {
    const src = raw('middleware.ts')
    expect(src.indexOf("url.pathname = '/m'")).toBeLessThan(src.indexOf("url.pathname = '/guest'"))
  })
})
