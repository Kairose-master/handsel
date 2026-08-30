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
import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Agent, Facing } from '../game/live-engine'
import { useSceneStore } from './scene-store'
import { THEMES, type OfficeTheme } from './theme'
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'
import { kitFor, visorEmissive, type AvatarKit } from '@/lib/office-avatar-kit'

const FACING_YAW: Record<Facing, number> = { down: 0, right: Math.PI / 2, up: Math.PI, left: -Math.PI / 2 }

/** Shortest-path angular damping — the same helper CameraRig uses, for the
 *  same reason: lerping raw radians takes the long way round the ±π seam,
 *  which here would spin an agent 270° to turn left. */
function dampAngle(current: number, target: number, k: number): number {
  let delta = (target - current) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * k
}

// Every room an Agent.deptId can actually hold: the nine real departments,
// plus 'ceo' and 'lounge' — world.ts's own two non-generated rooms. Not a
// guess: live-engine.ts's applySnapshot sets deptId to exactly one of these.
const DEPT_ICON: Record<string, string> = { ceo: '🏢', lounge: '☕' }
for (const d of OFFICE_DEPARTMENTS) DEPT_ICON[d.id] = d.icon

/**
 * One accessory, built from the same blocky primitives as the body.
 *
 * The generated character sheets tell ten figures apart by silhouette and a
 * single prop each, never by facial detail — because at this camera a face is
 * about four pixels. These are the shapes that survive that: a bump on the
 * head, a slab at the chest, a bag at the hip, a bar across the back. Nothing
 * that needs detail to be recognised, because detail at this size is noise.
 *
 * Which one an agent wears is decided by `lib/office-avatar-kit.ts` from its
 * live department, so the kit is a readout of what the agent is doing rather
 * than decoration.
 */
