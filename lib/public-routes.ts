/**
 * Which URLs a stranger can reach without an account.
 *
 * Written down because the app now has two visual identities and something
 * has to decide which one a page opens in, before paint, from the URL alone.
 * The authenticated app is the **deck**: dark, dense, the same navy and cyan
 * the 3D office is built from. The public pages are ledger paper: light,
 * quiet, and aimed at a first-time visitor who has never heard of any of
 * this. Those are different jobs and the wrong default on either is a real
 * cost — a marketing page that opens black reads as a developer tool, and an
 * operations console that opens white reads as a form.
 *
 * A list of route prefixes is the only thing available to a script that has
 * to run before React does, so it is a list — but `tests/deck-theme.test.ts`
 * walks `app/` and fails when a new public route is added and not classified
 * here, which is the part that keeps the list from rotting.
 */
export const PUBLIC_ROUTE_PREFIXES = [
  'agent',
  'challenge',
  'connect',
  'directory',
  'disputes',
  'examples',
  'guest',
  'live',
  'oauth',
  'participation',
  'privacy',
  'proof',
  'sign-in',
  'sign-up',
  'solana',
  'start',
  'terms',
  'try',
] as const

/**
 * Whether a path belongs to the public site rather than the deck.
 *
 * `/` is the dashboard root, so an unlisted path is treated as deck — the
 * safer default of the two, since every deck route sits behind a session
 * check that bounces a stranger to `/guest` anyway.
 */
export function isPublicPath(pathname: string): boolean {
  const first = pathname.split('/')[1] ?? ''
  return (PUBLIC_ROUTE_PREFIXES as readonly string[]).includes(first)
}
