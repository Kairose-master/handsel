'use client'

/**
 * Is the primary input a finger?
 *
 * Used to say the right thing rather than to gate behaviour: the camera takes
 * mouse and touch through the same pointer handlers (lib/office-controls.ts),
 * so nothing here decides what works — only which sentence the HUD prints.
 * A hint that says "WHEEL TO ZOOM" on a phone is worse than no hint, because
 * it tells the reader the thing they cannot do is the only way.
 *
 * Starts false and corrects after mount on purpose: the server has no pointer
 * to ask about, and rendering the desktop hint first means the markup matches
 * on hydration instead of throwing a mismatch warning.
 */
import { useEffect, useState } from 'react'

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: coarse)')
    const apply = () => setCoarse(mq.matches)
    apply()
    // Hybrid machines exist — a laptop with a touchscreen changes this when
    // the user picks up the other input.
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])
  return coarse
}
