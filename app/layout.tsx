import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono, Archivo_Black } from 'next/font/google'
import { LocaleProvider } from '@/lib/i18n'
import './globals.css'
import { origin } from '@/lib/origin'
import { isRealMoney } from '@/lib/onchain/real-money'

// Geist Sans, replacing Inter (2026-08-25). The Nocturne handoff specified
// Inter, and that is a real decision being overridden here, so the reason is
// written down: Inter is the single most common default in this product
// category, and the page already ran Geist Mono for numerals and hashes — so
// the pairing was a generic face beside a characterful one. Geist Sans is that
// mono's own sans, which makes the two a designed pair rather than a
// coincidence, at no new dependency (both come from next/font/google).
const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
// Macro display face for the public landing's brutalist substrate (.bp in
// globals.css). Declared here because next/font must be called at module
// scope in a layout; nothing outside .bp-macro references it, so the
// dashboard never renders it.
const archivoBlack = Archivo_Black({ subsets: ['latin'], weight: '400', variable: '--font-archivo' })

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
    card: 'summary',
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

/** Runs before paint so the stored theme applies without a flash.
 *  Light ("ledger paper") is the default now — friendlier for first-time,
 *  non-technical visitors; dark is opt-in and remembered per browser. */
const themeInit = `try{var t=localStorage.getItem('theme');document.documentElement.classList.toggle('dark',t==='dark')}catch(e){}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${archivoBlack.variable} bg-background`} suppressHydrationWarning>
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
