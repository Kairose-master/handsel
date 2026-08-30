/**
 * The paywall's two halves must agree.
 *
 * `middleware.ts` holds an x402 price map keyed by `"<METHOD> <path>"`, and
 * a `config.matcher` listing the paths Next actually runs the middleware on.
 * A route priced in the first and missing from the second is not "expensive
 * but unprotected" — the middleware never executes for it at all, so it is
 * simply free.
 *
 * That is what happened to the office storefront. Every template was priced
 * in the map, pinned by test against lib/storefront-pricing.ts so it could
 * not be sold below its own pipeline cost — and the matcher listed three
 * other routes. A POST with a valid scope and no `X-PAYMENT` header
 * whatsoever returned `{"status":"commissioned"}`: a full escrowed office
 * pipeline, fronted from the prime's own wallet, for nothing. Verified live
 * against the rehearsal deployment before the fix.
 *
 * It survived because both halves read correctly on their own. The defect
 * exists only in the relationship between them, so only a test that holds
 * both at once can see it. docs/failure-modes.md §43, invariant 15.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

import { STOREFRONT_COMMISSIONS } from '@/lib/storefront-pricing'
import { anyMatcherCovers, matcherCovers } from '@/lib/x402-matcher'

const src = readFileSync('middleware.ts', 'utf8')

/** The matcher literal, read from source — it must stay a literal for Next
 *  to analyze it, so source is the only place it can be read from. */
function matcherPatterns(): string[] {
  const block = src.match(/matcher:\s*\[([\s\S]*?)\]/)
  if (!block) throw new Error('middleware.ts has no config.matcher array')
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Every path the x402 price map charges for. The two static entries are
 *  read from source; the storefront ones are generated from the same
 *  constant middleware.ts generates them from. */
function pricedPaths(): string[] {
  const fromSource = [...src.matchAll(/'(?:GET|POST) (\/api\/[^']+)':/g)].map((m) => m[1])
  const storefront = STOREFRONT_COMMISSIONS.map((c) => `/api/storefront/${c.templateId}/commission`)
  return [...new Set([...fromSource, ...storefront])]
}

describe('every priced x402 route is actually covered by the matcher', () => {
  it('finds both halves of the paywall', () => {
    expect(matcherPatterns().length).toBeGreaterThan(0)
    expect(pricedPaths().length).toBeGreaterThan(0)
  })

  it('leaves no priced route outside the matcher', () => {
    const patterns = matcherPatterns()
    const uncovered = pricedPaths().filter((p) => !anyMatcherCovers(patterns, p))
    // A route in this list is served for FREE, whatever the price map says.
    expect(uncovered).toEqual([])
  })

  it('covers every storefront template, including ones added later', () => {
    const patterns = matcherPatterns()
    for (const c of STOREFRONT_COMMISSIONS) {
      expect(anyMatcherCovers(patterns, `/api/storefront/${c.templateId}/commission`)).toBe(true)
    }
  })
})

describe('matcherCovers', () => {
  it('matches literal paths and :params', () => {
    expect(matcherCovers('/api/jobs/external', '/api/jobs/external')).toBe(true)
    expect(matcherCovers('/api/agents/:id/report', '/api/agents/abc/report')).toBe(true)
    expect(matcherCovers('/api/storefront/:t/commission', '/api/storefront/venture-lab/commission')).toBe(true)
  })

  it('does not match a different path or a different segment count', () => {
    expect(matcherCovers('/api/jobs/external', '/api/jobs/internal')).toBe(false)
    expect(matcherCovers('/api/agents/:id/report', '/api/agents/abc')).toBe(false)
    expect(matcherCovers('/api/agents/:id/report', '/api/agents/abc/report/extra')).toBe(false)
  })

  it('reports no coverage for syntax it does not understand, rather than guessing', () => {
    expect(matcherCovers('/api/(.*)', '/api/anything')).toBe(false)
  })
})
