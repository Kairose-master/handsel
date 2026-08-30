'use client'

/**
 * The furniture. `world.ts` has always exported a full `PROPS` list — desks
 * with real footprints, shelves, cabinets, plants, a sofa, a coffee counter,
 * the CEO's desk and rug — and the pathfinder has always treated them as
 * solid (`buildGrid` blocks every prop tile except rugs, which is why agents
 * walk around a desk instead of through it). The DOM renderer drew them. The
 * 3D renderer never did: it drew a floor slab, a wall ring and a label, so
 * every room was an empty box that agents mysteriously refused to cross.
 *
 * So this file adds no data and invents no layout. It renders, in three
 * dimensions, the exact same rows the 2D engine and the collision grid have
 * been reading all along — one `<PropMesh>` per entry, positioned from the
 * prop's own tile x/y/w/h.
 *
 * Built from primitives for the reason the rest of the scene is
 * (RoomMeshes.tsx's header): imported models would need re-authoring every
 * time a room's shape changes, and there is no asset pipeline here. What
 * makes a stack of boxes read as a desk rather than a box is proportion,
 * a material that responds to light, and — for anything with a screen — its
 * own emission, which is what the bloom pass then picks up.
 *
 * Geometries and materials are created ONCE at module scope and shared by
 * every instance. There are on the order of two hundred meshes here; giving
 * each its own material would mean two hundred shader programs compiled on
 * first paint, and the palette only changes when the theme does.
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { PROPS, ROOMS, type Prop } from '../game/world'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'

/** One tile is one world unit; these are heights in that same unit. */
const DESK_H = 0.62
const DESK_THICK = 0.08
const LEG = 0.07
const SHELF_H = 1.5
const CABINET_H = 0.8
const SOFA_H = 0.42
const MONITOR_W = 0.72
const MONITOR_H = 0.46

// Shared geometry. A unit box scaled per-instance beats one geometry per
// prop: the GPU uploads a single buffer and every desk reuses it.
const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12)
const SPHERE = new THREE.SphereGeometry(1, 10, 8)
const PLANE = new THREE.PlaneGeometry(1, 1)

function useMaterials(theme: OfficeTheme) {
  return useMemo(() => {
    const p = theme.prop
    return {
      surface: new THREE.MeshStandardMaterial({ color: p.surface, roughness: 0.55, metalness: 0.08 }),
      frame: new THREE.MeshStandardMaterial({ color: p.frame, roughness: 0.4, metalness: 0.55 }),
      fabric: new THREE.MeshStandardMaterial({ color: p.fabric, roughness: 0.92, metalness: 0 }),
      foliage: new THREE.MeshStandardMaterial({ color: p.foliage, roughness: 0.8, metalness: 0 }),
      pot: new THREE.MeshStandardMaterial({ color: p.frame, roughness: 0.7, metalness: 0.1 }),
      // Screens are the scene's only real light sources by area, and the
      // bloom pass exists mostly for them. `toneMapped: false` keeps a
      // screen reading as emitted light rather than as a lit surface.
      screen: new THREE.MeshBasicMaterial({ color: p.screen, toneMapped: false }),
      rug: new THREE.MeshStandardMaterial({
        color: p.fabric,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0.85,
      }),
    }
  }, [theme])
}

type Mats = ReturnType<typeof useMaterials>

/** A desk slab on four legs, with a monitor standing at the back edge.
 *  `world.ts` seats the agent one tile SOUTH of the desk, so the screen
 *  faces that way — the avatar looks at the display rather than its back. */
function Desk({ prop, mats, tall }: { prop: Prop; mats: Mats; tall: boolean }) {
  const w = prop.w
  const d = prop.h
  const h = tall ? DESK_H + 0.06 : DESK_H
  return (
    <group position={[prop.x + w / 2, 0, prop.y + d / 2]}>
      <mesh castShadow receiveShadow geometry={BOX} material={mats.surface} position={[0, h, 0]} scale={[w, DESK_THICK, d]} />
      {[
        [-w / 2 + 0.12, -d / 2 + 0.12],
        [w / 2 - 0.12, -d / 2 + 0.12],
        [-w / 2 + 0.12, d / 2 - 0.12],
        [w / 2 - 0.12, d / 2 - 0.12],
      ].map(([lx, lz], i) => (
        <mesh key={i} castShadow geometry={BOX} material={mats.frame} position={[lx, h / 2, lz]} scale={[LEG, h, LEG]} />
      ))}
      {/* Monitor: a thin bezel with an emissive face, on a short stalk. */}
      <mesh castShadow geometry={BOX} material={mats.frame} position={[0, h + 0.09, -d / 2 + 0.22]} scale={[0.1, 0.18, 0.08]} />
      <mesh
        castShadow
        geometry={BOX}
        material={mats.frame}
        position={[0, h + 0.18 + MONITOR_H / 2, -d / 2 + 0.22]}
        scale={[MONITOR_W, MONITOR_H, 0.05]}
      />
      <mesh
        geometry={PLANE}
        material={mats.screen}
        position={[0, h + 0.18 + MONITOR_H / 2, -d / 2 + 0.248]}
        scale={[MONITOR_W - 0.08, MONITOR_H - 0.07, 1]}
      />
    </group>
  )
}

