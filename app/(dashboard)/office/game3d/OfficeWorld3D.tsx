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
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import { EffectComposer, Bloom, SMAA, ToneMapping, Vignette, SSAO } from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'
import type { Agent } from '../game/live-engine'
import { COLS, ROWS, type Room } from '../game/world'
import { MIN_SELECT_BOX_PX } from '../game/select'
import type { ArtifactFlight, AgentConversation } from '@/lib/office-world-data'
import { CameraRig } from './CameraRig'
import { RoomMeshes } from './RoomMeshes'
import { AgentAvatars } from './AgentAvatars'
import { ArtifactFlights3D } from './ArtifactFlights3D'
import { AgentConversations3D } from './AgentConversations3D'
import { TopStatusBar, BottomTelemetryBar } from './HUDBars'
import { useSceneStore } from './scene-store'
import { THEMES, THEME_ORDER, type OfficeTheme } from './theme'

type Props = {
  agents: Agent[]
  selectedId: string | null
  selectedRoomId: string | null
  onSelect: (agent: Agent) => void
  onSelectRoom?: (room: Room) => void
  onSelectMany?: (ids: string[]) => void
  flights?: ArtifactFlight[]
  /** Recent agent-to-agent negotiation messages (lib/office-conversations.ts)
   *  — animated as chat pings between the two agents' live positions. */
  conversations?: AgentConversation[]
  /** Real signal, not decoration: whether the last snapshot poll (the same
   *  one office/page.tsx already does) actually succeeded. Drives the top
   *  bar's status dot — "OPERATIONAL" is a claim about live data flowing,
   *  never a static badge. Defaults true so a caller that hasn't wired the
   *  poll's success/failure through yet doesn't show a false alarm. */
  healthy?: boolean
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

/** Half-extent of the key light's shadow box, sized from the actual office
 *  rather than a number that happens to look right, so a change to COLS/ROWS
 *  resizes it. The diagonal is what has to fit at an isometric angle, not the
 *  width. */
const SHADOW_SPAN = Math.ceil(Math.hypot(COLS, ROWS) / 2) + 6
/** How far the camera-space lights sit from the point being looked at. Only
 *  the DIRECTION matters for a directional light; this just has to clear the
 *  scene so nothing falls behind the shadow camera's near plane. */
const LIGHT_DISTANCE = 160
const FWD = new THREE.Vector3()
const RIGHT = new THREE.Vector3()
const UP = new THREE.Vector3()

/**
 * Key + rim light, both carried IN CAMERA SPACE.
 *
 * They used to sit at fixed world positions, which was fine while the camera
 * only ever looked from one corner. Once the deck can be turned, a fixed sun
 * means two of the four corners are lit from behind: same geometry, same
 * materials, and the avatars read as dark silhouettes purely because of where
 * north happens to be. Anchoring the lights to the camera's own right/up axes
 * keeps the light coming from over the viewer's shoulder at every corner, so
 * a turn changes what you can SEE and never how well lit it is.
 *
 * The shadow camera is also bounded to the world box here. A directional
 * light's default frustum is enormous, so the shadow map's texels were spread
 * across mostly empty space and the office itself got a handful of them —
 * same map size, an order of magnitude more resolution where things stand.
 */
function SunRig({ theme }: { theme: OfficeTheme }) {
  const key = useRef<THREE.DirectionalLight>(null)
  const rim = useRef<THREE.DirectionalLight>(null)
  const target = useRef<THREE.Object3D>(null)

  useFrame(({ camera }) => {
    const t = target.current
    if (!t) return
    // Where the camera is actually looking: its own forward, one iso
    // distance out. Cheaper and more stable than re-deriving the rig's
    // look-at point, and it is the same point by construction.
    FWD.setFromMatrixColumn(camera.matrixWorld, 2).multiplyScalar(-1)
    t.position.copy(camera.position).addScaledVector(FWD, LIGHT_DISTANCE)
    t.updateMatrixWorld()

    RIGHT.setFromMatrixColumn(camera.matrixWorld, 0)
    UP.setFromMatrixColumn(camera.matrixWorld, 1)

    const k = key.current
    if (k) {
      k.position
        .copy(t.position)
        .addScaledVector(RIGHT, LIGHT_DISTANCE * 0.45)
        .addScaledVector(UP, LIGHT_DISTANCE * 0.8)
      k.updateMatrixWorld()
    }
    const r = rim.current
    if (r) {
      r.position
        .copy(t.position)
        .addScaledVector(RIGHT, -LIGHT_DISTANCE * 0.7)
        .addScaledVector(UP, LIGHT_DISTANCE * 0.25)
      r.updateMatrixWorld()
    }
  })

  return (
    <>
      <object3D ref={target} />
      <directionalLight
        ref={key}
        target={target.current ?? undefined}
        intensity={theme.directional.intensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0008}
        shadow-normalBias={0.035}
        color={theme.directional.color}
      >
        <orthographicCamera
          attach="shadow-camera"
          args={[-SHADOW_SPAN, SHADOW_SPAN, SHADOW_SPAN, -SHADOW_SPAN, 1, 600]}
        />
      </directionalLight>
      {/* A cool counter-light from the other side. One light makes every box
          read as the same flat silhouette; this is what separates a wall from
          its floor and puts an edge on an avatar. */}
      <directionalLight
        ref={rim}
        target={target.current ?? undefined}
        intensity={theme.directional.intensity * 0.5}
        color={theme.accent}
      />
    </>
  )
}

export default function OfficeWorld3D({
  agents,
  selectedId,
  selectedRoomId,
  onSelect,
  onSelectRoom,
  onSelectMany,
  flights = [],
  conversations = [],
  healthy = true,
}: Props) {
  const zoom = useSceneStore((s) => s.zoom)
  const setZoom = useSceneStore((s) => s.setZoom)
  const selectMode = useSceneStore((s) => s.selectMode)
  const setSelectMode = useSceneStore((s) => s.setSelectMode)
  const themeId = useSceneStore((s) => s.themeId)
  const setThemeId = useSceneStore((s) => s.setThemeId)
  const rotate = useSceneStore((s) => s.rotate)
  const theme = THEMES[themeId]

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

  // Keyboard turning. Ignored while the user is typing somewhere — an
  // office page has real text inputs on it, and stealing "e" from a name
  // field to spin the camera is the kind of shortcut people file bugs about.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return
      if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') {
        rotate(-1)
      } else if (e.key === 'e' || e.key === 'E' || e.key === 'ArrowRight') {
        rotate(1)
      } else {
        return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rotate])

  const cycleTheme = () => {
    const i = THEME_ORDER.indexOf(themeId)
    setThemeId(THEME_ORDER[(i + 1) % THEME_ORDER.length])
  }

  return (
    <div className="world-frame world3d-frame" data-theme={themeId}>
      <TopStatusBar healthy={healthy} theme={theme} />
      <div
        className={`world-viewport world3d-viewport ${selectMode ? 'select-mode' : ''}`}
        data-theme={themeId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <Canvas
          shadows="soft"
          dpr={[1, 2]}
          gl={{ antialias: false }}
          camera={{ position: [0, 0, 0] }}
        >
          <OrthographicCamera makeDefault near={0.1} far={2000} zoom={1} />
          <CameraRig agents={agents} selectedId={selectedId} selectedRoomId={selectedRoomId} />
          <ambientLight intensity={theme.ambient.intensity} color={theme.ambient.color} />
          <SunRig theme={theme} />
          <hemisphereLight args={[theme.accentDim, theme.wall, theme.glow ? 0.4 : 0.6]} />
          <color attach="background" args={[theme.bg]} />
          {theme.fog && <fog attach="fog" args={[theme.bg, theme.fog[0], theme.fog[1]]} />}
          <RoomMeshes agents={agents} onSelectRoom={handlePickRoom} />
          <AgentAvatars agents={agents} selectedId={selectedId} onSelect={handlePick} />
          <ArtifactFlights3D flights={flights} agents={agents} />
          <AgentConversations3D conversations={conversations} agents={agents} />
          <SelectionBridge agents={agents} exposeHitTest={exposeHitTest} />
          {/* One composer for both themes. It used to run only when
              `theme.glow` was set, so the pastel diorama got no antialiasing
              at all; and it ran with `multisampling={0}` and no SMAA pass,
              which is simply "aliasing on" — every box edge in a scene made
              entirely of boxes. SSAO is the pass that does the most work
              here: contact darkening where a wall meets its floor is what
              stops a stack of primitives reading as flat shapes. */}
          <EffectComposer multisampling={0} enableNormalPass>
            <SSAO
              blendFunction={BlendFunction.MULTIPLY}
              samples={24}
              radius={0.12}
              intensity={22}
              luminanceInfluence={0.5}
              worldDistanceThreshold={40}
              worldDistanceFalloff={8}
              worldProximityThreshold={4}
              worldProximityFalloff={2}
            />
            {theme.glow ? (
              <Bloom luminanceThreshold={0.15} luminanceSmoothing={0.3} intensity={0.85} mipmapBlur radius={0.7} />
            ) : (
              <></>
            )}
            {/* AGX rolls highlights off beautifully on the neon deck and
                desaturates them on the pastel one, where the floors are
                near-white by design and came out grey. Per-theme, for the
                same reason the palette is: both looks are real, so neither
                gets to be the one the pipeline was tuned for. */}
            <ToneMapping mode={theme.glow ? ToneMappingMode.AGX : ToneMappingMode.NEUTRAL} />
            <Vignette offset={0.32} darkness={theme.glow ? 0.55 : 0.28} eskil={false} />
            <SMAA />
          </EffectComposer>
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
            [ FAR ]
          </button>
          <button className={zoom === 'medium' ? 'on' : ''} onClick={() => setZoom('medium')}>
            [ ROOMS ]
          </button>
          <button className={zoom === 'close' ? 'on' : ''} onClick={() => setZoom('close')}>
            [ CLOSE ]
          </button>
          {onSelectMany && (
            <button className={selectMode ? 'on' : ''} onClick={() => setSelectMode((v) => !v)}>
              [ SELECT ]
            </button>
          )}
          <button title="Turn the deck left (Q or ←)" onClick={() => rotate(-1)}>
            [ ⟲ ]
          </button>
          <button title="Turn the deck right (E or →)" onClick={() => rotate(1)}>
            [ ⟳ ]
          </button>
          <button title={`Theme: ${theme.label} — click to cycle`} onClick={cycleTheme}>
            [ 🎨 {theme.label.toUpperCase()} ]
          </button>
        </div>
        <div className="world-hint">
          {selectMode ? '>>> DRAG TO BOX-SELECT MULTIPLE AGENTS' : '>>> DRAG TO PAN · Q/E TO TURN · CLICK AN AGENT OR ROOM FOR DETAIL'}
        </div>
      </div>
      <BottomTelemetryBar agents={agents} flights={flights} />
    </div>
  )
}
