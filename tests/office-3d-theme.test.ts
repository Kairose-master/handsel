import { describe, it, expect } from 'vitest'
import { THEMES, THEME_ORDER, DEFAULT_THEME_ID, type ThemeId } from '@/app/(dashboard)/office/game3d/theme'

describe('office 3D theme registry', () => {
  it('THEME_ORDER lists exactly the keys of THEMES, no more, no fewer', () => {
    expect(new Set(THEME_ORDER)).toEqual(new Set(Object.keys(THEMES)))
    expect(THEME_ORDER).toHaveLength(Object.keys(THEMES).length)
  })

  it('DEFAULT_THEME_ID is a real registered theme', () => {
    expect(THEMES[DEFAULT_THEME_ID]).toBeDefined()
  })

  it('every theme is internally consistent: id matches its own key', () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(theme.id).toBe(key as ThemeId)
    }
  })

  it('every theme declares a non-empty label, brand, and hex-ish color set', () => {
    const hex = /^#[0-9a-f]{3,8}$/i
    for (const theme of Object.values(THEMES)) {
      expect(theme.label.length).toBeGreaterThan(0)
      expect(theme.brand.length).toBeGreaterThan(0)
      for (const field of ['bg', 'wall', 'door', 'text', 'accent', 'danger', 'warn', 'ok'] as const) {
        expect(theme[field]).toMatch(hex)
      }
    }
  })

  it('a non-glow theme never claims an emissive intensity implicitly via its own flag alone (glow is a real boolean, not always true)', () => {
    const glowValues = Object.values(THEMES).map((t) => t.glow)
    // Not every theme has to be non-glow, but the registry must not silently
    // collapse to "everything glows" — that would make the flag meaningless.
    expect(glowValues).toContain(false)
  })

  it('fog is either a real [near, far] pair with near < far, or explicitly disabled', () => {
    for (const theme of Object.values(THEMES)) {
      if (theme.fog === null) continue
      const [near, far] = theme.fog
      expect(near).toBeLessThan(far)
      expect(near).toBeGreaterThan(0)
    }
  })
})