function Accessory({ kit, theme }: { kit: AvatarKit; theme: OfficeTheme }) {
  if (kit.kind === 'none') return null
  const tone =
    kit.tone === 'warn'
      ? theme.warn
      : kit.tone === 'danger'
        ? theme.danger
        : kit.tone === 'ok'
          ? theme.ok
          : kit.tone === 'accent'
            ? theme.accent
            : theme.prop.frame
  // Accessories take a little emission on the glowing theme so they read
  // against a dark torso, and none on the flat one, for the same reason the
  // visor does.
  const mat = (
    <meshStandardMaterial
      color={tone}
      emissive={tone}
      emissiveIntensity={theme.glow ? 0.45 : 0}
      roughness={0.5}
    />
  )
  switch (kit.kind) {
    case 'hardhat':
      return (
        <group position={[0, 0.94, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.32, 0.1, 0.3]} />
            {mat}
          </mesh>
          <mesh castShadow position={[0, -0.05, 0.02]}>
            <boxGeometry args={[0.36, 0.03, 0.36]} />
            {mat}
          </mesh>
        </group>
      )
    case 'clipboard':
      return (
        <mesh castShadow position={[0, 0.44, 0.19]} rotation={[-0.35, 0, 0]}>
          <boxGeometry args={[0.22, 0.28, 0.03]} />
          {mat}
        </mesh>
      )
    case 'satchel':
      return (
        <group>
          <mesh castShadow position={[0.2, 0.27, 0.05]}>
            <boxGeometry args={[0.16, 0.16, 0.1]} />
            {mat}
          </mesh>
          {/* The strap is what makes it read as carried rather than stuck on. */}
          <mesh castShadow position={[0.02, 0.48, 0.05]} rotation={[0, 0, -0.7]}>
            <boxGeometry args={[0.05, 0.4, 0.04]} />
            {mat}
          </mesh>
        </group>
      )
    case 'pauldron':
      return (
        <mesh castShadow position={[-0.26, 0.56, 0]}>
          <boxGeometry args={[0.16, 0.1, 0.24]} />
          {mat}
        </mesh>
      )
    case 'tube':
      return (
        <mesh castShadow position={[0, 0.44, -0.18]} rotation={[0, 0, 0.6]}>
          <cylinderGeometry args={[0.05, 0.05, 0.42, 8]} />
          {mat}
        </mesh>
      )
    case 'headset':
      return (
        <group position={[0, 0.86, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.32, 0.04, 0.06]} />
            {mat}
          </mesh>
          <mesh castShadow position={[0.16, -0.04, 0]}>
            <boxGeometry args={[0.06, 0.1, 0.1]} />
            {mat}
          </mesh>
        </group>
      )
    case 'square':
      return (
        <mesh castShadow position={[0.24, 0.36, 0.06]} rotation={[0, 0, -0.5]}>
          <boxGeometry args={[0.04, 0.3, 0.04]} />
          {mat}
        </mesh>
      )
    default:
      return null
  }
}

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
  const bodyRef = useRef<THREE.Group>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const armLRef = useRef<THREE.Group>(null)
  const armRRef = useRef<THREE.Group>(null)
  const legLRef = useRef<THREE.Group>(null)
  const legRRef = useRef<THREE.Group>(null)
  const walkRef = useRef(0)
  const typeRef = useRef(0)
  const [hovered, setHovered] = useState(false)
  /** Current emphasis, 0..1, chasing whether this agent is selected/hovered.
   *  A ref rather than state: it is read and written every frame, and putting
   *  it in React would re-render an avatar sixty times a second to move a
   *  number the GPU is the only consumer of. */
  const emphasis = useRef(0)

  useFrame((_, dt) => {
    const g = groupRef.current
    if (!g) return
    g.position.x = agent.x + 0.5
    g.position.z = agent.y + 0.5
    // Turning in place used to be a hard snap between four yaw values, which
    // at walking speed reads as the avatar teleporting between facings.
    g.rotation.y = dampAngle(g.rotation.y, FACING_YAW[agent.facing], Math.min(1, 1 - Math.pow(1 - 0.22, dt * 60)))
    // Limb poses. `walk` used to be the whole body bobbing and `type` was
    // indistinguishable from `idle`, because there was nothing to move — the
    // avatar was three stacked boxes. The engine has always published a real
    // `anim` per agent; this is the first renderer that spends it.
    const armL = armLRef.current
    const armR = armRRef.current
    const legL = legLRef.current
    const legR = legRRef.current

    if (agent.anim === 'walk') {
      walkRef.current += dt * 10
      g.position.y = Math.abs(Math.sin(walkRef.current)) * 0.08
      const swing = Math.sin(walkRef.current) * 0.7
      if (armL) armL.rotation.x = swing
      if (armR) armR.rotation.x = -swing
      if (legL) legL.rotation.x = -swing * 0.8
      if (legR) legR.rotation.x = swing * 0.8
    } else {
      walkRef.current = 0
      g.position.y += (0 - g.position.y) * Math.min(1, 1 - Math.pow(1 - 0.2, dt * 60))
      if (agent.anim === 'type') {
        // Forearms forward and alternating — read as "at a keyboard" rather
        // than "standing very still", which is what the desks needed.
        typeRef.current += dt * 9
        const tap = Math.sin(typeRef.current) * 0.12
        if (armL) armL.rotation.x = -1.15 + tap
        if (armR) armR.rotation.x = -1.15 - tap
      } else {
        typeRef.current = 0
        const settle = Math.min(1, 1 - Math.pow(1 - 0.15, dt * 60))
        if (armL) armL.rotation.x += (0 - armL.rotation.x) * settle
        if (armR) armR.rotation.x += (0 - armR.rotation.x) * settle
      }
      // Sitting bends the legs forward and drops the whole figure; standing
      // eases both back rather than snapping, so a stand-up is a movement.
      const seated = agent.anim === 'sit' || agent.anim === 'type'
      const settle = Math.min(1, 1 - Math.pow(1 - 0.15, dt * 60))
      const legTarget = seated ? -1.35 : 0
      if (legL) legL.rotation.x += (legTarget - legL.rotation.x) * settle
      if (legR) legR.rotation.x += (legTarget - legR.rotation.x) * settle
    }

    // Selection and hover are the same continuous quantity, so one damped
    // value drives both — no competing animations when you hover the agent
    // that is already selected.
    const want = selected ? 1 : hovered ? 0.45 : 0
    emphasis.current += (want - emphasis.current) * Math.min(1, 1 - Math.pow(1 - 0.18, dt * 60))
    const e = emphasis.current

    const b = bodyRef.current
    if (b) {
      const lift = 1 + e * 0.12
      b.scale.setScalar(lift)
    }
    const r = ringRef.current
    if (r) {
      r.visible = e > 0.01
      // Scale and fade together, plus a slow breath so a held selection
      // stays alive instead of reading as a static decal on the floor.
      const breath = 1 + Math.sin(performance.now() / 420) * 0.06 * e
      r.scale.setScalar((0.6 + e * 0.4) * breath)
      const mat = r.material as THREE.MeshBasicMaterial
      mat.opacity = e
    }
  })

  return (
    <group
      ref={groupRef}
      onPointerUp={(e) => {
        e.stopPropagation()
        onPick(agent)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ''
      }}
    >
      {/* Always mounted, never conditionally rendered: a ring that only
          exists while `selected` cannot animate in or out, it can only
          appear and vanish. Visibility and opacity are driven per-frame
          above instead. */}
      <mesh ref={ringRef} visible={false} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.46, 32]} />
        <meshBasicMaterial color={theme.accent} toneMapped={false} transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={bodyRef}>
      {far ? (
        // Far zoom: identity is unreadable at this distance anyway (the
        // DOM renderer's `.far` class makes the exact same call for name
        // tags) — one cheap primitive reads as "someone is here", nothing
        // more, instead of the four the close-up avatar costs.
        //
        // It used to be a flat 0.24-radius circle in an unlit material,
        // which at the framing this scene actually uses came out about six
        // pixels wide and took no light at all: nineteen agents rendered,
        // and the deck read as abandoned. A standing capsule of roughly a
        // person's footprint catches the key light, drops a shadow like
        // everything else on the floor, and is still one draw call.
        <mesh castShadow position={[0, 0.42, 0]}>
          <capsuleGeometry args={[0.3, 0.42, 4, 10]} />
          <meshStandardMaterial
            color={agent.shirt}
            emissive={agent.shirt}
            emissiveIntensity={theme.glow ? 0.5 : 0.12}
            roughness={0.45}
          />
        </mesh>
      ) : (
        <>
          {/* Torso, tapered: shoulders wider than the hips. Three equal-width
              boxes stacked read as a stack of boxes at any distance; a
              silhouette that changes width is what the eye resolves as a
              body, and it costs the same draw call. */}
          <mesh castShadow receiveShadow position={[0, 0.46, 0]}>
            <boxGeometry args={[0.44, 0.26, 0.26]} />
            <meshStandardMaterial color={agent.shirt} emissive={agent.shirt} emissiveIntensity={theme.glow ? 0.35 : 0} roughness={0.5} />
          </mesh>
          <mesh castShadow receiveShadow position={[0, 0.26, 0]}>
            <boxGeometry args={[0.32, 0.22, 0.22]} />
            <meshStandardMaterial color={agent.shirt} emissive={agent.shirt} emissiveIntensity={theme.glow ? 0.28 : 0} roughness={0.55} />
          </mesh>
          {/* Arms and legs. They are what carry the animation: without limbs
              `walk` was a whole body bobbing up and down, and `type` looked
              exactly like `idle`. Refs are animated in useFrame above. */}
          <group ref={armLRef} position={[-0.27, 0.5, 0]}>
            <mesh castShadow position={[0, -0.11, 0]}>
              <boxGeometry args={[0.1, 0.26, 0.13]} />
              <meshStandardMaterial color={agent.shirt} roughness={0.6} />
            </mesh>
          </group>
          <group ref={armRRef} position={[0.27, 0.5, 0]}>
            <mesh castShadow position={[0, -0.11, 0]}>
              <boxGeometry args={[0.1, 0.26, 0.13]} />
              <meshStandardMaterial color={agent.shirt} roughness={0.6} />
            </mesh>
          </group>
          <group ref={legLRef} position={[-0.09, 0.16, 0]}>
            <mesh castShadow position={[0, -0.08, 0]}>
              <boxGeometry args={[0.12, 0.18, 0.14]} />
              <meshStandardMaterial color={agent.hair} roughness={0.75} />
            </mesh>
          </group>
          <group ref={legRRef} position={[0.09, 0.16, 0]}>
            <mesh castShadow position={[0, -0.08, 0]}>
              <boxGeometry args={[0.12, 0.18, 0.14]} />
              <meshStandardMaterial color={agent.hair} roughness={0.75} />
            </mesh>
          </group>
          {/* Neck gap: the head used to sit flush on a same-width torso, so
              the two merged into one block from most angles. */}
          <mesh castShadow position={[0, 0.63, 0]}>
            <boxGeometry args={[0.12, 0.06, 0.12]} />
            <meshStandardMaterial color={agent.skin} roughness={0.8} />
          </mesh>
          <mesh castShadow position={[0, 0.78, 0]}>
            <boxGeometry args={[0.28, 0.26, 0.26]} />
            <meshStandardMaterial color={agent.skin} roughness={0.7} />
          </mesh>
          <mesh castShadow position={[0, 0.93, -0.04]}>
            <boxGeometry args={[0.3, 0.12, 0.2]} />
            <meshStandardMaterial color={agent.hair} roughness={0.7} />
          </mesh>
          {/* The visor. The sheets' single strongest identity cue, and it
              replaces a face this geometry never had — two boxes for a head
              read as a crate until something crosses them horizontally. Sits
              slightly proud of the head so it is never z-fighting with it. */}
          <mesh position={[0, 0.80, 0.135]}>
            <boxGeometry args={[0.24, 0.075, 0.02]} />
            <meshStandardMaterial
              color={theme.accent}
              emissive={theme.accent}
              emissiveIntensity={visorEmissive(theme.glow, selected)}
              toneMapped={!theme.glow}
              roughness={0.3}
            />
          </mesh>
          {/* What this agent is doing, worn. lib/office-avatar-kit.ts */}
          <Accessory kit={kitFor(agent.deptId)} theme={theme} />
          {agent.rank === 'lead' && (
            <mesh position={[0, 1.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.12, 0.16, 4]} />
              <meshStandardMaterial color={theme.accent} emissive={theme.accent} emissiveIntensity={theme.glow ? 0.8 : 0} toneMapped={false} />
            </mesh>
          )}
        </>
      )}
      </group>
      {/* The label is anchored by its BOTTOM edge, not its centre. With
          `center` the stack is centred on the anchor point, so it grows
          downward into the avatar it describes — and because Html is
          screen-space while the world zooms, at CLOSE the label came out
          several times the size of the agent and buried it completely.
          Dropping `center` and translating the stack (office.css's
          .ag3d-stack) to sit fully above the point means a two-line bubble
          grows upward, away from the body, whatever its height. */}
      {!far && (
        <Html position={[0, 1.2, 0]} occlude={false}>
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
