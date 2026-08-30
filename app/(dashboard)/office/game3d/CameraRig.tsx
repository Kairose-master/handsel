'use client'

/**
 * Isometric camera: fixed ELEVATION angle (a diorama, never a free-orbit
 * scene — tilting away from the iso angle would make room shapes and agent
 * facing unreadable, the same reason the DOM engine never rotated either),
 * but free to swing between the four CORNERS of that angle. Those are
 * different claims and this file used to conflate them: a quarter-turn
 * keeps every room a rhombus of the same shape and every avatar's facing
 * as legible as before, it only changes which walls are near and which are
 * far — which is the whole point, because at one fixed corner the far
 * rooms are permanently behind the near walls. Free tumbling is still
 * refused; `quarterTurns` (scene-store) is a count of 90° steps, damped so
 * the turn reads as a camera move rather than a cut. Driven by the same
 * three zoom tiers and the same focus priority
 * as app/(dashboard)/office/game/zoom.ts (`hotRoomOf`/`closeRoomIdFor`,
 * reused verbatim — a department's occupancy doesn't change meaning
 * because the renderer changed). Only the FOCUS POINT differs: tile units
 * here (1 tile = 1 three.js unit, `y` becomes `z`) instead of the DOM
 * engine's pixel units.
 *
 * The camera is driven BY HAND — `camera.position`/`lookAt`/`zoom` set
 * directly every frame from one lerped "look-at" point — rather than via
 * Drei's OrbitControls/MapControls. An earlier version used MapControls
 * for free user panning, but its internal spherical-coordinate
 * reconstruction (`update()` recomputing position from target + its own
 * tracked offset) fought a per-frame externally-driven target in a way
 * that collapsed the camera toward the origin after a few dozen frames —
 * reproducible, but not worth chasing into OrbitControls' internals when
 * this diorama doesn't need free rotation or dollying in the first place.
 * Hand-rolling the exact same lerp-toward-a-target the DOM renderer's
 * `camRef`/`targetRef` already used (OfficeWorld.tsx) is simpler AND
 * provably correct — the two renderers now share the same camera
 * philosophy, just applied to a real transform instead of a CSS one.
 * Free navigation is back, and hand-rolled for the same reason the rest of
 * this is: WASD / arrows to pan, wheel to zoom, drag to pan. The HUD had
 * been printing "DRAG TO PAN" the whole time this file said panning was
 * traded away — a control the interface advertised and did not have.
 *
 * Moving the camera yourself sets `manual` (scene-store) and the rig stops
 * following the busiest room, because an auto-follow that yanks the view
 * back the moment you look somewhere is the most irritating thing a diorama
 * camera can do. A zoom-tier button clears the flag and hands control back.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { CEO_ROOM, ROOMS, COLS, ROWS } from '../game/world'
import { hotRoomOf, closeRoomIdFor } from '../game/zoom'
import type { Agent } from '../game/live-engine'
import { useSceneStore } from './scene-store'
import {
  pinchOf,
  pinchStep,
  zoomAnchor,
  twistTurns,
  flickVelocity,
  decayVelocity,
  isNegligible,
  pushSample,
  rampAxis,
  heldAxis,
  KEY_ACCEL_SEC,
  KEY_RELEASE_SEC,
  FLICK_HALF_LIFE_SEC,
  type Sample,
  type Vec2,
} from '@/lib/office-controls'

export type ZoomTier = 'far' | 'medium' | 'close'

/** Room center in TILE units (x, z) — the 3D-scene equivalent of
 *  OfficeWorld.tsx's `focusFor`, which returned pixel units instead. */
export function focusTileFor(roomId: string | null): { x: number; z: number } {
  if (roomId) {
    const room = ROOMS.find((r) => r.id === roomId)
    if (room) return { x: room.x + room.w / 2, z: room.y + room.h / 2 }
  }
  return { x: CEO_ROOM.x, z: CEO_ROOM.y }
}

