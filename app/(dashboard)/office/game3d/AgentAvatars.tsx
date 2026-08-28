'use client'

/**
 * Voxel-ish agent avatars — a box body, a box head, a hair block, built
 * from primitives (no imported rig, no Mixamo humanoid) because these
 * agents don't need to look human, they need to look like WHAT they are:
 * a small colored block with the agent's real hire-time palette
 * (`colorsFor`, shared with the DOM renderer so the same agent is the same
 * colors in both).
 *
 * Positions are NOT React state. `LiveOffice.tick()` (unchanged, still
 * running in office/page.tsx's own requestAnimationFrame loop) mutates each
 * `Agent` object's `x`/`y`/`facing`/`anim` IN PLACE every frame — it never
 * replaces the objects, only the array that holds them. So the same
 * `agent` reference captured in this component's `.map()` (from the
 * `agents` prop, which only changes once per snapshot poll) keeps updating
 * underneath it. Each `AgentMesh`'s own `useFrame` reads straight from that
 * closed-over object every frame and writes to its mesh group's
 * `.position`/`.rotation` imperatively — the same "skip React for the 60fps
 * path" rule OfficeWorld.tsx's DOM paint loop followed, just against a
 * mesh transform instead of a CSS one.
 *
 * The reactive `agents` prop itself (updates once per snapshot poll) drives
 * what a plain React re-render SHOULD drive: which avatars exist at all,
 * and what their name-tag text currently says.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Agent, Facing } from '../game/live-engine'
import { useSceneStore } from './scene-store'

const FACING_YAW: Record<Facing, number> = { down: 0, right: Math.PI / 2, up: Math.PI, left: -Math.PI / 2 }

function AgentMesh({
  agent,
  selected,
  far,
  onPick,
}: {
  agent: Agent
  selected: boolean
  far: boolean
  onPick: (agent: Agent) => void
}) {
  const groupRef = useRef<THREE.Group>(null)
  const walkRef = useRef(0)

  useFrame((_, dt) => {
    const g = groupRef.current
    if (!g) return
    g.position.x = agent.x + 0.5
    g.position.z = agent.y + 0.5
    g.rotation.y = FACING_YAW[agent.facing]
    if (agent.anim === 'walk') {
      walkRef.current += dt * 10
      g.position.y = Math.abs(Math.sin(walkRef.current)) * 0.08
    } else {
      walkRef.current = 0
      g.position.y = 0
    }
  })

  return (
    <group
      ref={groupRef}
      onPointerUp={(e) => {
        e.stopPropagation()
        onPick(agent)
      }}
    >
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.32, 0.42, 24]} />
          <meshBasicMaterial color="#ff5fa8" />
        </mesh>
      )}
      {far ? (
        // Far zoom: identity is unreadable at this distance anyway (the
        // DOM renderer's `.far` class makes the exact same call for name
        // tags) — a flat colored disc reads as "someone is here", nothing
        // more, and costs one draw call instead of four.
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]}>
          <circleGeometry args={[0.24, 12]} />
          <meshBasicMaterial color={agent.shirt} />
        </mesh>
      ) : (
        <>
          <mesh position={[0, 0.34, 0]}>
            <boxGeometry args={[0.46, 0.5, 0.28]} />
            <meshStandardMaterial color={agent.shirt} />
          </mesh>
          <mesh position={[0, 0.68, 0]}>
            <boxGeometry args={[0.32, 0.3, 0.3]} />
            <meshStandardMaterial color={agent.skin} />
          </mesh>
          <mesh position={[0, 0.85, -0.06]}>
            <boxGeometry args={[0.34, 0.14, 0.2]} />
            <meshStandardMaterial color={agent.hair} />
          </mesh>
          {agent.rank === 'lead' && (
            <mesh position={[0, 1.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.12, 0.16, 4]} />
              <meshStandardMaterial color="#ffd83d" />
            </mesh>
          )}
        </>
      )}
      {!far && (
        <Html position={[0, 1.05, 0]} center occlude={false}>
          <div className={`ag3d-tag${selected ? ' selected' : ''}`}>
            {agent.name}
            {agent.anim === 'type' && <em>typing…</em>}
          </div>
        </Html>
      )}
    </group>
  )
}

export function AgentAvatars({
  agents,
  selectedId,
  onSelect,
}: {
  agents: Agent[]
  selectedId: string | null
  onSelect: (agent: Agent) => void
}) {
  const zoomFar = useSceneStore((s) => s.zoom === 'far')
  return (
    <>
      {agents.map((agent) => (
        <AgentMesh key={agent.id} agent={agent} selected={agent.id === selectedId} far={zoomFar} onPick={onSelect} />
      ))}
    </>
  )
}
