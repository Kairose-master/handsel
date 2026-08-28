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
 * and what their name-tag/thought-bubble text currently says.
 *
 * The thought bubble reuses `agent.speech` — `live-engine.ts`'s
 * `applySnapshot` already sets this to the agent's REAL `statusLine`
 * (`office-functional-departments.ts`'s own derived sentence, e.g.
 * "Building — Accepted on job #12.") for every agent, every poll; the DOM
 * renderer has always shown it as `.ag-bubble`, this is the same real text
 * in the 3D scene. The icon next to it is the agent's CURRENT department's
 * real icon (`FUNCTIONAL_DEPARTMENTS`) — what kind of work the bubble is
 * describing, not a decorative "idea lightbulb" invented for the occasion.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Agent, Facing } from '../game/live-engine'
import { useSceneStore } from './scene-store'
import { THEMES, type OfficeTheme } from './theme'
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'

const FACING_YAW: Record<Facing, number> = { down: 0, right: Math.PI / 2, up: Math.PI, left: -Math.PI / 2 }

// Every room an Agent.deptId can actually hold: the nine real departments,
// plus 'ceo' and 'lounge' — world.ts's own two non-generated rooms. Not a
// guess: live-engine.ts's applySnapshot sets deptId to exactly one of these.
const DEPT_ICON: Record<string, string> = { ceo: '🏢', lounge: '☕' }
for (const d of OFFICE_DEPARTMENTS) DEPT_ICON[d.id] = d.icon

function AgentMesh({
  agent,
  selected,
  far,
  theme,
  onPick,
}: {
  agent: Agent
  selected: boolean
  far: boolean
  theme: OfficeTheme
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
          <meshBasicMaterial color={theme.accent} toneMapped={false} />
        </mesh>
      )}
      {far ? (
        // Far zoom: identity is unreadable at this distance anyway (the
        // DOM renderer's `.far` class makes the exact same call for name
        // tags) — a flat colored disc reads as "someone is here", nothing
        // more, and costs one draw call instead of four.
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]}>
          <circleGeometry args={[0.24, 12]} />
          <meshBasicMaterial color={agent.shirt} toneMapped={false} />
        </mesh>
      ) : (
        <>
          <mesh position={[0, 0.34, 0]}>
            <boxGeometry args={[0.46, 0.5, 0.28]} />
            <meshStandardMaterial color={agent.shirt} emissive={agent.shirt} emissiveIntensity={theme.glow ? 0.35 : 0} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.68, 0]}>
            <boxGeometry args={[0.32, 0.3, 0.3]} />
            <meshStandardMaterial color={agent.skin} roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.85, -0.06]}>
            <boxGeometry args={[0.34, 0.14, 0.2]} />
            <meshStandardMaterial color={agent.hair} roughness={0.7} />
          </mesh>
          {agent.rank === 'lead' && (
            <mesh position={[0, 1.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.12, 0.16, 4]} />
              <meshStandardMaterial color={theme.accent} emissive={theme.accent} emissiveIntensity={theme.glow ? 0.8 : 0} toneMapped={false} />
            </mesh>
          )}
        </>
      )}
      {!far && (
        <Html position={[0, 1.12, 0]} center occlude={false}>
          <div className="ag3d-stack">
            {agent.speech && (
              // key={agent.speech} forces a remount (not a diff-and-patch)
              // whenever the real status text changes, which is what
              // restarts the CSS pop-in animation — a genuinely NEW thing
              // to say gets a fresh bubble, not a silently updated one.
              <div key={agent.speech} className="ag3d-bubble">
                <span className="ag3d-bubble-icon">{DEPT_ICON[agent.deptId] ?? '💭'}</span>
                <span className="ag3d-bubble-text">{agent.speech}</span>
              </div>
            )}
            <div className={`ag3d-tag${selected ? ' selected' : ''}`}>
              {agent.name}
              {agent.anim === 'type' && <em>typing…</em>}
            </div>
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
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  return (
    <>
      {agents.map((agent) => (
        <AgentMesh key={agent.id} agent={agent} selected={agent.id === selectedId} far={zoomFar} theme={theme} onPick={onSelect} />
      ))}
    </>
  )
}
