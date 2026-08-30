import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  pinchOf,
  pinchStep,
  wrapAngle,
  zoomAnchor,
  twistTurns,
  TWIST_STEP_RAD,
  decayVelocity,
  isNegligible,
  clampFlick,
  FLICK_MAX_SPEED,
  rampAxis,
  heldAxis,
  flickVelocity,
  pushSample,
  MAX_SAMPLES,
  MIN_PINCH_DIST,
  type Sample,
} from '@/lib/office-controls'

describe('pinch', () => {
  it('reads distance, angle and midpoint off two pointers', () => {
    const p = pinchOf({ x: 0, y: 0 }, { x: 100, y: 0 })
    expect(p.dist).toBe(100)
    expect(p.angle).toBe(0)
    expect(p.cx).toBe(50)
    expect(p.cy).toBe(0)
  })

  it('turns spreading fingers into a zoom-in factor', () => {
    const step = pinchStep(pinchOf({ x: 0, y: 0 }, { x: 100, y: 0 }), pinchOf({ x: 0, y: 0 }, { x: 200, y: 0 }))
    expect(step.zoomFactor).toBeCloseTo(2)
    expect(step.twist).toBeCloseTo(0)
  })

  it('never divides by a collapsed pinch', () => {
    // Two touches momentarily reading the same point would otherwise
    // multiply the zoom by infinity and blank the scene.
    const step = pinchStep(pinchOf({ x: 0, y: 0 }, { x: 0, y: 0 }), pinchOf({ x: 0, y: 0 }, { x: 60, y: 0 }))
    expect(Number.isFinite(step.zoomFactor)).toBe(true)
    expect(step.zoomFactor).toBeCloseTo(60 / MIN_PINCH_DIST)
  })

  it('reports a two-finger drag as pan, not only as zoom', () => {
    const step = pinchStep(pinchOf({ x: 0, y: 0 }, { x: 100, y: 0 }), pinchOf({ x: 30, y: 40 }, { x: 130, y: 40 }))
    expect(step.zoomFactor).toBeCloseTo(1)
    expect(step.panPx).toEqual({ x: 30, y: 40 })
  })

  it('does not read a spin when the gesture crosses the angle seam', () => {
    // atan2 jumps from +π to -π; unwrapped that is a full turn in one frame.
    const a = pinchOf({ x: 0, y: 0 }, { x: -100, y: 1 })
    const b = pinchOf({ x: 0, y: 0 }, { x: -100, y: -1 })
    expect(Math.abs(pinchStep(a, b).twist)).toBeLessThan(0.1)
  })
})

describe('wrapAngle', () => {
  it('maps into (-π, π]', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0)
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI)
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI)
  })
})

describe('zoomAnchor', () => {
  // The single biggest "feels wrong" tell in an isometric scene: point at a
  // desk, zoom, and the desk slides away because zoom went to screen centre.
  it('does not move the camera when zooming at the centre', () => {
    expect(zoomAnchor(0, 0, 100, 200)).toEqual({ right: 0, up: 0 })
  })

  it('moves toward the cursor when zooming in, and away when zooming out', () => {
    const inward = zoomAnchor(200, 0, 100, 200)
    const outward = zoomAnchor(200, 0, 200, 100)
    expect(Math.sign(inward.right)).toBe(1)
    expect(Math.sign(outward.right)).toBe(-1)
  })

  it('is exactly reversible', () => {
    // Zoom in at a point then out by the same factor at the same point must
    // land where it started, or repeated wheel notches drift the view.
    const a = zoomAnchor(140, -90, 100, 250)
    const b = zoomAnchor(140, -90, 250, 100)
    expect(a.right + b.right).toBeCloseTo(0, 10)
    expect(a.up + b.up).toBeCloseTo(0, 10)
  })

  it('refuses a nonsense zoom rather than emitting NaN', () => {
    expect(zoomAnchor(10, 10, 0, 100)).toEqual({ right: 0, up: 0 })
    expect(zoomAnchor(10, 10, 100, -1)).toEqual({ right: 0, up: 0 })
  })
})

describe('twistTurns', () => {
  it('spends nothing until the twist is deliberate', () => {
    expect(twistTurns(TWIST_STEP_RAD * 0.9).turns).toBe(0)
  })

  it('spends one quarter turn per step and keeps the remainder', () => {
    // Keeping the remainder is what lets a slow continuous twist keep
    // stepping instead of stalling just under the threshold.
    const got = twistTurns(TWIST_STEP_RAD * 1.4)
    expect(got.turns).toBe(1)
    expect(got.rest).toBeCloseTo(TWIST_STEP_RAD * 0.4)
  })

  it('turns both ways', () => {
    expect(twistTurns(-TWIST_STEP_RAD * 2.2).turns).toBe(-2)
  })
})

