import { describe, it, expect } from 'vitest'
import {
  clampCam,
  panCam,
  zoomCam,
  camTransform,
  MIN_ZOOM,
  MAX_ZOOM,
  type TacticalCam,
  type TacticalViewport,
} from '@/app/(dashboard)/office/game/tactical-camera'

// The real backdrop's proportions and a phone-ish viewport — the geometry
// these controls actually run at, not round numbers that hide asymmetry.
const SCENE_W = 1412
const SCENE_H = 684
const view: TacticalViewport = {
  vw: 390,
  vh: 780,
  coverScale: Math.max(390 / SCENE_W, 780 / SCENE_H),
  sceneW: SCENE_W,
  sceneH: SCENE_H,
}
const center: TacticalCam = { u: 0.5, v: 0.5, zoom: 1.5 }

describe('clampCam', () => {
  it('caps zoom at both ends', () => {
    expect(clampCam({ ...center, zoom: 99 }, view).zoom).toBe(MAX_ZOOM)
    expect(clampCam({ ...center, zoom: 0.01 }, view).zoom).toBe(MIN_ZOOM)
  })

  it('stops the focus at the painted edge instead of showing the void', () => {
    const c = clampCam({ u: 0, v: 1, zoom: 2 }, view)
    // Visible half-spans at zoom 2
    const s = view.coverScale * 2
    const hu = view.vw / (2 * s * SCENE_W)
    const hv = view.vh / (2 * s * SCENE_H)
    expect(c.u).toBeCloseTo(hu, 10)
    expect(c.v).toBeCloseTo(1 - hv, 10)
  })

  it('centers an axis whose whole span is visible', () => {
    // A viewport wider than the covered scene along one axis can only
    // happen at MIN_ZOOM; the focus must sit at .5 there, not rattle
    // between equal clamp bounds.
    const wide: TacticalViewport = { ...view, vw: 2000, vh: 200, coverScale: Math.max(2000 / SCENE_W, 200 / SCENE_H) }
    const c = clampCam({ u: 0.1, v: 0.5, zoom: MIN_ZOOM }, wide)
    // cover is width-driven here, so the full width is exactly visible
    expect(c.u).toBeCloseTo(0.5, 10)
  })
})

describe('panCam', () => {
  it('moves the focus opposite the drag, scaled by the effective scale', () => {
    const dragged = panCam(center, 100, 0, view)
    const s = view.coverScale * center.zoom
    expect(dragged.u).toBeCloseTo(0.5 - 100 / (s * SCENE_W), 10)
    expect(dragged.v).toBeCloseTo(0.5, 10)
  })

  it('the same drag moves less UV at a higher zoom', () => {
    const near = panCam({ ...center, zoom: 3 }, 100, 0, view)
    const far = panCam({ ...center, zoom: 1.2 }, 100, 0, view)
    expect(0.5 - near.u).toBeLessThan(0.5 - far.u)
  })
})

describe('zoomCam', () => {
  it('keeps the scene point under the focal point stationary', () => {
    // Scene point under the focal offset before…
    const fx = 120
    const fy = -80
    const s0 = view.coverScale * center.zoom
    const pu = center.u + fx / (s0 * SCENE_W)
    const pv = center.v + fy / (s0 * SCENE_H)
    const zoomed = zoomCam(center, 1.4, fx, fy, view)
    // …must still be under it after (no clamping in play at these values).
    const s1 = view.coverScale * zoomed.zoom
    expect(zoomed.u + fx / (s1 * SCENE_W)).toBeCloseTo(pu, 10)
    expect(zoomed.v + fy / (s1 * SCENE_H)).toBeCloseTo(pv, 10)
  })

  it('zooming at the center leaves the focus alone', () => {
    const zoomed = zoomCam(center, 1.5, 0, 0, view)
    expect(zoomed.u).toBeCloseTo(0.5, 10)
    expect(zoomed.v).toBeCloseTo(0.5, 10)
    expect(zoomed.zoom).toBeCloseTo(2.25, 10)
  })

  it('a pinch at the zoom ceiling is a no-op, not a drift', () => {
    const atMax = { ...center, zoom: MAX_ZOOM }
    const zoomed = zoomCam(atMax, 2, 150, 100, view)
    expect(zoomed.zoom).toBe(MAX_ZOOM)
    // zoom did not change, so the focal-point math must not move the focus
    expect(zoomed.u).toBeCloseTo(atMax.u, 10)
    expect(zoomed.v).toBeCloseTo(atMax.v, 10)
  })
})

describe('camTransform', () => {
  it('centers the focus point in the viewport', () => {
    // Focus at scene center → no translation, pure scale.
    expect(camTransform({ u: 0.5, v: 0.5, zoom: 2 }, view)).toBe(
      `translate(0px, 0px) scale(${view.coverScale * 2})`,
    )
  })

  it('translates against the focus offset', () => {
    const s = view.coverScale * 2
    const t = camTransform({ u: 0.75, v: 0.5, zoom: 2 }, view)
    expect(t).toBe(`translate(${-s * 0.25 * SCENE_W}px, 0px) scale(${s})`)
  })
})
