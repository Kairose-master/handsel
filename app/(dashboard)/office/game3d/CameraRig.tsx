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
 * Free click-and-drag panning is the one capability this trades away for
 * now; the three zoom tiers plus click-to-focus (an inspect click already
 * recenters on its target) cover real navigation without it.
 */
import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { CEO_ROOM, ROOMS, COLS, ROWS } from '../game/world'
import { hotRoomOf, closeRoomIdFor } from '../game/zoom'
import type { Agent } from '../game/live-engine'
import { useSceneStore } from './scene-store'

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
  const { camera, size } = useThree()
  const zoom = useSceneStore((s) => s.zoom)
  const quarterTurns = useSceneStore((s) => s.quarterTurns)
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
    ortho.zoom += (targetZoom - ortho.zoom) * k
    ortho.updateProjectionMatrix()
  })

  return null
}
