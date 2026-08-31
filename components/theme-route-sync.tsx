'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { isPublicPath } from '@/lib/public-routes'

/**
 * Keep the theme matching which site you are on, across client navigation.
 *
 * The pre-paint script in `app/layout.tsx` picks light or dark from the URL
 * on a real page load, which is the case it exists for — no flash. But the
 * app is a SPA after that, and the script never runs again. The visible
 * failure: sign out from the dashboard and `router.push('/guest')` leaves the
 * marketing page rendering on the dark deck, because nothing re-evaluated
 * the rule. Same in reverse when a logged-out visitor follows a link inward.
 *
 * So the rule lives in two places by necessity — inline for first paint,
 * here for every navigation after it — and both read the same
 * `lib/public-routes.ts` so they cannot disagree about which is which.
 *
 * An explicit choice still wins in both directions and is never overwritten:
 * this only decides for the visitor who has not decided.
 */
export function ThemeRouteSync() {
  const pathname = usePathname()

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem('theme')
    } catch {
      // Private mode or blocked storage — fall through to the route default,
      // which is the same answer the pre-paint script gave.
    }
    if (stored === 'dark' || stored === 'light') return
    document.documentElement.classList.toggle('dark', !isPublicPath(pathname ?? '/'))
  }, [pathname])

  return null
}
