'use client'

/**
 * Set dressing — density that is deliberately NOT furniture.
 *
 * `RoomProps.tsx` renders `world.ts`'s `PROPS`, and every one of those tiles
 * is solid in `buildGrid`: adding a prop there changes where agents can
 * walk. That makes PROPS the wrong place to put "more stuff so the room
 * looks lived in", because the pathfinder would start routing around
 * scenery and the 2D renderer would draw it too.
 *
 * So everything in this file is placed only where the collision grid is
 * ALREADY solid, or where an agent can never be at all:
 *
 *   • on top of existing desks (those tiles are blocked by the desk itself)
 *   • on the inside faces of walls (wall tiles are blocked)
 *   • at ceiling height, above everything
 *   • outside the walkable world entirely — the ground the office sits on
 *
 * Nothing here is reachable, so nothing here can change a route. That is
 * the whole design constraint, and it is why this is a separate file from
 * RoomProps rather than more entries in it.
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { COLS, ROWS, PROPS, ROOMS, type Room } from '../game/world'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'

const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10)
const PLANE = new THREE.PlaneGeometry(1, 1)

const DESK_TOP = 0.7 // desk surface height from RoomProps
const WALL_H = 1.3 // wall height from RoomMeshes
const CEILING = 3.6

/** Deterministic per-position noise. Set dressing must not reshuffle on
 *  every render — a mug that moves when React re-renders reads as a bug. */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x * 73856093 ^ y * 19349663 ^ salt * 83492791, 2654435761)
  h = (h ^ (h >>> 15)) >>> 0
  return h / 0xffffffff
}

function useDecorMaterials(theme: OfficeTheme) {
  return useMemo(() => {
    const p = theme.prop
    return {
      dark: new THREE.MeshStandardMaterial({ color: p.frame, roughness: 0.5, metalness: 0.5 }),
      light: new THREE.MeshStandardMaterial({ color: p.surface, roughness: 0.7, metalness: 0.05 }),
      paper: new THREE.MeshStandardMaterial({ color: theme.glow ? '#b9c9d8' : '#fffaf2', roughness: 0.95 }),
      screen: new THREE.MeshBasicMaterial({ color: p.screen, toneMapped: false }),
      // The ground the deck stands on. Without it the office floats in a
      // void, which is most of why it read as a diagram rather than a place.
      ground: new THREE.MeshStandardMaterial({ color: theme.glow ? '#080b11' : '#2a1a24', roughness: 1 }),
      curb: new THREE.MeshStandardMaterial({ color: theme.glow ? '#101822' : '#3b2734', roughness: 0.9, metalness: 0.15 }),
      beam: new THREE.MeshStandardMaterial({ color: theme.glow ? '#0d141d' : '#33202c', roughness: 0.95 }),
      foliage: new THREE.MeshStandardMaterial({ color: p.foliage, roughness: 0.85 }),
    }
  }, [theme])
}

type Mats = ReturnType<typeof useDecorMaterials>

/** Keyboard, mug and a stack of paper on a desk that already exists. The
 *  desk's own tiles are solid, so none of this is reachable. */
function DeskClutter({ x, z, w, mats }: { x: number; z: number; w: number; mats: Mats }) {
  const r = hash(Math.round(x), Math.round(z), 7)
  const r2 = hash(Math.round(x), Math.round(z), 13)
  return (
    <group position={[x, DESK_TOP, z]}>
      <mesh castShadow geometry={BOX} material={mats.dark} position={[0, 0.02, 0.16]} scale={[0.5, 0.03, 0.18]} />
      <mesh castShadow geometry={CYL} material={mats.light} position={[w / 2 - 0.35 - r * 0.2, 0.055, 0.06]} scale={[0.055, 0.11, 0.055]} />
      {r2 > 0.45 && (
        <mesh castShadow geometry={BOX} material={mats.paper} position={[-w / 2 + 0.32, 0.025, 0.1]} scale={[0.26, 0.05, 0.2]} rotation={[0, r * 0.5 - 0.25, 0]} />
      )}
    </group>
  )
}

/** Emissive panels hung on the inside faces of a room's walls. Wall tiles
 *  are already solid, and a panel at chest height on a 1.3-high wall never
 *  meets the floor, so this is pure surface. Two walls rather than four:
 *  the deck can be turned now, and something on every wall would mean the
 *  near wall is always a lit slab blocking the room behind it. */
