'use client'

/**
 * Isometric camera: fixed elevation angle (a diorama, never a free-orbit
 * scene — rotating away from the iso angle would make room shapes and
 * agent facing unreadable, the same reason the DOM engine never rotated
 * either), driven by the same three zoom tiers and the same focus priority
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
const FAR_SPAN_TILES = 100
const MEDIUM_SPAN_TILES = 46
const CLOSE_SPAN_TILES = 16

// Fixed isometric elevation — the constant offset FROM the look-at point TO
// the camera. Distance is arbitrary for an orthographic camera (it only
// picks near/far clipping, never apparent size); the direction is what
// gives the diorama its angle (~44° elevation, the classic iso feel).
const ISO_OFFSET = new THREE.Vector3(1, 1.35, 1).normalize().multiplyScalar(120)

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
  const lookAt = useRef(new THREE.Vector3(COLS / 2, 0, ROWS / 2))

  useFrame(() => {
    const hotRoom = hotRoomOf(agents)
    const closeRoomId = closeRoomIdFor({ selectedId, selectedRoomId, agents, hotRoom })

    let focus: { x: number; z: number }
    let spanTiles: number
    if (zoom === 'far') {
      focus = { x: COLS / 2, z: ROWS / 2 }
      spanTiles = FAR_SPAN_TILES
    } else if (zoom === 'close') {
      focus = focusTileFor(closeRoomId)
      spanTiles = CLOSE_SPAN_TILES
    } else {
      focus = focusTileFor(hotRoom)
      spanTiles = MEDIUM_SPAN_TILES
    }

    lookAt.current.lerp(new THREE.Vector3(focus.x, 0, focus.z), 0.08)
    camera.position.copy(lookAt.current).add(ISO_OFFSET)
    camera.lookAt(lookAt.current)

    const ortho = camera as THREE.OrthographicCamera
    const minSide = Math.max(1, Math.min(size.width, size.height))
    const targetZoom = minSide / spanTiles
    ortho.zoom += (targetZoom - ortho.zoom) * 0.08
    ortho.updateProjectionMatrix()
  })

  return null
}
