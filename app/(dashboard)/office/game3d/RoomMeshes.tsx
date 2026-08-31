'use client'

/**
 * Procedural room geometry — no Blender, no imported models (see the
 * redesign discussion this file came out of: a hand-modeled office would
 * need remodeling every time a room's shape changes, the same reason the
 * reference "AI Office" toy this whole engine descends from built its
 * rooms from code). A room is a floor slab, a wall ring with real gaps at
 * its real door tiles, and a Drei `<Html>` label reusing the exact
 * count/alert badge `zoom.ts`'s `roomStatsOf` already computes for the
 * DOM renderer — one source of truth for "what a room's badge says",
 * two renderers drawing it.
 *
 * The walls now stand at room height and CUT AWAY on the side the viewer is
 * looking through (`walls.ts`, where the arithmetic and its tests live).
 * That is the difference between the reference renders and what this scene
 * used to draw: their rooms are interiors opened up for the camera; a ring
 * of knee-high boxes is a floor plan. Everything that hangs on a wall —
 * the coping along its top, the light line at its foot, the panels on its
 * inside face — is built here rather than in RoomDecor, because all of it
 * has to rise and fall with the wall that carries it.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { ROOMS, type Room } from '../game/world'
import { roomStatsOf, hotRoomOf } from '../game/zoom'
import type { Agent } from '../game/live-engine'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'
import { gridTexture } from './gridTexture'
import {
  WALL_CAP_T,
  WALL_H,
  WALL_T,
  sideNormal,
  wallCarriesDecor,
  wallHeightFor,
  wallRuns,
  type WallRun,
} from './walls'

const BOX = new THREE.BoxGeometry(1, 1, 1)
const PLANE = new THREE.PlaneGeometry(1, 1)

/** How far a wall-hung display sits proud of the wall's centre line. */
const PANEL_INSET = WALL_T / 2 + 0.05

function floorColorFor(theme: OfficeTheme, kind: Room['kind']): string {
  return kind === 'ceo' ? theme.floorCeo : kind === 'lounge' ? theme.floorLounge : theme.floorDept
}

/** Deterministic per-run noise, so a room's panels don't reshuffle on every
 *  render. Same trick, and same reason, as RoomDecor's. */
function hash(a: number, b: number, salt: number): number {
  let h = Math.imul((a * 73856093) ^ (b * 19349663) ^ (salt * 83492791), 2654435761)
  h = (h ^ (h >>> 15)) >>> 0
  return h / 0xffffffff
}

type WallMaterials = {
  wall: THREE.MeshStandardMaterial
  cap: THREE.MeshStandardMaterial
  trim: THREE.MeshBasicMaterial
  panelFrame: THREE.MeshStandardMaterial
  panelScreen: THREE.MeshBasicMaterial
}

/**
 * One unbroken stretch of wall, with everything attached to it.
 *
 * It owns its own height: `useFrame` reads which way the camera faces, asks
 * `wallHeightFor` how tall this side should be, and damps toward it. Doing
 * it per run rather than per room is what lets the near corner of a room
 * drop while the far corner stays up, and there are only ~70 runs on the
 * whole deck, so the per-frame cost is a handful of scalar writes.
 */
function WallRunMesh({
  run,
  mats,
  panelWidth,
}: {
  run: WallRun
  mats: WallMaterials
  /** Width of the display hung on this run's inside face, or 0 for none. */
  panelWidth: number
}) {
  const wall = useRef<THREE.Mesh>(null)
  const cap = useRef<THREE.Mesh>(null)
  const panel = useRef<THREE.Group>(null)
  const height = useRef(WALL_H)
  const [nx, nz] = useMemo(() => sideNormal(run.side), [run.side])

  useFrame(({ camera }, dt) => {
    // The camera's forward direction is the negated third column of its
    // world matrix. Read straight out of the matrix: an orthographic camera
    // has one view direction for the whole scene, and this avoids allocating
    // a vector per run per frame.
    const e = camera.matrixWorld.elements
    const facing = nx * -e[8] + nz * -e[10]
    const target = wallHeightFor(facing)
    // Damped rather than assigned, so the walls settle instead of tracking
    // the camera's own damped spin one-to-one and jittering with it.
    height.current = THREE.MathUtils.damp(height.current, target, 9, dt)
    const h = height.current

    const w = wall.current
    if (w) {
      w.scale.y = h
      w.position.y = h / 2
    }
    const c = cap.current
    if (c) c.position.y = h + WALL_CAP_T / 2
    const p = panel.current
    if (p) {
      const on = wallCarriesDecor(h)
      p.visible = on
      if (on) p.position.y = h * 0.55
    }
  })

  const long = run.length
  const sx = run.alongX ? long : WALL_T
  const sz = run.alongX ? WALL_T : long
  // Panels face into the room, which is the direction opposite the outward
  // normal — one rotation covers both the geometry and which way it looks.
  const ry = run.alongX ? (nz < 0 ? 0 : Math.PI) : nx < 0 ? Math.PI / 2 : -Math.PI / 2

  return (
    <group position={[run.x, 0, run.z]}>
      <mesh ref={wall} castShadow receiveShadow geometry={BOX} material={mats.wall} position={[0, WALL_H / 2, 0]} scale={[sx, WALL_H, sz]} />
      {/* Coping. Slightly proud of the wall on both faces so it catches the
          key light as a bright rail — the single line that reads as "wall"
          from an isometric angle, and the thing every reference render of
          this scene draws. */}
      <mesh
        ref={cap}
        castShadow
        geometry={BOX}
        material={mats.cap}
        position={[0, WALL_H + WALL_CAP_T / 2, 0]}
        scale={[sx + (run.alongX ? 0 : 0.14), WALL_CAP_T, sz + (run.alongX ? 0.14 : 0)]}
      />
      {/* The light line at the foot of the wall. Outside the height
          animation on purpose: a cut-away wall still keeps its trim, so a
          room you are looking INTO still has its own footprint drawn rather
          than bleeding into the floor of the room behind it. */}
      <mesh
        geometry={BOX}
        material={mats.trim}
        position={[0, 0.045, 0]}
        scale={[sx + (run.alongX ? 0 : 0.06), 0.05, sz + (run.alongX ? 0.06 : 0)]}
      />
      {panelWidth > 0 && (
        // Pushed clear of the wall's own thickness along the inward normal.
        // Centred on the run, it sat INSIDE the 0.94-thick wall and rendered
        // nothing at all — a whole room's worth of displays that existed in
        // the tree and could not be seen from any angle.
        <group ref={panel} position={[-nx * PANEL_INSET, WALL_H * 0.55, -nz * PANEL_INSET]} rotation={[0, ry, 0]}>
          <mesh castShadow geometry={BOX} material={mats.panelFrame} scale={[panelWidth, 0.78, 0.07]} />
          <mesh geometry={PLANE} material={mats.panelScreen} position={[0, 0, 0.045]} scale={[panelWidth - 0.14, 0.64, 1]} />
        </group>
      )}
    </group>
  )
}