/** Open shelving: a carcass, three slats, and a run of book blocks whose
 *  colours come from the prop's own tile position — deterministic, so a
 *  shelf looks the same on every render and every reload. */
function Shelf({ prop, mats }: { prop: Prop; mats: Mats }) {
  const books = useMemo(() => {
    const out: { x: number; y: number; h: number; c: string }[] = []
    let seed = prop.x * 73856093 ^ prop.y * 19349663
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let shelf = 0; shelf < 3; shelf += 1) {
      let cursor = -prop.w / 2 + 0.12
      while (cursor < prop.w / 2 - 0.2) {
        const bw = 0.05 + rand() * 0.06
        out.push({
          x: cursor + bw / 2,
          y: 0.28 + shelf * 0.42,
          h: 0.2 + rand() * 0.1,
          c: `hsl(${Math.floor(rand() * 360)}, 35%, ${45 + Math.floor(rand() * 20)}%)`,
        })
        cursor += bw + 0.015
      }
    }
    return out
  }, [prop])

  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={BOX} material={mats.frame} position={[0, SHELF_H / 2, 0]} scale={[prop.w, SHELF_H, prop.h * 0.5]} />
      {books.map((b, i) => (
        <mesh key={i} castShadow geometry={BOX} position={[b.x, b.y, prop.h * 0.16]} scale={[0.045, b.h, 0.16]}>
          <meshStandardMaterial color={b.c} roughness={0.85} />
        </mesh>
      ))}
    </group>
  )
}

function Plant({ prop, mats }: { prop: Prop; mats: Mats }) {
  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={CYL} material={mats.pot} position={[0, 0.14, 0]} scale={[0.19, 0.28, 0.19]} />
      <mesh castShadow geometry={SPHERE} material={mats.foliage} position={[0, 0.52, 0]} scale={[0.3, 0.34, 0.3]} />
      <mesh castShadow geometry={SPHERE} material={mats.foliage} position={[0.14, 0.72, -0.06]} scale={[0.18, 0.2, 0.18]} />
      <mesh castShadow geometry={SPHERE} material={mats.foliage} position={[-0.13, 0.68, 0.08]} scale={[0.15, 0.17, 0.15]} />
    </group>
  )
}

function Sofa({ prop, mats }: { prop: Prop; mats: Mats }) {
  const w = prop.w
  const d = Math.max(prop.h, 1) * 0.9
  return (
    <group position={[prop.x + w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={BOX} material={mats.fabric} position={[0, SOFA_H / 2, 0]} scale={[w, SOFA_H, d]} />
      <mesh castShadow geometry={BOX} material={mats.fabric} position={[0, SOFA_H + 0.18, -d / 2 + 0.1]} scale={[w, 0.36, 0.2]} />
      <mesh castShadow geometry={BOX} material={mats.fabric} position={[-w / 2 + 0.1, SOFA_H + 0.1, 0]} scale={[0.2, 0.2, d]} />
      <mesh castShadow geometry={BOX} material={mats.fabric} position={[w / 2 - 0.1, SOFA_H + 0.1, 0]} scale={[0.2, 0.2, d]} />
    </group>
  )
}

function Table({ prop, mats }: { prop: Prop; mats: Mats }) {
  const r = Math.min(prop.w, prop.h) / 2
  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={CYL} material={mats.surface} position={[0, DESK_H, 0]} scale={[r, DESK_THICK, r]} />
      <mesh castShadow geometry={CYL} material={mats.frame} position={[0, DESK_H / 2, 0]} scale={[0.09, DESK_H, 0.09]} />
      <mesh castShadow geometry={CYL} material={mats.frame} position={[0, 0.03, 0]} scale={[r * 0.55, 0.06, r * 0.55]} />
    </group>
  )
}

function Cabinet({ prop, mats }: { prop: Prop; mats: Mats }) {
  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={BOX} material={mats.frame} position={[0, CABINET_H / 2, 0]} scale={[prop.w, CABINET_H, prop.h * 0.6]} />
      {[0.24, 0.52].map((y, i) => (
        <mesh key={i} geometry={BOX} material={mats.surface} position={[0, y, prop.h * 0.31]} scale={[prop.w - 0.14, 0.02, 0.02]} />
      ))}
    </group>
  )
}

