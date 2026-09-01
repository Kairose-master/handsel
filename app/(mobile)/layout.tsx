'use client'

/**
 * The mobile surface's gate — the same client-side session check as
 * (dashboard)/layout.tsx, without the desktop shell: /m is one full-screen
 * touch surface and the sidebar/nav chrome has no place on a phone. Signed
 * out lands on /guest, same as the desktop deck.
 *
 * A route GROUP on purpose: a top-level app/ directory with a page must be
 * classified in lib/public-routes.ts (tests/deck-theme.test.ts walks for
 * strays), and /m is not public — it is the deck, dark, authenticated.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch('/api/me')
        if (!res.ok) {
          router.push('/guest')
          return
        }
        setLoading(false)
      } catch (error) {
        console.error('[m] session check error:', error)
        router.push('/sign-in')
      }
    }
    checkSession()
  }, [router])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return <>{children}</>
}