function WallScreens({ room, mats }: { room: Room; mats: Mats }) {
  const panels = useMemo(() => {
    const out: { x: number; z: number; ry: number; w: number }[] = []
    for (let i = 1; i <= 3; i += 1) {
      const t = i / 4
      if (hash(room.x, room.y, i) > 0.35) {
        out.push({ x: room.x + room.w * t, z: room.y + 0.42, ry: 0, w: 1.5 + hash(room.x, room.y, i + 40) })
      }
      if (hash(room.x, room.y, i + 20) > 0.45) {
        out.push({ x: room.x + 0.42, z: room.y + room.h * t, ry: Math.PI / 2, w: 1.5 + hash(room.x, room.y, i + 60) })
      }
    }
    return out
  }, [room])

  return (
    <>
      {panels.map((p, i) => (
        <group key={i} position={[p.x, WALL_H * 0.68, p.z]} rotation={[0, p.ry, 0]}>
          <mesh castShadow geometry={BOX} material={mats.dark} scale={[p.w, 0.62, 0.06]} />
          <mesh geometry={PLANE} material={mats.screen} position={[0, 0, 0.04]} scale={[p.w - 0.12, 0.5, 1]} />
        </group>
      ))}
    </>
  )
}

/** One structural beam per room at ceiling height — an overhead layer for
 *  the iso view to read depth against instead of open black above the walls.
 *
 *  Deliberately thin, dark and SHADOWLESS. Two fatter beams casting real
 *  shadows put hard bands across every floor, and in an isometric projection
 *  a horizontal bar high above the floor is ambiguous with one lying on it —
 *  the room ended up reading as if someone had dropped girders on the
 *  carpet. Kept as a hint of structure, not as a feature. */
function Beams({ room, mats }: { room: Room; mats: Mats }) {
  return (
    <mesh
      geometry={BOX}
      material={mats.beam}
      position={[room.x + room.w / 2, CEILING, room.y + room.h / 2]}
      scale={[room.w - 0.4, 0.1, 0.22]}
    />
  )
}

/** The ground the whole deck stands on, plus a planted perimeter. All of it
 *  is outside the COLS x ROWS walkable grid, so it cannot be stood on. */
function Exterior({ mats }: { mats: Mats }) {
  const planters = useMemo(() => {
    const out: { x: number; z: number; s: number }[] = []
    const margin = 5
    for (let x = -margin; x <= COLS + margin; x += 9) {
      out.push({ x, z: -margin, s: 0.6 + hash(x, -margin, 3) * 0.5 })
      out.push({ x, z: ROWS + margin, s: 0.6 + hash(x, ROWS + margin, 5) * 0.5 })
    }
    for (let z = -margin + 9; z < ROWS + margin; z += 9) {
      out.push({ x: -margin, z, s: 0.6 + hash(-margin, z, 11) * 0.5 })
      out.push({ x: COLS + margin, z, s: 0.6 + hash(COLS + margin, z, 17) * 0.5 })
    }
    return out
  }, [])

  return (
    <group>
      <mesh
        receiveShadow
        geometry={PLANE}
        material={mats.ground}
        position={[COLS / 2, -0.06, ROWS / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[COLS + 34, ROWS + 34, 1]}
      />
      {/* A low plinth under the office footprint: the deck reads as sitting
          ON something rather than hovering over a plane. */}
      <mesh
        receiveShadow
        castShadow
        geometry={BOX}
        material={mats.curb}
        position={[COLS / 2, -0.03, ROWS / 2]}
        scale={[COLS + 4, 0.06, ROWS + 4]}
      />
      {planters.map((p, i) => (
        <group key={i} position={[p.x, 0, p.z]}>
          <mesh castShadow receiveShadow geometry={BOX} material={mats.curb} position={[0, 0.16, 0]} scale={[1.7, 0.32, 1.7]} />
          <mesh castShadow geometry={CYL} material={mats.foliage} position={[0, 0.34 + p.s * 0.3, 0]} scale={[0.55, p.s * 0.6, 0.55]} />
        </group>
      ))}
    </group>
  )
}

export function RoomDecor() {
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  const mats = useDecorMaterials(theme)
  const desks = useMemo(() => PROPS.filter((p) => p.kind === 'desk' || p.kind === 'ceo-desk'), [])

  return (
    <>
      <Exterior mats={mats} />
      {desks.map((d, i) => (
        <DeskClutter key={i} x={d.x + d.w / 2} z={d.y + d.h / 2} w={d.w} mats={mats} />
      ))}
      {ROOMS.map((room) => (
        <group key={room.id}>
          <WallScreens room={room} mats={mats} />
          <Beams room={room} mats={mats} />
        </group>
      ))}
    </>
  )
}
