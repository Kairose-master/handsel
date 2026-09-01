/**
 * Camera math for the tactical painted renderer — the pure half of its
 * pan/pinch/wheel controls, same split as zoom.ts and select.ts: everything
 * decidable without a DOM lives here so tests/tactical-camera.test.ts can
 * pin the geometry without a browser.
 *
 * A camera is a focus point in backdrop UV space plus a zoom multiplier on
 * top of the viewport's cover scale. The invariants this module owns:
 *
 *  - zoom stays inside [MIN_ZOOM, MAX_ZOOM]; MIN_ZOOM is the cover fit, so
 *    the painting always fills the viewport and never floats in a void.
 *  - the focus clamps so the visible rect never leaves the painting — at
 *    any zoom, panning stops at the painted edge instead of revealing the
 *    page background behind it.
 *  - zooming about a focal point (two fingers, or a wheel at the cursor)
 *    keeps the scene point under that focal point stationary, which is what
 *    makes a pinch feel like grabbing the map rather than teleporting it.
 */

export type TacticalCam = {
  /** Focus point in backdrop UV space (0..1 each axis). */
  u: number
  v: number
  /** Multiplier on the viewport's cover scale. 1 = the whole-office fit. */
  zoom: number
}

export type TacticalViewport = {
  /** Viewport CSS size in px. */
  vw: number
  vh: number
  /** max(vw/sceneW, vh/sceneH) — the scale at which the scene covers the viewport. */
  coverScale: number
  /** Native backdrop size in px. */
  sceneW: number
  sceneH: number
}

export const MIN_ZOOM = 1
// Capped by the backdrop's native resolution (1412px): past ~2.6x the
// painting is visibly soft. Raise this only after the 2-4K art regen the
// prototype README leaves open.
export const MAX_ZOOM = 2.6

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** Half of the visible span along one axis, in UV units, at this camera. */
function halfSpan(viewPx: number, scenePx: number, view: TacticalViewport, zoom: number): number {
  return viewPx / (2 * view.coverScale * zoom * scenePx)
}

/** Clamp zoom into range and the focus so the view stays on the painting.
 *  When an axis's visible span exceeds the whole scene (only possible at
 *  MIN_ZOOM with extreme aspect ratios), the focus centers on that axis. */
export function clampCam(cam: TacticalCam, view: TacticalViewport): TacticalCam {
  const zoom = clamp(cam.zoom, MIN_ZOOM, MAX_ZOOM)
  const hu = halfSpan(view.vw, view.sceneW, view, zoom)
  const hv = halfSpan(view.vh, view.sceneH, view, zoom)
  return {
    u: hu >= 0.5 ? 0.5 : clamp(cam.u, hu, 1 - hu),
    v: hv >= 0.5 ? 0.5 : clamp(cam.v, hv, 1 - hv),
    zoom,
  }
}

/** Drag by (dxPx, dyPx): the scene follows the finger, so the focus moves
 *  the opposite way, scaled by the effective scale. */
export function panCam(cam: TacticalCam, dxPx: number, dyPx: number, view: TacticalViewport): TacticalCam {
  const s = view.coverScale * cam.zoom
  return clampCam(
    { u: cam.u - dxPx / (s * view.sceneW), v: cam.v - dyPx / (s * view.sceneH), zoom: cam.zoom },
    view,
  )
}

/**
 * Multiply zoom by `factor`, keeping the scene point under the focal point
 * stationary. (fxPx, fyPx) is the focal point's offset from the viewport
 * CENTER in px — pinch midpoint or wheel cursor. Derivation: the scene
 * point at that offset is p = focus + offset/(scale*scenePx); requiring the
 * same p at the same offset after the zoom gives
 * focus' = p - offset/(scale'*scenePx).
 */
export function zoomCam(
  cam: TacticalCam,
  factor: number,
  fxPx: number,
  fyPx: number,
  view: TacticalViewport,
): TacticalCam {
  const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const s0 = view.coverScale * cam.zoom
  const s1 = view.coverScale * zoom
  return clampCam(
    {
      u: cam.u + (fxPx / view.sceneW) * (1 / s0 - 1 / s1),
      v: cam.v + (fyPx / view.sceneH) * (1 / s0 - 1 / s1),
      zoom,
    },
    view,
  )
}

/** The transform string TacticalView applies: translate(T) scale(S) about
 *  the scene center puts scene point d = (u-.5)*scenePx at S*d + T, so
 *  T = -S*d centers the focus point in the viewport. */
export function camTransform(cam: TacticalCam, view: TacticalViewport): string {
  const s = view.coverScale * cam.zoom
  const tx = -s * (cam.u - 0.5) * view.sceneW
  const ty = -s * (cam.v - 0.5) * view.sceneH
  return `translate(${tx}px, ${ty}px) scale(${s})`
}