// How many tiles the WIDER world axis should span at each tier — the 3D
// analogue of the DOM engine's `fit` (whole office) vs `fit*1.9` (medium)
// vs `fit*3.2` (close) scale multipliers. Larger span = more zoomed out.
// Tuned empirically against the isometric projection's foreshortened
// footprint (a top-down "fit" number would show too little at this angle).
// FAR is no longer a magic number. It used to be 100 tiles against a
// 78x66 world, and because the zoom was derived from the viewport's SHORTER
// side, the office ended up occupying about a quarter of a wide frame with
// the rest empty black. `farSpanFor` fits the world's actual isometric
// footprint to BOTH viewport axes and takes the tighter of the two, so the
// deck fills the frame at any aspect ratio.
const MEDIUM_SPAN_TILES = 34
const CLOSE_SPAN_TILES = 21

/** Margin left around the office at FAR, as a fraction of the fit. */
const FAR_MARGIN = 1.12

/** Keys that pan. WASD and the arrows both, because half the people who
 *  open this reach for one and half for the other. */
const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'])
/** Pan speed as a fraction of the VISIBLE world height per second. A
 *  constant tiles-per-second reads as sluggish when zoomed out and berserk
 *  when zoomed in; tying it to what is actually on screen makes one tap of
 *  W move the same apparent distance at every zoom. Measured: 900 tiles/sec
 *  at FAR crossed the whole 78x66 deck and hit the clamp in under a second. */
const PAN_SCREENS_PER_SEC = 0.55
/** How far past the office edge a viewer may pan before being stopped — far
 *  enough to look at a corner from outside, not so far the deck is lost. */
const PAN_MARGIN = 14
const MIN_ZOOM = 4
const MAX_ZOOM = 160

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// Fixed isometric elevation — the offset FROM the look-at point TO the
// camera. Distance is arbitrary for an orthographic camera (it only picks
// near/far clipping, never apparent size); the direction is what gives the
// diorama its angle (~44° elevation, the classic iso feel). The horizontal
// component is what `quarterTurns` rotates; the height never changes, which
// is what keeps every corner the SAME isometric view rather than an orbit.
const ISO_RADIUS = Math.hypot(1, 1) / Math.hypot(1, 1.35, 1)
const ISO_HEIGHT = 1.35 / Math.hypot(1, 1.35, 1)
const ISO_DISTANCE = 120

/** Shortest-path angular damping. Lerping raw radians would spin the long
 *  way round whenever a turn crosses the ±π seam. */
function dampAngle(current: number, target: number, k: number): number {
  let delta = (target - current) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * k
}

/** Project the office's ground-plane corners into camera space and return
 *  the width/height they span there. At an isometric angle a 78x66 world is
 *  neither 78 nor 66 wide on screen, so fitting it needs the projected
 *  extent, not the tile counts. */
