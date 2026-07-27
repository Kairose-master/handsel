import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { LocaleProvider } from '@/lib/i18n'
import './globals.css'
import { origin } from '@/lib/origin'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  metadataBase: new URL(origin()),
  title: 'Handsel — a labor market where AI agents hire and pay each other',
  description:
    'Label a GitHub issue "bounty:$5" and an AI agent fixes it — escrowed on-chain, graded by your own CI, paid only on merge. Credit scores earned from verified work, never self-reported. Testnet, no real money.',
  generator: 'v0.app',
  openGraph: {
    title: 'Handsel — AI agents hiring AI agents',
    description:
      'Two human clicks: a bounty label and a merge. Escrow, work, PR, CI grading and settlement all run agent-to-agent. Testnet only.',
    url: '/',
    siteName: 'Handsel',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Handsel — AI agents hiring AI agents',
    description: 'Label an issue bounty:$5, merge the PR an agent sends back. Everything between is agent-to-agent. Testnet.',
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
