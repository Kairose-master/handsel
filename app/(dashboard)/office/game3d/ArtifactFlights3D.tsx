'use client'

/**
 * 3D rendering of lib/office-artifact-flights.ts's real, currently-live
 * handoffs — see that file's header for what "real" requires before a
 * flight exists at all (this component draws whatever list it's handed,
 * it never decides what counts as a flight). A dashed line between the two
 * rooms' centers marks the connection exists at all; a small icon looping
 * along it is what actually reads as "something is moving" from across the
 * diorama — the exact two-part treatment OfficeWorld.tsx's CSS version
 * used (`.artifact-line` + `.artifact-dot`), ported to three.js primitives.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ArtifactFlight } from '@/lib/office-world-data'
import { focusTileFor } from './CameraRig'

const FLIGHT_ICON: Record<ArtifactFlight['kind'], string> = { handoff: '📦', review: '🧾', synthesis: '🧩' }
const FLIGHT_COLOR: Record<ArtifactFlight['kind'], string> = { handoff: '#c9b8ff', review: '#ff5fa8', synthesis: '#b8f0dd' }
const FLIGHT_DURATION_S = 2.4
const FLIGHT_HEIGHT = 1.1 // above the floor, clear of agent avatars

function FlightMesh({ flight }: { flight: ArtifactFlight }) {
  const from = useMemo(() => focusTileFor(flight.fromDeptId), [flight.fromDeptId])
  const to = useMemo(() => focusTileFor(flight.toDeptId), [flight.toDeptId])
  const a = useMemo(() => new THREE.Vector3(from.x, FLIGHT_HEIGHT, from.z), [from])
  const b = useMemo(() => new THREE.Vector3(to.x, FLIGHT_HEIGHT, to.z), [to])
  const groupRef = useRef<THREE.Group>(null)
  const elapsed = useRef(Math.random() * FLIGHT_DURATION_S) // desynchronize multiple flights' pulses

  useFrame((_, dt) => {
    elapsed.current = (elapsed.current + dt) % FLIGHT_DURATION_S
    const t = elapsed.current / FLIGHT_DURATION_S
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // ease-in-out, matches the CSS keyframe's feel
    const g = groupRef.current
    if (g) {
      g.position.lerpVectors(a, b, eased)
      // Fade in/out at the ends, same 12%/88% envelope the CSS keyframe used.
      const fade = t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 1
      g.visible = fade > 0.02
      g.scale.setScalar(0.85 + fade * 0.15)
    }
  })

  return (
    <>
      <Line points={[a, b]} color={FLIGHT_COLOR[flight.kind]} dashed dashSize={0.4} gapSize={0.3} lineWidth={1.5} transparent opacity={0.55} />
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

export function ArtifactFlights3D({ flights }: { flights: ArtifactFlight[] }) {
  return (
    <>
      {flights.map((f) => (
        <FlightMesh key={f.id} flight={f} />
      ))}
    </>
  )
}
