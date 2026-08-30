import Link from 'next/link'
import { SiteFooter } from '@/components/site-footer'

/**
 * One shell for every page a stranger can reach.
 *
 * Four public pages had each grown their own header — `h-16` on two, `h-14`
 * on a third, three different border treatments, three different navs, and
 * three different container widths (1100px, 1200px, `max-w-2xl`). Nothing was
 * shared, so nothing could be improved once.
 *
 * Worse than untidy: `SiteFooter` — which carries the environment disclosure
 * and the only links to the privacy policy and terms — was rendered by
 * exactly ONE of them. On a deployment handling real USDC, three public pages
 * had no disclosure and no legal links at all. The component existed and was
 * unreachable, which is the same defect this repo keeps catching itself in
 * (docs/failure-modes.md §42, §43, §53) — this time in the layout.
 *
 * So the shell is not a style decision. It is the thing that makes "every
 * public page discloses its environment" true by construction instead of by
 * remembering.
 */

/** Where a stranger can go, in the order they are useful to one. Defined once
 *  so a new public page joins the nav by existing, not by four edits. */
const NAV = [
  { href: '/guest', label: 'Home' },
  { href: '/directory', label: 'Tools' },
  { href: '/live', label: 'Live' },
  { href: '/try', label: 'Try it' },
] as const

export type ShellTone =
  /** The product surface. */
  | 'light'
  /** The spectacle page, which is a dark room on purpose and should not be
   *  flattened into the rest just to share a header. */
  | 'dark'

export type ShellWidth =
  /** A reading column. Roughly 65 characters, which is where prose stops
   *  being comfortable. */
  | 'prose'
  /** The default page body. */
  | 'default'
  /** Data and grids that genuinely need the room. */
  | 'wide'

const WIDTH: Record<ShellWidth, string> = {
  prose: 'max-w-2xl',
  default: 'max-w-5xl',
  wide: 'max-w-[1200px]',
}

export function PublicShell({
  current,
  eyebrow,
  tone = 'light',
  width = 'default',
  realMoney = null,
  children,
}: {
  /** The nav entry to mark as the current page. Nothing is marked when this
   *  is omitted, which is better than marking the wrong one. */
  current?: string
  /** A second line under the wordmark — what THIS page is. */
  eyebrow?: React.ReactNode
  tone?: ShellTone
  width?: ShellWidth
  /** Tri-state, and passed straight through: `null` means the caller does not
   *  know, and SiteFooter renders no disclosure rather than guessing one. */
  realMoney?: boolean | null
  children: React.ReactNode
}) {
  const dark = tone === 'dark'
  return (
    <div className={dark ? 'min-h-dvh bg-[#0b0d10] text-white' : 'min-h-dvh bg-background text-foreground'}>
      {/* Keyboard users land on a sticky header on every page; without this
          they tab through the whole nav before reaching the content. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-20 flex h-16 items-center gap-3 border-b px-4 backdrop-blur-md md:px-6 ${
          dark ? 'border-white/10 bg-black/40' : 'border-border bg-background/80'
        }`}
      >
        <Link href="/guest" className="flex items-center gap-3 rounded-md hover:opacity-80" title="Handsel home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Handsel" className="size-8 shrink-0" />
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight">Handsel</span>
            {eyebrow ? (
              <span className={`block text-[11px] ${dark ? 'text-white/50' : 'text-muted-foreground'}`}>{eyebrow}</span>
            ) : null}
          </span>
        </Link>

        <nav aria-label="Main" className="ml-auto flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.href === current
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`hidden rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:inline-flex ${
                  active
                    ? dark
                      ? 'bg-white/10 text-white'
                      : 'bg-secondary text-foreground'
                    : dark
                      ? 'text-white/60 hover:bg-white/5 hover:text-white'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
          <Link
            href="/connect"
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-opacity hover:opacity-90 ${
              dark ? 'bg-white text-black' : 'bg-primary text-primary-foreground'
            }`}
          >
            Connect an agent
          </Link>
        </nav>
      </header>

      <main id="content" className={`mx-auto w-full px-4 py-8 md:px-6 md:py-12 ${WIDTH[width]}`}>
        {children}
        {!dark && <SiteFooter realMoney={realMoney} />}
      </main>
      {/* The dark page keeps its own ground, but not at the cost of the
          disclosure — the footer goes outside the tinted main so it reads on
          the page's own background rather than fighting it. */}
      {dark && (
        <div className="mx-auto w-full max-w-[1200px] px-4 md:px-6">
          <div className="text-white/60">
            <SiteFooter realMoney={realMoney} />
          </div>
        </div>
      )}
    </div>
  )
}
