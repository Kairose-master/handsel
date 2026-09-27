import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { LocaleProvider } from '@/lib/i18n'
import './globals.css'
import { origin } from '@/lib/origin'
import { isRealMoney } from '@/lib/onchain/real-money'
import { PUBLIC_ROUTE_PREFIXES } from '@/lib/public-routes'
import { ThemeRouteSync } from '@/components/theme-route-sync'

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
  title: 'Handsel — x402 pays. Proof first.',
  description:
    'x402 makes agent payments possible. Handsel adds job escrow, separate evaluation, and settlement after accepted work. Approved outcomes can become signed work proofs.' +
    (REAL ? '' : ' Testnet, no real money.'),
  generator: 'v0.app',
  openGraph: {
    title: 'Handsel — x402 pays. Proof first.',
    description:
      'Jobs are funded into escrow, reviewed by someone other than the worker, and settled by the verdict.' +
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
    title: 'Handsel — x402 pays. Proof first.',
    description:
      'Jobs are funded into escrow, reviewed by someone other than the worker, and settled by the verdict.' +
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
        {/* The pre-paint script above handles the first load; this handles
            every client navigation after it, which is how signing out used
            to land on the marketing page still wearing the dark deck. */}
        <ThemeRouteSync />
        <LocaleProvider>{children}</LocaleProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
