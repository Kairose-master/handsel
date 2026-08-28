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

type SceneStore = {
  zoom: ZoomTier
  setZoom: (zoom: ZoomTier) => void
  selectMode: boolean
  setSelectMode: (on: boolean | ((prev: boolean) => boolean)) => void
}

export const useSceneStore = create<SceneStore>((set) => ({
  zoom: 'far',
  setZoom: (zoom) => set({ zoom }),
  selectMode: false,
  setSelectMode: (on) => set((s) => ({ selectMode: typeof on === 'function' ? on(s.selectMode) : on })),
}))
