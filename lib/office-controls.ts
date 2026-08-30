/**
 * The office camera's input feel — pure, so the maths that decides whether a
 * gesture reads as "solid" can be tested without a browser.
 *
 * Three things were wrong with the rig this replaces, and they are different
 * kinds of wrong:
 *
 * 1. ON A PHONE THERE WERE NO CONTROLS AT ALL. Pan was WASD or a one-pointer
 *    drag, zoom was the wheel, rotation was a button. A touch device has no
 *    keyboard and no wheel, so zoom was simply unreachable — and the drag
 *    never started either, because the canvas never claimed the gesture
 *    (`touch-action`), so the browser took it as a page scroll before
 *    `pointermove` ever fired. Half the audience could look at the office and
 *    not move the camera one pixel.
 *
 * 2. ZOOM WENT TO THE MIDDLE OF THE SCREEN, not to the cursor. In an
 *    isometric scene that is the single biggest "this feels wrong" tell:
 *    you point at a desk, zoom, and the desk slides away. `zoomAnchor` is
 *    the fix and it is four lines.
 *
 * 3. MOVEMENT STARTED AND STOPPED DEAD. Keys were binary — full speed on
 *    keydown, zero on keyup — and a drag ended the instant the finger left
 *    the glass. Nothing in a game moves like that.
 *
 * Everything here is a pure function of its inputs. The rig
 * (`app/(dashboard)/office/game3d/CameraRig.tsx`) owns the listeners and the
 * three.js objects; this owns the arithmetic.
 *
 * ── The sign convention, which is the thing to get right ──────────────────
 *
 * The rig's `panScreen(right, up)` takes WORLD units along the camera's
 * screen-right and screen-up axes. The calibrated fact everything else is
 * derived from is its drag handler: a finger delta of `(dx, dy)` pixels at
 * zoom `z` is applied as `panScreen(-dx / z, -dy / z)`, and that keeps the
 * ground under the finger. So:
 *
 *     moving the CONTENT by (dx, dy) pixels  ==  panScreen(-dx/z, -dy/z)
 *
 * `zoomAnchor` is derived from that identity rather than from first
 * principles about isometric projection, because the identity is the one
 * that is already known to feel right on screen.
 */

export type Vec2 = { x: number; y: number }

/** A two-pointer gesture, reduced to the four numbers that matter. */
export type Pinch = {
  /** Distance between the two pointers, px. */
  dist: number
  /** Angle of the line between them, radians. */
  angle: number
  /** Midpoint, px — the anchor a pinch-zoom should hold still. */
  cx: number
  cy: number
}

export function pinchOf(a: Vec2, b: Vec2): Pinch {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return {
    dist: Math.hypot(dx, dy),
    angle: Math.atan2(dy, dx),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  }
}

/** Below this the two touches are effectively one point and the ratio blows
 *  up — a pinch that briefly reads 0px would multiply the zoom by infinity. */
export const MIN_PINCH_DIST = 12

export type PinchStep = {
  /** Multiply the current zoom by this. 1 = no change. */
  zoomFactor: number
  /** Signed rotation of the two-finger line since the last sample, radians,
   *  wrapped to (-π, π] so passing through ±π does not read as a full spin. */
  twist: number
  /** How far the midpoint moved, px — a two-finger drag pans as well as
   *  zooms, which is what every map on a phone does. */
  panPx: Vec2
}

export function pinchStep(prev: Pinch, next: Pinch): PinchStep {
  const safePrev = Math.max(prev.dist, MIN_PINCH_DIST)
  const safeNext = Math.max(next.dist, MIN_PINCH_DIST)
  return {
    zoomFactor: safeNext / safePrev,
    twist: wrapAngle(next.angle - prev.angle),
    panPx: { x: next.cx - prev.cx, y: next.cy - prev.cy },
  }
}

/** Wrap to (-π, π]. Without this a gesture crossing the ±π seam reports a
 *  ~2π twist and the camera spins a full turn in one frame. */
export function wrapAngle(a: number): number {
  let x = a
  while (x <= -Math.PI) x += Math.PI * 2
  while (x > Math.PI) x -= Math.PI * 2
  return x
}

/**
 * How far to pan so the point under the cursor stays under the cursor while
 * the zoom changes from `z0` to `z1`.
 *
 * `px`/`py` are the cursor's offset from the VIEWPORT CENTRE in pixels (an
 * orthographic camera's screen centre is its focus, which is what makes this
 * simple). Returns world units for `panScreen`.
 *
 * Derivation, using the identity in the header: after the zoom, a point that
 * sat at pixel offset `p` sits at `p·(z1/z0)`, so the content moved by
 * `p·(z1/z0 − 1)`. Cancelling that motion is a content move of the negative,
 * which is `panScreen(p·(1/z0 − 1/z1), …)` once the −1/z factor is folded in.
 */
export function zoomAnchor(px: number, py: number, z0: number, z1: number): { right: number; up: number } {
  if (!(z0 > 0) || !(z1 > 0)) return { right: 0, up: 0 }
  const f = 1 / z0 - 1 / z1
  return { right: px * f, up: py * f }
}

