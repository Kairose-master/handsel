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
import { WALL_H, WALL_T, sideNormal, wallRuns } from './walls'

const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10)
const PLANE = new THREE.PlaneGeometry(1, 1)

const DESK_TOP = 0.7 // desk surface height from RoomProps
/** Above the walls, which are now room-height and moved with them: this
 *  used to be a second copy of the number, which is how the two files came
 *  to disagree the first time one of them changed. */
const CEILING = WALL_H + 1.0

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
      /** The deck's own edge lighting, the same hue as the wall trim inside
       *  so the platform and the rooms read as one built thing. */
      edge: new THREE.MeshBasicMaterial({ color: theme.wallTrim, toneMapped: false }),
      /** Deck sides — a shade under the curb, so the platform has a top face
       *  and a dark flank instead of one flat colour all the way round. */
      deck: new THREE.MeshStandardMaterial({ color: theme.glow ? '#0b1119' : '#33212c', roughness: 0.85, metalness: 0.2 }),
      /** The walkway between the rooms. Lighter than the deck's flanks: it
       *  is the only large surface between rooms, and at the curb's own
       *  near-black it swallowed everything crossing it — agents walking a
       *  corridor disappeared between one door and the next. */
      walkway: new THREE.MeshStandardMaterial({ color: theme.glow ? '#141d28' : '#3d2836', roughness: 0.9, metalness: 0.1 }),
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

/* The wall panels that used to live here moved into RoomMeshes' `WallRunMesh`.
 * They were positioned against the north and west faces at a fixed height,
 * which was fine while every wall was the same knee-high box. Now a wall
 * drops to a curb when the viewer turns to look through it, and a panel that
 * does not drop with it is a screen hanging in mid-air over an open room.
 * A thing mounted on a wall belongs to that wall. */

/**
 * The stuff along the walls.
 *
 * `world.ts` gives a department three desks, a shelf, a rack and a plant in
 * a 22x14 room, and that is the honest reason the rooms read as emptier
 * than the reference sheets: those show every wall lined with low storage,
 * counters and boxes, and the floor space left for people to move through.
 * Nothing here can be added to `PROPS` to fix that — `buildGrid` blocks
 * every prop tile, so lining the walls with furniture there would wall the
 * rooms in and strand the pathfinder.
 *
 * So the units are hung on the WALL tiles, which are already blocked, and
 * kept shallow enough to stay over them. Same rule as the rest of this
 * file: placed only where an agent can never be.
 */
const UNIT_D = 0.34
const UNIT_H = 0.86
const LOCKER_H = 1.62

