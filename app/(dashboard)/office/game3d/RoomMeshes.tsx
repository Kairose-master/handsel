'use client'

/**
 * Procedural room geometry — no Blender, no imported models (see the
 * redesign discussion this file came out of: a hand-modeled office would
 * need remodeling every time a room's shape changes, the same reason the
 * reference "AI Office" toy this whole engine descends from built its
 * rooms from code). A room is a floor slab, a low wall ring with real gaps
 * at its real door tiles, and a Drei `<Html>` label reusing the exact
 * count/alert badge `zoom.ts`'s `roomStatsOf` already computes for the
 * DOM renderer — one source of truth for "what a room's badge says",
 * two renderers drawing it.
 */
import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import { ROOMS, type Room } from '../game/world'
import { roomStatsOf, hotRoomOf } from '../game/zoom'
import type { Agent } from '../game/live-engine'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'
import { gridTexture } from './gridTexture'

const WALL_H = 1.3
const WALL_T = 0.12

function floorColorFor(theme: OfficeTheme, kind: Room['kind']): string {
  return kind === 'ceo' ? theme.floorCeo : kind === 'lounge' ? theme.floorLounge : theme.floorDept
}

/** One wall box per boundary tile that ISN'T a door — simple, and cheap
 *  enough at this room count (~11 rooms) not to need instancing yet. */
function wallSegments(room: Room): { x: number; z: number }[] {
  const doorSet = new Set(room.doors.map((d) => `${d.x},${d.y}`))
  const segs: { x: number; z: number }[] = []
  for (let x = room.x; x < room.x + room.w; x += 1) {
    if (!doorSet.has(`${x},${room.y}`)) segs.push({ x: x + 0.5, z: room.y })
    if (!doorSet.has(`${x},${room.y + room.h - 1}`)) segs.push({ x: x + 0.5, z: room.y + room.h - 1 })
  }
  for (let y = room.y + 1; y < room.y + room.h - 1; y += 1) {
    if (!doorSet.has(`${room.x},${y}`)) segs.push({ x: room.x, z: y + 0.5 })
    if (!doorSet.has(`${room.x + room.w - 1},${y}`)) segs.push({ x: room.x + room.w - 1, z: y + 0.5 })
  }
  return segs
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
  const segs = useMemo(() => wallSegments(room), [room])
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
  const wallEmissiveIntensity = theme.glow ? (stat?.alert ? 1.8 : hot ? 1.1 : 0.55) : 0

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
      {segs.map((s, i) => (
        <mesh key={i} castShadow receiveShadow position={[s.x, WALL_H / 2, s.z]}>
          <boxGeometry args={[WALL_T + 0.9, WALL_H, WALL_T + 0.9]} />
          <meshStandardMaterial color={theme.wall} emissive={wallEmissive} emissiveIntensity={wallEmissiveIntensity} roughness={0.6} />
        </mesh>
      ))}
      {room.doors.map((d, i) => (
        <mesh key={i} position={[d.x + 0.5, 0.02, d.y + 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1, 0.6]} />
          <meshBasicMaterial color={theme.door} toneMapped={false} />
        </mesh>
      ))}
      <Html position={[cx, WALL_H + 0.4, room.y]} center occlude={false}>
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
