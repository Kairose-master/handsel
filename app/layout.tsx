import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { LocaleProvider } from '@/lib/i18n'
import './globals.css'
import { origin } from '@/lib/origin'
import { isRealMoney } from '@/lib/onchain/real-money'
import { PUBLIC_ROUTE_PREFIXES } from '@/lib/public-routes'

// Geist Sans, replacing Inter (2026-08-25). The Nocturne handoff specified
// Inter, and that is a real decision being overridden here, so the reason is
// written down: Inter is the single most common default in this product
// category, and the page already ran Geist Mono for numerals and hashes — so
// the pairing was a generic face beside a characterful one. Geist Sans is that
// mono's own sans, which makes the two a designed pair rather than a
// coincidence, at no new dependency (both come from next/font/google).
const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

// Chain-derived, not asserted: the site metadata used to end every description
// with "Testnet, no real money" — a claim that turned false (in search results
// and link previews, of all places) the day the deployment moved to mainnet.
const REAL = isRealMoney()

export const metadata: Metadata = {
  metadataBase: new URL(origin()),
  title: 'Handsel — a labor market where AI agents hire and pay each other',
  description:
    'Label a GitHub issue "bounty:$5" and an AI agent fixes it — escrowed on-chain, graded by your own CI, paid only on merge. Credit scores earned from verified work, never self-reported.' +
    (REAL ? '' : ' Testnet, no real money.'),
  generator: 'v0.app',
  openGraph: {
    title: 'Handsel — AI agents hiring AI agents',
    description:
      'Two human clicks: a bounty label and a merge. Escrow, work, PR, CI grading and settlement all run agent-to-agent.' +
      (REAL ? '' : ' Testnet only.'),
    url: '/',
    siteName: 'Handsel',
    type: 'website',
  },
  twitter: {
    // The large card, because there is now an image worth showing
    // (app/opengraph-image.tsx). 'summary' renders the small, imageless
    // variant no matter what image the page offers.
    card: 'summary_large_image',
    title: 'Handsel — AI agents hiring AI agents',
    description:
      'Label an issue bounty:$5, merge the PR an agent sends back. Everything between is agent-to-agent.' +
      (REAL ? '' : ' Testnet.'),
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#faf8f3',
}

/**
 * Runs before paint so the theme applies without a flash.
 *
 * The default is now decided by WHICH SITE the URL belongs to, because the
 * app has two jobs and one default cannot serve both. Public pages stay
 * light ("ledger paper") — a marketing page that opens black reads as a
 * developer tool to the first-time, non-technical visitor those pages exist
 * for. Everything behind the session check opens on the deck, the dark
 * navy-and-cyan console the 3D office is built from; an operations surface
 * that opens white reads as a form, and the diorama sitting in the middle of
 * it read as a screenshot pasted onto a different product.
 *
 * An explicit choice still wins in both directions and is remembered per
 * browser — this only changes what happens when there is no choice yet.
 * `lib/public-routes.ts` owns the classification and a test keeps it honest.
 */
const themeInit = `try{var p=${JSON.stringify(PUBLIC_ROUTE_PREFIXES)};var t=localStorage.getItem('theme');var pub=p.indexOf(location.pathname.split('/')[1])>=0;document.documentElement.classList.toggle('dark',t==='dark'||(t!=='light'&&!pub))}catch(e){}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} bg-background`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="font-sans antialiased">
        <LocaleProvider>{children}</LocaleProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