function WallUnits({ room, mats }: { room: Room; mats: Mats }) {
  const units = useMemo(() => {
    const out: { x: number; z: number; ry: number; len: number; h: number; boxes: number }[] = []
    for (const run of wallRuns(room)) {
      if (run.length < 4) continue
      const [nx, nz] = sideNormal(run.side)
      const inset = WALL_T / 2 + UNIT_D / 2
      // Along-run axis, in world terms.
      const ax = run.alongX ? 1 : 0
      const az = run.alongX ? 0 : 1
      // One or two segments, never the whole wall: a continuous ring of
      // cabinets is a corridor, not a room someone works in.
      const segments = hash(run.length, Math.round(run.x + run.z), 2) > 0.5 ? 2 : 1
      for (let i = 0; i < segments; i += 1) {
        const r = hash(Math.round(run.x * 4), Math.round(run.z * 4), i + 9)
        if (r < 0.22) continue
        const len = Math.min(run.length / (segments + 0.6), 2.2 + r * 2.4)
        // Spread the segments along the run rather than stacking them.
        const t = segments === 1 ? (r - 0.5) * (run.length - len) * 0.6 : (i - 0.5) * (run.length - len) * 0.55
        out.push({
          x: run.x - nx * inset + ax * t,
          z: run.z - nz * inset + az * t,
          ry: run.alongX ? 0 : Math.PI / 2,
          len,
          h: r > 0.78 ? LOCKER_H : UNIT_H,
          boxes: r > 0.78 ? 0 : Math.round(r * 3),
        })
      }
    }
    return out
  }, [room])

  return (
    <>
      {units.map((u, i) => (
        <group key={i} position={[u.x, 0, u.z]} rotation={[0, u.ry, 0]}>
          <mesh castShadow receiveShadow geometry={BOX} material={mats.dark} position={[0, u.h / 2, 0]} scale={[u.len, u.h, UNIT_D]} />
          {/* A lighter top, which is what stops a run of these reading as a
              second, shorter wall. */}
          <mesh geometry={BOX} material={mats.light} position={[0, u.h + 0.02, 0]} scale={[u.len + 0.06, 0.04, UNIT_D + 0.06]} />
          {Array.from({ length: u.boxes }, (_, b) => (
            <mesh
              key={b}
              castShadow
              geometry={BOX}
              material={b % 2 ? mats.paper : mats.light}
              position={[(-u.len / 2 + 0.3) + b * 0.5, u.h + 0.16, 0]}
              rotation={[0, hash(b, Math.round(u.x), 21) * 0.5 - 0.25, 0]}
              scale={[0.28, 0.22, 0.24]}
            />
          ))}
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

/**
 * The platform the office is built on.
 *
 * The reference renders do not show rooms floating on a plane — they show a
 * deck: a slab with real thickness, a stepped skirt, a parapet round the
 * edge, and a line of lights along it. That silhouette is most of what makes
 * the thing read as an object you could pick up, and it is entirely outside
 * the COLS x ROWS walkable grid, so none of it can be stood on or routed
 * through.
 */
const DECK_MARGIN = 3
const DECK_W = COLS + DECK_MARGIN * 2
const DECK_D = ROWS + DECK_MARGIN * 2
const DECK_DROP = 0.9
const PARAPET_H = 0.55
const PARAPET_T = 0.7

function Exterior({ mats }: { mats: Mats }) {
  const planters = useMemo(() => {
    const out: { x: number; z: number; s: number }[] = []
    const margin = DECK_MARGIN - 1
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

  /** The four parapet walls, as centre + span. Written once and mapped
   *  rather than four near-identical JSX blocks, so the two long sides and
   *  the two short ones cannot drift apart. */
  const rails = useMemo(() => {
    const cx = COLS / 2
    const cz = ROWS / 2
    const halfW = DECK_W / 2
    const halfD = DECK_D / 2
    return [
      { x: cx, z: cz - halfD + PARAPET_T / 2, w: DECK_W, d: PARAPET_T },
      { x: cx, z: cz + halfD - PARAPET_T / 2, w: DECK_W, d: PARAPET_T },
      { x: cx - halfW + PARAPET_T / 2, z: cz, w: PARAPET_T, d: DECK_D - PARAPET_T * 2 },
      { x: cx + halfW - PARAPET_T / 2, z: cz, w: PARAPET_T, d: DECK_D - PARAPET_T * 2 },
    ]
  }, [])

  /** Lights set into the top of the parapet at a fixed spacing. In the
   *  references these are the brightest thing at the deck's edge and they
   *  are what stops the platform dissolving into the background. */
  const edgeLights = useMemo(() => {
    const out: { x: number; z: number }[] = []
    const step = 6
    for (let x = -DECK_MARGIN + 2; x < COLS + DECK_MARGIN - 1; x += step) {
      out.push({ x, z: -DECK_MARGIN + PARAPET_T / 2 })
      out.push({ x, z: ROWS + DECK_MARGIN - PARAPET_T / 2 })
    }
    for (let z = -DECK_MARGIN + 2; z < ROWS + DECK_MARGIN - 1; z += step) {
      out.push({ x: -DECK_MARGIN + PARAPET_T / 2, z })
      out.push({ x: COLS + DECK_MARGIN - PARAPET_T / 2, z })
    }
    return out
  }, [])

  return (
    <group>
      <mesh
        receiveShadow
        geometry={PLANE}
        material={mats.ground}
        position={[COLS / 2, -DECK_DROP - 1.4, ROWS / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[COLS + 60, ROWS + 60, 1]}
      />
      {/* The slab itself, with real thickness. A plane has none, and an
          isometric camera reads a zero-height platform as a painted shape. */}
      <mesh
        receiveShadow
        castShadow
        geometry={BOX}
        material={mats.deck}
        position={[COLS / 2, -DECK_DROP / 2, ROWS / 2]}
        scale={[DECK_W, DECK_DROP, DECK_D]}
      />
      {/* A wider step under it. Two edges instead of one is the difference
          between a slab and a plinth. */}
      <mesh
        receiveShadow
        castShadow
        geometry={BOX}
        material={mats.curb}
        position={[COLS / 2, -DECK_DROP - 0.28, ROWS / 2]}
        scale={[DECK_W + 2.4, 0.56, DECK_D + 2.4]}
      />
      {/* The floor of the deck — what the rooms actually stand on, and the
          surface that catches their shadows. */}
      <mesh
        receiveShadow
        geometry={PLANE}
        material={mats.walkway}
        position={[COLS / 2, -0.02, ROWS / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[DECK_W, DECK_D, 1]}
      />
      {rails.map((r, i) => (
        <group key={i}>
          <mesh castShadow receiveShadow geometry={BOX} material={mats.curb} position={[r.x, PARAPET_H / 2, r.z]} scale={[r.w, PARAPET_H, r.d]} />
          <mesh geometry={BOX} material={mats.dark} position={[r.x, PARAPET_H + 0.03, r.z]} scale={[r.w + 0.12, 0.06, r.d + 0.12]} />
        </group>
      ))}
      {edgeLights.map((l, i) => (
        <mesh key={i} geometry={BOX} material={mats.edge} position={[l.x, PARAPET_H + 0.08, l.z]} scale={[0.34, 0.05, 0.34]} />
      ))}
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
          <WallUnits room={room} mats={mats} />
          <Beams room={room} mats={mats} />
        </group>
      ))}
    </>
  )
}