function RoomMesh({
  room,
  stat,
  hot,
  theme,
  onSelectRoom,
}: {
  room: Room
  stat: { count: number; alert: boolean } | undefined
  hot: boolean
  theme: OfficeTheme
  onSelectRoom?: (room: Room) => void
}) {
  const runs = useMemo(() => wallRuns(room), [room])
  const cx = room.x + room.w / 2
  const cz = room.y + room.h / 2
  const floorTex = useMemo(() => {
    const tex = gridTexture(floorColorFor(theme, room.kind), theme.floorLine)
    const t = tex.clone()
    t.needsUpdate = true
    t.repeat.set(room.w, room.h)
    return t
  }, [room, theme])

  const wallEmissive = stat?.alert ? theme.wallGlowRed : hot ? theme.wallGlowAmber : theme.wallGlowCyan
  const wallEmissiveIntensity = theme.glow ? (stat?.alert ? 1.4 : hot ? 0.9 : 0.4) : 0

  // Per room, not per run: a run's materials are the same for every run on
  // the room, and the alert/hot state is a property of the room.
  const mats = useMemo<WallMaterials>(
    () => ({
      wall: new THREE.MeshStandardMaterial({
        color: theme.wall,
        emissive: wallEmissive,
        emissiveIntensity: wallEmissiveIntensity,
        roughness: 0.72,
        metalness: 0.12,
      }),
      cap: new THREE.MeshStandardMaterial({ color: theme.wallTop, roughness: 0.42, metalness: 0.45 }),
      trim: new THREE.MeshBasicMaterial({ color: theme.wallTrim, toneMapped: false }),
      panelFrame: new THREE.MeshStandardMaterial({ color: theme.prop.frame, roughness: 0.45, metalness: 0.5 }),
      panelScreen: new THREE.MeshBasicMaterial({ color: theme.prop.screen, toneMapped: false }),
    }),
    [theme, wallEmissive, wallEmissiveIntensity],
  )

  // Which runs carry a display. Long runs only — a screen wider than the
  // wall it hangs on is the tell that a scene was generated rather than
  // dressed — and roughly half of those, so the deck has texture instead of
  // a screen on every surface.
  const panelWidths = useMemo(
    () =>
      runs.map((r, i) => {
        if (r.length < 5) return 0
        if (hash(Math.round(r.x * 2), Math.round(r.z * 2), i) < 0.42) return 0
        return Math.min(r.length - 1.4, 1.8 + hash(Math.round(r.x * 2), Math.round(r.z * 2), i + 31) * 2.2)
      }),
    [runs],
  )

  return (
    <group>
      <mesh
        receiveShadow
        position={[cx, 0, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerUp={(e) => {
          e.stopPropagation()
          onSelectRoom?.(room)
        }}
      >
        <planeGeometry args={[room.w, room.h]} />
        <meshStandardMaterial map={floorTex} roughness={0.85} metalness={0.1} />
      </mesh>
      {runs.map((run, i) => (
        <WallRunMesh key={`${run.side}-${i}`} run={run} mats={mats} panelWidth={panelWidths[i]} />
      ))}
      {room.doors.map((d, i) => (
        <mesh key={i} position={[d.x + 0.5, 0.02, d.y + 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1, 0.6]} />
          <meshBasicMaterial color={theme.door} toneMapped={false} />
        </mesh>
      ))}
      <Html position={[cx, WALL_H + 0.55, room.y]} center occlude={false}>
        <div className="rm3d-label">
          <b>
            {room.icon} {room.name}
          </b>
          {stat && stat.count > 0 && (
            <span className={`rm3d-count${stat.alert ? ' alert' : ''}`}>{stat.alert ? '⚠' : stat.count}</span>
          )}
        </div>
      </Html>
    </group>
  )
}

export function RoomMeshes({ agents, onSelectRoom }: { agents: Agent[]; onSelectRoom?: (room: Room) => void }) {
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  const stats = useMemo(() => roomStatsOf(agents), [agents])
  const hotRoom = useMemo(() => hotRoomOf(agents), [agents])
  return (
    <>
      {ROOMS.map((room) => (
        <RoomMesh key={room.id} room={room} stat={stats.get(room.id)} hot={room.id === hotRoom} theme={theme} onSelectRoom={onSelectRoom} />
      ))}
    </>
  )
}