function Coffee({ prop, mats }: { prop: Prop; mats: Mats }) {
  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow receiveShadow geometry={BOX} material={mats.surface} position={[0, 0.45, 0]} scale={[prop.w, 0.9, prop.h * 0.7]} />
      <mesh castShadow geometry={BOX} material={mats.frame} position={[prop.w * 0.22, 1.06, 0]} scale={[0.34, 0.32, 0.3]} />
      <mesh geometry={PLANE} material={mats.screen} position={[prop.w * 0.22, 1.1, prop.h * 0.36]} scale={[0.16, 0.1, 1]} />
    </group>
  )
}

/** Wall-hung display: a whiteboard or a big screen. Both are a panel; only
 *  the material differs, and only the screen emits. */
function Panel({ prop, mats, lit }: { prop: Prop; mats: Mats; lit: boolean }) {
  return (
    <group position={[prop.x + prop.w / 2, 0, prop.y + prop.h / 2]}>
      <mesh castShadow geometry={BOX} material={mats.frame} position={[0, 1.1, 0]} scale={[prop.w, 0.9, 0.08]} />
      <mesh geometry={PLANE} material={lit ? mats.screen : mats.surface} position={[0, 1.1, 0.05]} scale={[prop.w - 0.12, 0.78, 1]} />
    </group>
  )
}

function PropMesh({ prop, mats }: { prop: Prop; mats: Mats }) {
  switch (prop.kind) {
    case 'desk':
      return <Desk prop={prop} mats={mats} tall={false} />
    case 'ceo-desk':
      return <Desk prop={prop} mats={mats} tall />
    case 'shelf':
      return <Shelf prop={prop} mats={mats} />
    case 'plant':
      return <Plant prop={prop} mats={mats} />
    case 'sofa':
      return <Sofa prop={prop} mats={mats} />
    case 'table':
      return <Table prop={prop} mats={mats} />
    case 'cabinet':
      return <Cabinet prop={prop} mats={mats} />
    case 'coffee':
      return <Coffee prop={prop} mats={mats} />
    case 'whiteboard':
      return <Panel prop={prop} mats={mats} lit={false} />
    case 'screen':
    case 'monitor':
      return <Panel prop={prop} mats={mats} lit />
    case 'rug':
      // Slightly proud of the floor so it wins the depth test without
      // z-fighting, and the one prop the collision grid lets agents cross.
      return (
        <mesh
          receiveShadow
          geometry={PLANE}
          material={mats.rug}
          position={[prop.x + prop.w / 2, 0.012, prop.y + prop.h / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[prop.w, prop.h, 1]}
        />
      )
    default:
      return null
  }
}

export function RoomProps() {
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  const mats = useMaterials(theme)
  return (
    <>
      {PROPS.map((prop, i) => (
        <PropMesh key={i} prop={prop} mats={mats} />
      ))}
      {/* One warm pool per room. A single global key light lights the whole
          deck evenly, which is exactly what makes a rendered office look like
          a diagram; a lamp hanging in each room is what says someone works
          there. Deliberately shadowless — eleven shadow-casting lights would
          cost eleven extra depth passes for a soft pool nobody reads as a
          hard shadow anyway. */}
      {ROOMS.map((room) => (
        <group key={room.id}>
          {/* Intensity is in candela and falls off with the square of the
              distance — three.js has been physically-correct by default
              since r155. A value tuned by eye against the old non-physical
              units comes out to almost nothing at ceiling height, which is
              why the rooms read as unlit floor plans however many lights
              were in them. `distance` bounds the falloff so one room's lamp
              does not wash out its neighbours. */}
          <pointLight
            position={[room.x + room.w / 2, 3.4, room.y + room.h / 2]}
            color={theme.roomLight.color}
            intensity={theme.roomLight.intensity}
            distance={Math.max(room.w, room.h) * 1.2}
            decay={2}
          />
          {/* And something to SEE as the source. A pool of light with no
              fixture reads as a rendering artifact; a bright panel where the
              light comes from reads as a ceiling. */}
          <mesh
            geometry={PLANE}
            material={mats.screen}
            position={[room.x + room.w / 2, 3.45, room.y + room.h / 2]}
            rotation={[Math.PI / 2, 0, 0]}
            scale={[room.w * 0.42, room.h * 0.09, 1]}
          />
        </group>
      ))}
    </>
  )
}
