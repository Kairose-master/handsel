'use client'

/**
 * 3D rendering of lib/office-artifact-flights.ts's real, currently-live
 * handoffs — see that file's header for what "real" requires before a
 * flight exists at all (this component draws whatever list it's handed,
 * it never decides what counts as a flight).
 *
 * Since the flights carry their real worker agent ids, the flight is drawn
 * between the two AGENTS' live positions — the endpoints follow the
 * walking sprites frame by frame, so a handoff reads as "Ada is sending
 * this to Grace", not as room decor. The dot travels a parabolic arc
 * (clearing head height) with the same ease/fade envelope the original
 * CSS keyframe used. When an endpoint agent isn't in the current roster
 * frame (it left between polls), that endpoint falls back to the room
 * center — degraded, never wrong.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ArtifactFlight } from '@/lib/office-world-data'
import type { Agent } from '../game/live-engine'
import { focusTileFor } from './CameraRig'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'

const FLIGHT_ICON: Record<ArtifactFlight['kind'], string> = { handoff: '📦', review: '🧾', synthesis: '🧩' }
function flightColor(theme: OfficeTheme, kind: ArtifactFlight['kind']): string {
  return kind === 'handoff' ? theme.accent : kind === 'review' ? theme.warn : theme.ok
}
const FLIGHT_DURATION_S = 2.8
const ENDPOINT_HEIGHT = 0.9 // hand height on an avatar
const ARC_EXTRA_HEIGHT = 1.6 // how far above the endpoints the arc peaks

function FlightMesh({ flight, agents, theme }: { flight: ArtifactFlight; agents: Agent[]; theme: OfficeTheme }) {
  // The Agent objects are mutated in place by LiveOffice.tick() — holding
  // the references lets every frame read fresh positions with no lookups.
  const fromAgent = useMemo(() => agents.find((a) => a.id === flight.fromAgentId) ?? null, [agents, flight.fromAgentId])
  const toAgent = useMemo(() => agents.find((a) => a.id === flight.toAgentId) ?? null, [agents, flight.toAgentId])
  const fromRoom = useMemo(() => focusTileFor(flight.fromDeptId), [flight.fromDeptId])
  const toRoom = useMemo(() => focusTileFor(flight.toDeptId), [flight.toDeptId])

  const groupRef = useRef<THREE.Group>(null)
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  const elapsed = useRef(Math.random() * FLIGHT_DURATION_S) // desynchronize multiple flights
  const a = useRef(new THREE.Vector3())
  const b = useRef(new THREE.Vector3())

  useFrame((_, dt) => {
    // Live endpoints: the agent's current tile, or its room center as the
    // degraded fallback when it dropped off the roster mid-poll.
    if (fromAgent) a.current.set(fromAgent.x + 0.5, ENDPOINT_HEIGHT, fromAgent.y + 0.5)
    else a.current.set(fromRoom.x, ENDPOINT_HEIGHT, fromRoom.z)
    if (toAgent) b.current.set(toAgent.x + 0.5, ENDPOINT_HEIGHT, toAgent.y + 0.5)
    else b.current.set(toRoom.x, ENDPOINT_HEIGHT, toRoom.z)

    // Keep the dashed guide line pinned to the moving endpoints.
    lineRef.current?.geometry.setPositions([a.current.x, a.current.y, a.current.z, b.current.x, b.current.y, b.current.z])

    elapsed.current = (elapsed.current + dt) % FLIGHT_DURATION_S
    const t = elapsed.current / FLIGHT_DURATION_S
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const g = groupRef.current
    if (g) {
      g.position.lerpVectors(a.current, b.current, eased)
      // Parabolic arc over the walk path — peaks mid-flight.
      g.position.y += Math.sin(eased * Math.PI) * ARC_EXTRA_HEIGHT
      const fade = t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 1
      g.visible = fade > 0.02
      g.scale.setScalar(0.85 + fade * 0.15)
    }
  })

  return (
    <>
      <Line
        ref={lineRef}
        points={[
          [0, ENDPOINT_HEIGHT, 0],
          [0, ENDPOINT_HEIGHT, 1],
        ]}
        color={flightColor(theme, flight.kind)}
        dashed
        dashSize={0.4}
        gapSize={0.3}
        lineWidth={1.5}
        transparent
        opacity={0.6}
        toneMapped={false}
      />
      <group ref={groupRef}>
        <Html center occlude={false}>
          <div className="flight3d-icon" title={flight.label}>
            {FLIGHT_ICON[flight.kind]}
          </div>
        </Html>
      </group>
    </>
  )
}

export function ArtifactFlights3D({ flights, agents }: { flights: ArtifactFlight[]; agents: Agent[] }) {
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  return (
    <>
      {flights.map((f) => (
        <FlightMesh key={f.id} flight={f} agents={agents} theme={theme} />
      ))}
    </>
  )
}
