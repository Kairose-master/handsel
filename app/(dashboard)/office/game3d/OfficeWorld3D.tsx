'use client'

/**
 * R3F/Three.js office diorama — the semi-3D renderer the redesign brief
 * asked for, replacing OfficeWorld.tsx's DOM/CSS isometric illusion with a
 * real (orthographic, fixed-angle) 3D scene. Deliberately NOT a rewrite of
 * the data layer: every real-data module underneath this is reused
 * unchanged —
 *
 *   ../game/world.ts        room/grid/prop layout (tile units)
 *   ../game/live-engine.ts  LiveOffice — real snapshot → agent positions,
 *                           A* pathfinding, the tick() loop that moves them
 *   ../game/zoom.ts         hotRoomOf / roomStatsOf / closeRoomIdFor
 *   ../game/select.ts       MIN_SELECT_BOX_PX, selectionSummary
 *   lib/office-artifact-flights.ts   real handoff/review/synthesis flights
 *
 * office/page.tsx's own LiveOffice instance and requestAnimationFrame
 * tick() loop are UNCHANGED — this component receives the exact same
 * `agents`/`flights` props `OfficeWorld` (the DOM renderer) did, and the
 * two are meant to be interchangeable at the call site.
 *
 * Same three-tier semantic zoom (far/medium/close — CameraRig.tsx) and the
 * same inspect-only posture as the DOM renderer: box-select and clicking
 * never issue a command, only report a pick.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import type { Agent } from '../game/live-engine'
import type { Room } from '../game/world'
import { MIN_SELECT_BOX_PX } from '../game/select'
import type { ArtifactFlight } from '@/lib/office-world-data'
import { CameraRig } from './CameraRig'
import { RoomMeshes } from './RoomMeshes'
import { AgentAvatars } from './AgentAvatars'
import { ArtifactFlights3D } from './ArtifactFlights3D'
import { useSceneStore } from './scene-store'

type Props = {
  agents: Agent[]
  selectedId: string | null
  selectedRoomId: string | null
  onSelect: (agent: Agent) => void
  onSelectRoom?: (room: Room) => void
  onSelectMany?: (ids: string[]) => void
  flights?: ArtifactFlight[]
}

type ScreenBox = { x0: number; y0: number; x1: number; y1: number }

/** Bridges the outer DOM-level box-select drag (tracked in plain React
 *  state, same as OfficeWorld.tsx's `selectBox`) to the real Three.js
 *  camera, which only exists inside <Canvas>. `Vector3.project(camera)`
 *  turns each agent's live world position into normalized device
 *  coordinates; scaling those into the canvas's own pixel size gives the
 *  exact screen point the drag rectangle needs to test against — the 3D
 *  analogue of select.ts's `screenToWorld` inversion, just going the other
 *  direction because a real camera makes world→screen the natural one. */
function SelectionBridge({ agents, exposeHitTest }: { agents: Agent[]; exposeHitTest: (fn: (box: ScreenBox) => string[]) => void }) {
  const { camera, size } = useThree()
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  useEffect(() => {
    const v = new THREE.Vector3()
    exposeHitTest((box: ScreenBox) => {
      const xmin = Math.min(box.x0, box.x1)
      const xmax = Math.max(box.x0, box.x1)
      const ymin = Math.min(box.y0, box.y1)
      const ymax = Math.max(box.y0, box.y1)
      const hits: string[] = []
      for (const a of agentsRef.current) {
        v.set(a.x + 0.5, 0.4, a.y + 0.5)
        v.project(camera)
        const sx = (v.x * 0.5 + 0.5) * size.width
        const sy = (-v.y * 0.5 + 0.5) * size.height
        if (sx >= xmin && sx <= xmax && sy >= ymin && sy <= ymax) hits.push(a.id)
      }
      return hits
    })
  }, [camera, size, exposeHitTest])

  return null
}