describe('momentum', () => {
  it('halves in one half-life regardless of frame rate', () => {
    // A per-frame multiplier decays twice as fast at 120Hz as at 60Hz — the
    // same defect the camera easing had to fix once already.
    const v = { x: 1000, y: 0 }
    const oneStep = decayVelocity(v, 0.25, 0.25)
    let many = v
    for (let i = 0; i < 15; i += 1) many = decayVelocity(many, 0.25 / 15, 0.25)
    expect(oneStep.x).toBeCloseTo(500)
    expect(many.x).toBeCloseTo(oneStep.x, 6)
  })

  it('stops rather than crawling forever', () => {
    expect(isNegligible({ x: 3, y: 3 })).toBe(true)
    expect(isNegligible({ x: 300, y: 0 })).toBe(false)
  })

  it('caps a hard swipe so it cannot launch the camera off the world', () => {
    const capped = clampFlick({ x: 90000, y: 0 })
    expect(capped.x).toBeCloseTo(FLICK_MAX_SPEED)
    expect(clampFlick({ x: 10, y: 0 })).toEqual({ x: 10, y: 0 })
    expect(clampFlick({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('flickVelocity', () => {
  const samples: Sample[] = [
    { x: 0, y: 0, t: 1000 },
    { x: 20, y: 0, t: 1030 },
    { x: 40, y: 0, t: 1060 },
    { x: 60, y: 0, t: 1090 },
  ]

  it('measures over a window, not off the last two events', () => {
    // The final pair before a finger lifts is often a jitter of a pixel or
    // two; taken alone it turns a firm swipe into a dead stop.
    const jittery = [...samples, { x: 60.5, y: 0, t: 1092 }]
    expect(flickVelocity(jittery, 1092).x).toBeGreaterThan(500)
  })

  it('ignores samples older than the window', () => {
    const stale = [{ x: 0, y: 0, t: 0 }, ...samples]
    expect(flickVelocity(stale, 1090).x).toBeCloseTo(flickVelocity(samples, 1090).x)
  })

  it('is zero when there is nothing recent to measure', () => {
    expect(flickVelocity(samples, 5000)).toEqual({ x: 0, y: 0 })
    expect(flickVelocity([], 0)).toEqual({ x: 0, y: 0 })
  })

  it('is zero for a hold with no movement in time', () => {
    expect(flickVelocity([{ x: 5, y: 5, t: 100 }, { x: 9, y: 9, t: 100 }], 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('pushSample', () => {
  it('keeps the buffer bounded on a long drag', () => {
    const buf: Sample[] = []
    for (let i = 0; i < 200; i += 1) pushSample(buf, { x: i, y: 0, t: i })
    expect(buf.length).toBe(MAX_SAMPLES)
    expect(buf[buf.length - 1].x).toBe(199)
  })
})

describe('rampAxis', () => {
  it('accelerates toward the target instead of snapping', () => {
    const first = rampAxis(0, 1, 1 / 60, 0.12)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(0.3)
  })

  it('gets there, and lands exactly', () => {
    let v = 0
    for (let i = 0; i < 120; i += 1) v = rampAxis(v, 1, 1 / 60, 0.12)
    expect(v).toBe(1)
  })

  it('returns exactly zero on release, so nothing drifts forever', () => {
    let v = 1
    for (let i = 0; i < 120; i += 1) v = rampAxis(v, 0, 1 / 60, 0.07)
    expect(v).toBe(0)
  })
})

describe('heldAxis', () => {
  it('maps both key sets', () => {
    expect(heldAxis(new Set(['d']))).toEqual({ x: 1, y: 0 })
    expect(heldAxis(new Set(['arrowleft']))).toEqual({ x: -1, y: 0 })
    expect(heldAxis(new Set(['w']))).toEqual({ x: 0, y: 1 })
    expect(heldAxis(new Set(['arrowdown']))).toEqual({ x: 0, y: -1 })
  })

  it('cancels opposing keys', () => {
    expect(heldAxis(new Set(['a', 'd']))).toEqual({ x: 0, y: 0 })
  })

  it('does not make diagonals faster than straight lines', () => {
    const d = heldAxis(new Set(['w', 'd']))
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1)
  })
})

describe('the rig actually uses this', () => {
  const rig = readFileSync('app/(dashboard)/office/game3d/CameraRig.tsx', 'utf8')

  it('anchors zoom to the pointer', () => {
    expect(rig).toMatch(/zoomAnchor\(/)
  })

  it('handles a two-finger gesture', () => {
    expect(rig).toMatch(/pinchStep\(/)
  })

  it('coasts on release', () => {
    expect(rig).toMatch(/flickVelocity\(/)
    expect(rig).toMatch(/decayVelocity\(/)
  })

  it('ramps the keyboard instead of switching it', () => {
    expect(rig).toMatch(/rampAxis\(/)
    expect(rig).toMatch(/heldAxis\(/)
  })

  it('claims the touch gesture from the browser', () => {
    // Without this the page scrolls and pointermove never fires — which is
    // why a phone could not move the camera at all.
    expect(rig).toMatch(/touchAction|touch-action/)
    expect(rig).toMatch(/setPointerCapture/)
  })
})