/**
 * A twist has to earn its quarter turn.
 *
 * The camera is a diorama on four fixed corners (see CameraRig's header), so
 * a two-finger twist cannot rotate freely — it accumulates until it has
 * turned far enough to be deliberate, then spends that on one 90° step and
 * keeps the remainder. A threshold well under 90° so the gesture feels
 * responsive, and remainder-keeping so a slow continuous twist keeps
 * stepping instead of stalling just under the line.
 */
export const TWIST_STEP_RAD = Math.PI / 6 // 30°

export function twistTurns(accum: number): { turns: number; rest: number } {
  const turns = Math.trunc(accum / TWIST_STEP_RAD)
  return { turns, rest: accum - turns * TWIST_STEP_RAD }
}

/**
 * Exponential decay toward zero, expressed as a half-life so it is
 * frame-rate independent.
 *
 * Per-frame multipliers (`v *= 0.9`) decay twice as fast on a 120Hz display
 * as on a 60Hz one — the same bug the rig's camera easing already had to fix
 * once. A half-life is the same feel on every machine.
 */
export function decayVelocity(v: Vec2, dt: number, halfLifeSec: number): Vec2 {
  if (halfLifeSec <= 0) return { x: 0, y: 0 }
  const k = Math.pow(0.5, dt / halfLifeSec)
  return { x: v.x * k, y: v.y * k }
}

/** Below this a flick has stopped and should be dropped, so the rig is not
 *  applying a sub-pixel pan forever and holding `manual` on. Pixels/second. */
export const FLICK_EPSILON = 8

export function isNegligible(v: Vec2, eps: number = FLICK_EPSILON): boolean {
  return Math.hypot(v.x, v.y) < eps
}

/** How long a released flick keeps coasting. Short: this is a diorama you
 *  inspect, not a map you throw. */
export const FLICK_HALF_LIFE_SEC = 0.22

/** Cap a flick so a fast swipe on a small phone does not launch the camera
 *  to the far edge of the world. Pixels/second. */
export const FLICK_MAX_SPEED = 2600

export function clampFlick(v: Vec2, max: number = FLICK_MAX_SPEED): Vec2 {
  const speed = Math.hypot(v.x, v.y)
  if (speed <= max || speed === 0) return v
  const s = max / speed
  return { x: v.x * s, y: v.y * s }
}

/**
 * Ramp one axis toward a target with a time constant, for keyboard panning.
 *
 * Binary keys are why WASD felt like a spreadsheet rather than a game: full
 * speed on the first frame and a dead stop on release. `timeConstant` is
 * roughly the time to cover 63% of the gap.
 */
export function rampAxis(current: number, target: number, dt: number, timeConstant: number): number {
  if (timeConstant <= 0) return target
  const k = 1 - Math.exp(-dt / timeConstant)
  const next = current + (target - current) * k
  // Snap the last sliver, or a released key leaves a permanent crawl.
  return Math.abs(next - target) < 0.001 ? target : next
}

/** Keyboard acceleration and release, in seconds. Release is faster than
 *  press: a camera that keeps drifting after you let go feels broken, while
 *  one that takes a moment to get moving feels weighty. */
export const KEY_ACCEL_SEC = 0.12
export const KEY_RELEASE_SEC = 0.07

/** The pan axis a set of held keys asks for, as a unit-ish vector. Kept here
 *  rather than in the rig so the key mapping is one testable table. */
export function heldAxis(held: ReadonlySet<string>): Vec2 {
  const x = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0)
  const y = (held.has('w') || held.has('arrowup') ? 1 : 0) - (held.has('s') || held.has('arrowdown') ? 1 : 0)
  // Diagonals must not be √2 faster than straight lines.
  if (x && y) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 }
  return { x, y }
}

/**
 * Velocity from the last few pointer samples, for a release flick.
 *
 * Averaged over a short window rather than taken from the final two events:
 * the last pair before a finger lifts is often a jitter of a pixel or two,
 * and using it turns a firm swipe into a dead stop about a third of the time.
 */
export type Sample = { x: number; y: number; t: number }

export const FLICK_WINDOW_MS = 90

export function flickVelocity(samples: readonly Sample[], now: number, windowMs = FLICK_WINDOW_MS): Vec2 {
  const recent = samples.filter((s) => now - s.t <= windowMs)
  if (recent.length < 2) return { x: 0, y: 0 }
  const first = recent[0]
  const last = recent[recent.length - 1]
  const dtMs = last.t - first.t
  if (dtMs <= 0) return { x: 0, y: 0 }
  return clampFlick({ x: ((last.x - first.x) / dtMs) * 1000, y: ((last.y - first.y) / dtMs) * 1000 })
}

/** Keep at most this many samples; anything older cannot be inside the
 *  window anyway and an unbounded array on a long drag is a leak. */
export const MAX_SAMPLES = 12

export function pushSample(samples: Sample[], s: Sample, max = MAX_SAMPLES): Sample[] {
  samples.push(s)
  if (samples.length > max) samples.splice(0, samples.length - max)
  return samples
}
