/**
 * Does a Next.js middleware `matcher` pattern cover a given path?
 *
 * Exists because a paywall made of two independently-correct halves failed
 * at the seam: `middleware.ts` priced `POST /api/storefront/<template>/
 * commission` in its x402 map, and its `config.matcher` did not list that
 * path, so Next never ran the middleware there and the route served for
 * free. Neither half is wrong on its own reading, which is exactly why it
 * survived — see docs/failure-modes.md §43.
 *
 * Next requires `config.matcher` to be statically analyzable, so it cannot
 * be derived from the price map at build time. The relationship therefore
 * has to be enforced by a test instead, and a test needs this predicate.
 *
 * Deliberately covers only the subset of the matcher syntax this codebase
 * uses — literal segments and `:named` params. It is not a path-to-regexp
 * reimplementation, and it errs toward NOT matching: a pattern it cannot
 * interpret reports "not covered", which fails the test loudly rather than
 * quietly certifying a route as paid.
 */

/** True when `pattern` (a Next matcher entry) covers `path`. */
export function matcherCovers(pattern: string, path: string): boolean {
  // Anything beyond literal segments and :params — regex groups, modifiers,
  // wildcards — is outside what this understands. Report no coverage.
  if (/[(){}*+?[\]|]/.test(pattern)) return false

  const pat = pattern.split('/').filter(Boolean)
  const got = path.split('/').filter(Boolean)
  if (pat.length !== got.length) return false

  return pat.every((seg, i) => {
    if (seg.startsWith(':')) return got[i].length > 0
    return seg === got[i]
  })
}

/** True when ANY pattern in the list covers the path. */
export function anyMatcherCovers(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matcherCovers(p, path))
}