const CORNERS = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(COLS, 0, 0),
  new THREE.Vector3(0, 0, ROWS),
  new THREE.Vector3(COLS, 0, ROWS),
]
const RIGHT = new THREE.Vector3()
const UP = new THREE.Vector3()
function measureFootprint(camera: THREE.Camera): { w: number; h: number } {
  RIGHT.setFromMatrixColumn(camera.matrixWorld, 0)
  UP.setFromMatrixColumn(camera.matrixWorld, 1)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const c of CORNERS) {
    const x = c.dot(RIGHT)
    const y = c.dot(UP)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function CameraRig({
  agents,
  selectedId,
  selectedRoomId,
}: {
  agents: Agent[]
  selectedId: string | null
  selectedRoomId: string | null
}) {
  const { camera, size, gl } = useThree()
  const zoom = useSceneStore((s) => s.zoom)
  const quarterTurns = useSceneStore((s) => s.quarterTurns)
  const manual = useSceneStore((s) => s.manual)
  const setManual = useSceneStore((s) => s.setManual)

  /** Where the viewer has moved the camera to, and how far in. Refs, not
   *  state: these change on every frame a key is held, and this scene's rule
   *  is that per-frame values never round-trip through React. */
  const manualFocus = useRef(new THREE.Vector3(COLS / 2, 0, ROWS / 2))
  const manualZoom = useRef(0)
  const held = useRef(new Set<string>())
  /** Every pointer currently down, by id. One is a drag, two are a pinch.
   *  A single `dragging` slot is why a second finger used to overwrite the
   *  first and jump the camera. */
  const pointers = useRef(new Map<number, Vec2>())
  const pinch = useRef<ReturnType<typeof pinchOf> | null>(null)
  /** Twist banked toward the next quarter turn (lib/office-controls.ts). */
  const twist = useRef(0)
  /** Recent pointer positions, for the release flick. */
  const samples = useRef<Sample[]>([])
  /** Coasting velocity in screen px/sec, decayed in useFrame. */
  const flick = useRef<Vec2>({ x: 0, y: 0 })
  /** Keyboard pan velocity, ramped rather than switched. */
  const keyVel = useRef<Vec2>({ x: 0, y: 0 })

  // Keyboard pan. Held keys rather than keypress events so movement is
  // smooth and frame-rate paced, and ignored while typing — the office page
  // has real text inputs and stealing "w" from a name field is a bug report.
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))
    }
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing()) return
      const k = e.key.toLowerCase()
      if (PAN_KEYS.has(k)) {
        held.current.add(k)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => held.current.delete(e.key.toLowerCase())
    const blur = () => held.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  /**
   * One pointer handler for mouse and touch alike.
   *
   * The old version had a mouse-shaped hole in it: pan was a single-pointer
   * drag, zoom was the wheel, rotation was a button. A phone has no wheel and
   * no keyboard, so zoom was unreachable — and the drag never started either,
   * because the canvas never claimed the gesture and the browser took it as a
   * page scroll before `pointermove` fired. Half the audience could look at
   * the office and not move the camera one pixel.
   *
   * So: a map of live pointers. One is a drag, two are a pinch — zoom
   * anchored on the midpoint, pan by the midpoint's movement, and a twist
   * that spends itself on quarter turns. Releasing a drag leaves a flick.
   * The arithmetic is in lib/office-controls.ts, with tests.
   */
  useEffect(() => {
    const el = gl.domElement
    // Without this the browser scrolls the page instead of giving us the
    // gesture. It is the single line that made touch work at all.
    const previousTouchAction = el.style.touchAction
    el.style.touchAction = 'none'

    /** Cursor offset from the viewport centre, which is where an orthographic
     *  camera's focus sits — so this is exactly the anchor zoomAnchor wants. */
    const offsetFromCentre = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect()
      return { px: clientX - (r.left + r.width / 2), py: clientY - (r.top + r.height / 2) }
    }

    /** Change zoom while holding a screen point still. */
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const ortho = camera as THREE.OrthographicCamera
      startManual()
      const before = manualZoom.current || ortho.zoom
      const after = clamp(before * factor, MIN_ZOOM, MAX_ZOOM)
      if (after === before) return
      manualZoom.current = after
      const { px, py } = offsetFromCentre(clientX, clientY)
      const shift = zoomAnchor(px, py, before, after)
      panScreen(shift.right, shift.up)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Exponential in the delta so one notch feels the same at every depth.
      zoomAt(Math.pow(0.999, e.deltaY), e.clientX, e.clientY)
    }

    const onDown = (e: PointerEvent) => {
      if (useSceneStore.getState().selectMode) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // NOT captured here. Capturing on press would take the pointer away
      // from R3F's own picking for the rest of the gesture, and a tap that
      // never moves has to stay a click on an agent. Capture happens on the
      // first real movement instead — see onMove.
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      flick.current = { x: 0, y: 0 } // a new touch cancels the previous coast
      if (pointers.current.size === 1) {
        samples.current = []
        pushSample(samples.current, { x: e.clientX, y: e.clientY, t: e.timeStamp })
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        pinch.current = pinchOf(a, b)
      }
    }

    const onMove = (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId)
      if (!prev) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const ortho = camera as THREE.OrthographicCamera

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()]
        const next = pinchOf(a, b)
        const base = pinch.current
        pinch.current = next
        if (!base) return
        const step = pinchStep(base, next)
        // Pan first, at the pre-zoom scale, then zoom about the midpoint —
        // doing it the other way round makes a two-finger drag drift.
        startManual()
        panScreen(-step.panPx.x / ortho.zoom, -step.panPx.y / ortho.zoom)
        if (Math.abs(step.zoomFactor - 1) > 1e-4) zoomAt(step.zoomFactor, next.cx, next.cy)
        twist.current += step.twist
        const spent = twistTurns(twist.current)
        if (spent.turns !== 0) {
          twist.current = spent.rest
          // `rotate` takes one step at a time on purpose — the store counts
          // turns and the camera damps toward the count, so feeding it a
          // multi-step delta would read as a spin rather than a turn.
          const dir = spent.turns > 0 ? 1 : -1
          for (let i = 0; i < Math.abs(spent.turns); i += 1) useSceneStore.getState().rotate(dir)
        }
        return
      }

      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (Math.abs(dx) + Math.abs(dy) < 1) return
      // Now it is a drag, so take the pointer: without capture a finger that
      // slides off the canvas mid-drag silently stops steering and the camera
      // sticks half-way through the gesture.
      if (!el.hasPointerCapture?.(e.pointerId)) el.setPointerCapture?.(e.pointerId)
      pushSample(samples.current, { x: e.clientX, y: e.clientY, t: e.timeStamp })
      startManual()
      // Screen pixels → world units at the current zoom, so the ground tracks
      // the finger instead of drifting at a different speed.
      panScreen(-dx / ortho.zoom, -dy / ortho.zoom)
    }

    const onUp = (e: PointerEvent) => {
      const wasDragging = pointers.current.size === 1 && pointers.current.has(e.pointerId)
      pointers.current.delete(e.pointerId)
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture?.(e.pointerId)
      if (pointers.current.size < 2) pinch.current = null
      if (pointers.current.size === 1) {
        // Dropped from two fingers to one: re-baseline, or the remaining
        // finger's position jumps the camera by the gap between them.
        samples.current = []
        twist.current = 0
      }
      if (wasDragging) {
        flick.current = flickVelocity(samples.current, e.timeStamp)
        samples.current = []
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.style.touchAction = previousTouchAction
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, setManual])

  /** Take control at the camera's current position, so grabbing it never
   *  jumps the view. */
  function startManual() {
    if (!useSceneStore.getState().manual) {
      manualFocus.current.copy(lookAt.current)
      manualZoom.current = (camera as THREE.OrthographicCamera).zoom
      setManual(true)
    }
  }

  /** Move the focus by a screen-space delta, rotated into the world by the
   *  camera's current yaw — "up" has to mean up-the-screen at every corner,
   *  not a fixed compass direction. */
  function panScreen(right: number, up: number) {
    const c = Math.cos(yaw.current)
    const sn = Math.sin(yaw.current)
    // Screen-right and screen-up on the ground plane for an iso camera.
    manualFocus.current.x += right * c + up * sn
    manualFocus.current.z += -right * sn + up * c
    manualFocus.current.x = clamp(manualFocus.current.x, -PAN_MARGIN, COLS + PAN_MARGIN)
    manualFocus.current.z = clamp(manualFocus.current.z, -PAN_MARGIN, ROWS + PAN_MARGIN)
  }
  const lookAt = useRef(new THREE.Vector3(COLS / 2, 0, ROWS / 2))
  /** Live yaw, chasing `quarterTurns * 90°`. Kept unnormalised on purpose so
   *  repeated turns in one direction keep going that way. */
  const yaw = useRef(0)
  const offset = useRef(new THREE.Vector3())

  /** The world's on-screen extent under THIS camera's rotation, in world
   *  units — measured by projecting the ground-plane corners onto the
   *  camera's own right/up axes rather than assumed from COLS/ROWS, so it
   *  stays correct if the iso angle ever changes. */
  const footprint = useRef({ w: COLS, h: ROWS })

  useFrame((_, dt) => {
    const hotRoom = hotRoomOf(agents)
    const closeRoomId = closeRoomIdFor({ selectedId, selectedRoomId, agents, hotRoom })

    let focus: { x: number; z: number }
    let spanTiles: number
    if (zoom === 'far') {
      focus = { x: COLS / 2, z: ROWS / 2 }
      spanTiles = 0 // fit-to-frame below, not a fixed span
    } else if (zoom === 'close') {
      focus = focusTileFor(closeRoomId)
      spanTiles = CLOSE_SPAN_TILES
    } else {
      focus = focusTileFor(hotRoom)
      spanTiles = MEDIUM_SPAN_TILES
    }

    // Frame-rate-independent easing. `lerp(x, 0.08)` per frame converges
    // twice as fast on a 120Hz display as on a 60Hz one — the camera
    // literally moved at a different speed depending on the monitor. This
    // is the same 0.08-at-60fps feel, expressed as a time constant.
    const k = Math.min(1, 1 - Math.pow(1 - 0.08, dt * 60))
    // Once the viewer has taken control, the tiers stop choosing where to
    // look — the whole point of `manual` is that the camera stays put.
    if (manual) {
      focus = { x: manualFocus.current.x, z: manualFocus.current.z }
    }
    lookAt.current.lerp(new THREE.Vector3(focus.x, 0, focus.z), k)

    // A turn is a slower move than a pan — at the pan's rate a quarter-turn
    // snaps. This is the same shape of easing, given its own time constant.
    const turnK = Math.min(1, 1 - Math.pow(1 - 0.055, dt * 60))
    yaw.current = dampAngle(yaw.current, (quarterTurns * Math.PI) / 2, turnK)

    offset.current.set(
      Math.sin(yaw.current + Math.PI / 4) * ISO_RADIUS,
      ISO_HEIGHT,
      Math.cos(yaw.current + Math.PI / 4) * ISO_RADIUS,
    )
    camera.position.copy(lookAt.current).addScaledVector(offset.current, ISO_DISTANCE)
    camera.lookAt(lookAt.current)
    camera.updateMatrixWorld()

    const ortho = camera as THREE.OrthographicCamera

    // Held-key panning, applied before the focus is used so movement lands
    // on this frame rather than the next.
    // Keys ramp instead of switching. Binary keys — full speed on the first
    // frame, a dead stop on release — are why WASD read as a spreadsheet
    // rather than a game. Release is quicker than press: a camera that keeps
    // drifting after you let go feels broken, one that takes a moment to get
    // going feels weighty.
    const want = heldAxis(held.current)
    const accel = want.x || want.y ? KEY_ACCEL_SEC : KEY_RELEASE_SEC
    keyVel.current = {
      x: rampAxis(keyVel.current.x, want.x, dt, accel),
      y: rampAxis(keyVel.current.y, want.y, dt, accel),
    }
    if (keyVel.current.x || keyVel.current.y) {
      if (want.x || want.y) startManual()
      // size.height / zoom is the world height currently on screen.
      const step = PAN_SCREENS_PER_SEC * (size.height / ortho.zoom) * dt
      panScreen(keyVel.current.x * step, keyVel.current.y * step)
    }

    // Coast after a released drag, then stop cleanly rather than crawling.
    if (!isNegligible(flick.current)) {
      panScreen(-(flick.current.x * dt) / ortho.zoom, -(flick.current.y * dt) / ortho.zoom)
      flick.current = decayVelocity(flick.current, dt, FLICK_HALF_LIFE_SEC)
    } else if (flick.current.x || flick.current.y) {
      flick.current = { x: 0, y: 0 }
    }

    let targetZoom: number
    if (zoom === 'far') {
      const fp = measureFootprint(camera)
      footprint.current = fp
      // Fit both axes and take the tighter one, so nothing is cropped and
      // no axis is left with a band of empty background.
      targetZoom = Math.min(size.width / (fp.w * FAR_MARGIN), size.height / (fp.h * FAR_MARGIN))
    } else {
      const minSide = Math.max(1, Math.min(size.width, size.height))
      targetZoom = minSide / spanTiles
    }
    if (manual && manualZoom.current) targetZoom = manualZoom.current
    ortho.zoom += (targetZoom - ortho.zoom) * k
    ortho.updateProjectionMatrix()
  })

  return null
}
