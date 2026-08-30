/**
 * Coarse UI state for the R3F office scene — Zustand, deliberately scoped
 * narrow. The hot path (agent tile positions, every animation frame) stays
 * OUTSIDE this store and out of React state entirely, same as the DOM/CSS
 * engine it replaces (see OfficeWorld3D.tsx's header): `LiveOffice.tick()`
 * mutates the same `Agent[]` objects in place, and `useFrame` reads them
 * imperatively to move meshes — running that through Zustand would mean
 * every walking agent re-rendering every subscriber on every frame, the
 * exact cost this pattern exists to avoid.
 *
 * What DOES belong here: the state a mouse click changes rarely, that both
 * the HUD (plain DOM buttons, siblings of <Canvas>) and the 3D scene
 * (inside <Canvas>, a different render tree) need to agree on — zoom tier,
 * which room/agent is selected, and whether the box-select tool is armed.
 */
import { create } from 'zustand'
import type { ZoomTier } from './CameraRig'
import { DEFAULT_THEME_ID, THEMES, type ThemeId } from './theme'

const THEME_STORAGE_KEY = 'handsel-office-3d-theme'

/** Read the visitor's last-picked theme, if any — a per-browser display
 *  preference, not account data, so localStorage (not a DB column) is the
 *  right place for it. Guarded: private browsing / blocked storage must
 *  never crash the scene, just fall back to the shipped default. Safe to
 *  call at module-eval time here specifically because OfficeWorld3D.tsx is
 *  always loaded via next/dynamic(..., { ssr: false }) — this module is
 *  never evaluated server-side, so `window` is always real by the time it
 *  runs. */
function loadThemeId(): ThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored && stored in THEMES) return stored as ThemeId
  } catch {
    // ignore — storage may be unavailable (private mode, blocked cookies)
  }
  return DEFAULT_THEME_ID
}

type SceneStore = {
  zoom: ZoomTier
  setZoom: (zoom: ZoomTier) => void
  /** Which of the four corners the diorama is viewed from, as a quarter-turn
   *  COUNT rather than an angle. Counting turns instead of storing radians is
   *  what lets the camera take the short way round and keep spinning in one
   *  direction past 360° — an angle normalised into [0, 2π) makes the third
   *  press of the same button snap backwards through three quadrants. */
  quarterTurns: number
  rotate: (delta: 1 | -1) => void
  selectMode: boolean
  setSelectMode: (on: boolean | ((prev: boolean) => boolean)) => void
  themeId: ThemeId
  setThemeId: (id: ThemeId) => void
}

export const useSceneStore = create<SceneStore>((set) => ({
  zoom: 'far',
  setZoom: (zoom) => set({ zoom }),
  quarterTurns: 0,
  rotate: (delta) => set((s) => ({ quarterTurns: s.quarterTurns + delta })),
  selectMode: false,
  setSelectMode: (on) => set((s) => ({ selectMode: typeof on === 'function' ? on(s.selectMode) : on })),
  themeId: loadThemeId(),
  setThemeId: (id) => {
    set({ themeId: id })
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, id)
    } catch {
      // best-effort — a theme pick that fails to persist still applies this session
    }
  },
}))