export default function OfficeWorld3D({ agents, selectedId, selectedRoomId, onSelect, onSelectRoom, onSelectMany, flights = [] }: Props) {
  const zoom = useSceneStore((s) => s.zoom)
  const setZoom = useSceneStore((s) => s.setZoom)
  const selectMode = useSceneStore((s) => s.selectMode)
  const setSelectMode = useSceneStore((s) => s.setSelectMode)

  const dragRef = useRef({ px: 0, py: 0, moved: false })
  const selectDragRef = useRef(false)
  const [selectBox, setSelectBox] = useState<ScreenBox | null>(null)
  const hitTestRef = useRef<(box: ScreenBox) => string[]>(() => [])
  const exposeHitTest = useCallback((fn: (box: ScreenBox) => string[]) => {
    hitTestRef.current = fn
  }, [])

  // Same "was this a drag or a click" guard OfficeWorld.tsx's onPick/
  // onPickRoom used — MapControls' own drag doesn't stop a mesh's
  // pointerup from also firing, so this component still has to tell the
  // two apart itself.
  const handlePick = useCallback(
    (agent: Agent) => {
      if (!dragRef.current.moved) {
        onSelect(agent)
        setZoom('close')
      }
    },
    [onSelect, setZoom],
  )
  const handlePickRoom = useCallback(
    (room: Room) => {
      if (!dragRef.current.moved && onSelectRoom) {
        onSelectRoom(room)
        setZoom('close')
      }
    },
    [onSelectRoom, setZoom],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.world-hud')) return
    if (selectMode) {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      selectDragRef.current = true
      setSelectBox({ x0: x, y0: y, x1: x, y1: y })
      return
    }
    dragRef.current = { px: e.clientX, py: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (selectMode) {
      if (!selectDragRef.current) return
      const rect = e.currentTarget.getBoundingClientRect()
      setSelectBox((box) => (box ? { ...box, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : box))
      return
    }
    const d = dragRef.current
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 4) d.moved = true
  }
  const onPointerUp = () => {
    if (selectMode) {
      if (selectDragRef.current && selectBox) {
        const w = Math.abs(selectBox.x1 - selectBox.x0)
        const h = Math.abs(selectBox.y1 - selectBox.y0)
        if (w >= MIN_SELECT_BOX_PX || h >= MIN_SELECT_BOX_PX) {
          onSelectMany?.(hitTestRef.current(selectBox))
        }
      }
      selectDragRef.current = false
      setSelectBox(null)
      return
    }
    window.setTimeout(() => {
      dragRef.current.moved = false
    }, 0)
  }

  return (
    <div className="world-frame">
      <div
        className={`world-viewport world3d-viewport ${selectMode ? 'select-mode' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <Canvas shadows dpr={[1, 1.8]} gl={{ antialias: true }}>
          <OrthographicCamera makeDefault near={0.1} far={2000} zoom={1} />
          <CameraRig agents={agents} selectedId={selectedId} selectedRoomId={selectedRoomId} />
          <ambientLight intensity={0.75} />
          <directionalLight position={[30, 60, 20]} intensity={0.9} castShadow shadow-mapSize={[1024, 1024]} />
          <color attach="background" args={['#23161f']} />
          <RoomMeshes agents={agents} onSelectRoom={handlePickRoom} />
          <AgentAvatars agents={agents} selectedId={selectedId} onSelect={handlePick} />
          <ArtifactFlights3D flights={flights} />
          <SelectionBridge agents={agents} exposeHitTest={exposeHitTest} />
        </Canvas>

        {selectBox && (
          <div
            className="select-box"
            style={{
              left: Math.min(selectBox.x0, selectBox.x1),
              top: Math.min(selectBox.y0, selectBox.y1),
              width: Math.abs(selectBox.x1 - selectBox.x0),
              height: Math.abs(selectBox.y1 - selectBox.y0),
            }}
          />
        )}

        <div className="world-hud">
          <button className={zoom === 'far' ? 'on' : ''} onClick={() => setZoom('far')}>
            🗺️ Far
          </button>
          <button className={zoom === 'medium' ? 'on' : ''} onClick={() => setZoom('medium')}>
            🏢 Rooms
          </button>
          <button className={zoom === 'close' ? 'on' : ''} onClick={() => setZoom('close')}>
            🔍 Close
          </button>
          {onSelectMany && (
            <button className={selectMode ? 'on' : ''} onClick={() => setSelectMode((v) => !v)}>
              🔲 Select
            </button>
          )}
        </div>
        <div className="world-hint">
          {selectMode ? 'Drag a box to select multiple agents' : 'Drag to look around · click an agent or room for details'}
        </div>
      </div>
    </div>
  )
}
