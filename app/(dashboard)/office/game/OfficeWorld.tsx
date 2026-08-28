'use client'

/**
 * Canvas-free DOM/CSS renderer, ported from the reference pixel-office
 * engine (its actual rendering code, unchanged) — a game loop paints agent
 * positions from `live-engine.ts`'s `Agent[]` directly onto refs each frame,
 * skipping React state so it stays smooth with a live-updating roster.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from './live-engine'
import { CEO_ROOM, PROPS, ROOMS, TILE, WORLD_H, WORLD_W, roomOf, type Room } from './world'
import { hotRoomOf, roomStatsOf, closeRoomIdFor } from './zoom'
import { screenBoxToWorldBox, agentsInWorldBox, MIN_SELECT_BOX_PX } from './select'
import type { ArtifactFlight } from '@/lib/office-world-data'

type Props = {
  agents: Agent[]
  selectedId: string | null
  /** The currently selected ROOM's id, if any (mutually exclusive with
   *  selectedId at the call site — office/page.tsx clears one when the
   *  other is picked). Drives 'close' zoom's target when no agent is
   *  selected. */
  selectedRoomId: string | null
  onSelect: (agent: Agent) => void
  onSelectRoom?: (room: Room) => void
  /** RTS-style box multi-select (redesign brief §9): an inspect-only group
   *  pick, independent of onSelect/onSelectRoom's single-target selection —
   *  see select.ts's header for why it stays inspect-only. Optional: a
   *  caller that doesn't pass this simply never sees the "🔲 Select" tool. */
  onSelectMany?: (ids: string[]) => void
  /** Deliverables currently traveling between two known rooms (redesign
   *  brief: artifact objects moving independent of agent movement) — optional
   *  and purely additive, same as onSelectMany. */
  flights?: ArtifactFlight[]
}

const FLIGHT_ICON: Record<ArtifactFlight['kind'], string> = { handoff: '📦', review: '🧾', synthesis: '🧩' }

function roomCenterPx(deptId: string | null): { x: number; y: number } {
  const room = ROOMS.find((r) => r.id === (deptId ?? 'lounge'))
  if (!room) return { x: 0, y: 0 }
  return { x: (room.x + room.w / 2) * TILE, y: (room.y + room.h / 2) * TILE }
}

/** Renders each real flight as a static connecting line (the handoff exists,
 *  whether or not the eye catches the animated dot) plus a small icon that
 *  loops along it — motion here illustrates a fact already established by
 *  office-artifact-flights.ts, it never invents one of its own. */
const ArtifactLayer = memo(function ArtifactLayer({ flights }: { flights: ArtifactFlight[] }) {
  if (flights.length === 0) return null
  return (
    <>
      <svg className="artifact-lines" width={WORLD_W} height={WORLD_H}>
        {flights.map((f) => {
          const from = roomCenterPx(f.fromDeptId)
          const to = roomCenterPx(f.toDeptId)
          return <line key={f.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`artifact-line artifact-line-${f.kind}`} />
        })}
      </svg>
      {flights.map((f) => {
        const from = roomCenterPx(f.fromDeptId)
        const to = roomCenterPx(f.toDeptId)
        return (
          <span
            key={f.id}
            className="artifact-dot"
            title={f.label}
            style={
              {
                left: from.x,
                top: from.y,
                '--dx': `${to.x - from.x}px`,
                '--dy': `${to.y - from.y}px`,
              } as React.CSSProperties
            }
          >
            {FLIGHT_ICON[f.kind]}
          </span>
        )
      })}
    </>
  )
})

/**
 * Semantic zoom (Handsel Office redesign brief §6): what's worth showing
 * changes with how much of the map is visible, not just how big it looks.
 *
 *  - far:    the whole office. Individual agents shrink to color dots —
 *            identity is not readable at this scale and pretending it is
 *            would just be tiny illegible text. Rooms instead show what
 *            IS readable here: how many people, and whether anything in
 *            that room needs attention.
 *  - medium: today's original "close" — follows the busiest room, agents
 *            are full sprites with name tags. Individual activity readable,
 *            not yet an inspector.
 *  - close:  tightest zoom, centered on whatever is actually SELECTED (an
 *            agent's current room, or a clicked room) rather than merely
 *            the busiest one. This is the zoom tier the detail panel next
 *            to the canvas already serves data for; the camera now moves
 *            to match what that panel is showing instead of leaving the
 *            view pointed somewhere unrelated to the click.
 */
type ZoomTier = 'far' | 'medium' | 'close'

type Cam = { x: number; y: number; scale: number }

const AgentLayer = memo(function AgentLayer({
  agents,
  register,
  onPick,
}: {
  agents: Agent[]
  register: (id: string, el: HTMLDivElement | null) => void
  onPick: (agent: Agent) => void
}) {
  return (
    <>
      {agents.map((agent) => (
        <div
          key={agent.id}
          ref={(el) => register(agent.id, el)}
          onPointerUp={(e) => {
            e.stopPropagation() // an agent click is an agent pick, not also the room it stands in
            onPick(agent)
          }}
          style={
            {
              '--hair': agent.hair,
              '--shirt': agent.shirt,
              '--accent': agent.accent,
              '--skin': agent.skin,
            } as React.CSSProperties
          }
        >
          <span className="ag-bubble" />
          <span className="ag-bar">
            <i />
          </span>
          <span className="ag-body">
            <i className="p-shadow" />
            <i className="p-leg l" />
            <i className="p-leg r" />
            <i className="p-torso" />
            <i className="p-arm l" />
            <i className="p-arm r" />
            <i className="p-head">
              <b className="p-eye l" />
              <b className="p-eye r" />
            </i>
            <i className="p-hair" />
          </span>
          <span className="ag-tag">
            {agent.name}
            {agent.rank === 'lead' ? <em>lead</em> : null}
            {agent.rank === 'ceo' ? <em>owner</em> : null}
          </span>
        </div>
      ))}
    </>
  )
})

const PropLayer = memo(function PropLayer() {
  return (
    <>
      {PROPS.map((prop, i) => (
        <div
          key={i}
          className={`pr pr-${prop.kind}`}
          style={{ left: prop.x * TILE, top: prop.y * TILE, width: prop.w * TILE, height: prop.h * TILE }}
        >
          {prop.kind === 'desk' ? <i className="pr-monitor" /> : null}
          {prop.label ? <span>{prop.label}</span> : null}
        </div>
      ))}
      <div className="entrance-mat" style={{ left: 34 * TILE, top: 55 * TILE, width: 5 * TILE, height: 2 * TILE }}>
        ENTRANCE
      </div>
    </>
  )
})

export default function OfficeWorld({ agents, selectedId, selectedRoomId, onSelect, onSelectRoom, onSelectMany, flights = [] }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const agentRefs = useRef(new Map<string, HTMLDivElement>())
  const camRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 })
  const targetRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 })
  const selectedRef = useRef<string | null>(selectedId)
  const dragRef = useRef({ on: false, px: 0, py: 0, moved: false })
  const [zoom, setZoom] = useState<ZoomTier>('far')
  const zoomRef = useRef<ZoomTier>(zoom)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  // RTS box multi-select — a distinct tool, not a modifier on the default
  // drag, because the default drag already means "pan the camera" and the
  // two must never both fire off the same gesture. selectBox is SCREEN-space
  // (relative to the viewport) purely for drawing the rectangle overlay;
  // the world-space conversion (select.ts's screenBoxToWorldBox) only
  // happens once, on release.
  const [selectMode, setSelectMode] = useState(false)
  const [selectBox, setSelectBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const selectDragRef = useRef({ on: false })

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // Hot room, per-room far-zoom badges, and close-zoom's target — pure
  // logic, unit-tested in tests/office-zoom.test.ts without a browser.
  const hotRoom = useMemo(() => hotRoomOf(agents), [agents])
  const roomStats = useMemo(() => roomStatsOf(agents), [agents])
  const closeRoomId = useMemo(
    () => closeRoomIdFor({ selectedId, selectedRoomId, agents, hotRoom }),
    [selectedId, selectedRoomId, agents, hotRoom],
  )

  const focusFor = useCallback((roomId: string | null) => {
    if (roomId) {
      const room = roomOf(roomId)
      return { x: (room.x + room.w / 2) * TILE, y: (room.y + room.h / 2) * TILE }
    }
    return { x: CEO_ROOM.x * TILE, y: CEO_ROOM.y * TILE }
  }, [])

  const mediumFocus = useMemo(() => focusFor(hotRoom), [focusFor, hotRoom])
  const closeFocus = useMemo(() => focusFor(closeRoomId), [focusFor, closeRoomId])

  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) agentRefs.current.set(id, el)
    else agentRefs.current.delete(id)
  }, [])

  const onPick = useCallback(
    (agent: Agent) => {
      if (!dragRef.current.moved) {
        onSelect(agent)
        setZoom('close') // an inspect click means "show me this", not "where was I looking"
      }
    },
    [onSelect],
  )

  const onPickRoom = useCallback(
    (room: Room) => {
      if (!dragRef.current.moved && onSelectRoom) {
        onSelectRoom(room)
        setZoom('close')
      }
    },
    [onSelectRoom],
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const compute = () => {
      const rect = viewport.getBoundingClientRect()
      const fit = Math.min(rect.width / WORLD_W, rect.height / WORLD_H)
      if (zoom === 'far') {
        targetRef.current = { x: WORLD_W / 2, y: WORLD_H / 2, scale: fit }
        return
      }
      if (zoom === 'close') {
        const scale = Math.max(fit * 3.2, 1.4)
        targetRef.current = { ...closeFocus, scale }
        return
      }
      const scale = Math.max(fit * 1.9, 0.95)
      targetRef.current = { ...mediumFocus, scale }
    }

    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [zoom, mediumFocus, closeFocus])

  useEffect(() => {
    let raf = 0
    const paint = () => {
      const viewport = viewportRef.current
      const stage = stageRef.current
      if (viewport && stage) {
        const cam = camRef.current
        const target = targetRef.current
        cam.x += (target.x - cam.x) * 0.07
        cam.y += (target.y - cam.y) * 0.07
        cam.scale += (target.scale - cam.scale) * 0.08

        const rect = viewport.getBoundingClientRect()
        const ox = rect.width / 2 - cam.x * cam.scale
        const oy = rect.height / 2 - cam.y * cam.scale
        stage.style.transform = `translate3d(${ox}px, ${oy}px, 0) scale(${cam.scale})`
        if (stage.classList.contains('compact') !== cam.scale < 0.62) {
          stage.classList.toggle('compact', cam.scale < 0.62)
        }
        // Discrete tier, not a scale threshold like .compact — far zoom is a
        // deliberate choice (the 🗺️ Far button), not an incidental zoom
        // level, so agents simplify to dots exactly when that tier is active.
        const isFar = zoomRef.current === 'far'
        if (stage.classList.contains('far') !== isFar) stage.classList.toggle('far', isFar)

        const picked = selectedRef.current
        for (const agent of agentsRef.current) {
          const el = agentRefs.current.get(agent.id)
          if (!el) continue

          el.style.transform = `translate3d(${(agent.x + 0.5 + agent.jitter) * TILE}px, ${(agent.y + 0.9) * TILE}px, 0)`
          el.style.zIndex = String(200 + Math.round(agent.y))

          const cls = `ag f-${agent.facing} a-${agent.anim} r-${agent.rank}` + (agent.id === picked ? ' selected' : '')
          if (el.className !== cls) el.className = cls

          const bubble = el.firstElementChild as HTMLElement
          const text = agent.speech ?? ''
          if (bubble.dataset.text !== text) {
            bubble.dataset.text = text
            bubble.textContent = text
            bubble.className = `ag-bubble ${agent.speechKind}${text ? ' on' : ''}`
          }

          const bar = el.children[1] as HTMLElement
          const fill = bar.firstElementChild as HTMLElement
          const show = agent.anim === 'type' ? '1' : '0'
          if (bar.style.opacity !== show) bar.style.opacity = show
          if (show === '1') fill.style.width = `${Math.round(agent.progress * 100)}%`
        }
      }
      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.world-hud')) return
    if (selectMode) {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      selectDragRef.current.on = true
      setSelectBox({ x0: x, y0: y, x1: x, y1: y })
      return
    }
    dragRef.current = { on: true, px: e.clientX, py: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (selectMode) {
      if (!selectDragRef.current.on) return
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      setSelectBox((box) => (box ? { ...box, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : box))
      return
    }
    const drag = dragRef.current
    if (!drag.on) return
    const dx = e.clientX - drag.px
    const dy = e.clientY - drag.py
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    drag.px = e.clientX
    drag.py = e.clientY
    const scale = camRef.current.scale || 1
    targetRef.current = {
      ...targetRef.current,
      x: clamp(targetRef.current.x - dx / scale, 0, WORLD_W),
      y: clamp(targetRef.current.y - dy / scale, 0, WORLD_H),
    }
  }
  const onPointerUp = () => {
    if (selectMode) {
      if (selectDragRef.current.on) {
        selectDragRef.current.on = false
        setSelectBox((box) => {
          if (box) {
            const rect = viewportRef.current?.getBoundingClientRect()
            const big = Math.abs(box.x1 - box.x0) >= MIN_SELECT_BOX_PX || Math.abs(box.y1 - box.y0) >= MIN_SELECT_BOX_PX
            if (rect && big) {
              const worldBox = screenBoxToWorldBox(box, rect.width, rect.height, camRef.current)
              onSelectMany?.(agentsInWorldBox(agentsRef.current, worldBox))
            }
          }
          return null
        })
      }
      return
    }
    dragRef.current.on = false
    window.setTimeout(() => {
      dragRef.current.moved = false
    }, 0)
  }

  return (
    <div className="world-frame">
      <div
        className={`world-viewport ${selectMode ? 'select-mode' : ''}`}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div className="world-stage" ref={stageRef} style={{ width: WORLD_W, height: WORLD_H }}>
          <div className="world-floor" />

          {ROOMS.map((room) => {
            const stats = roomStats.get(room.id)
            return (
              <div
                key={room.id}
                className={`rm rm-${room.kind} ${hotRoom === room.id ? 'hot' : ''} ${onSelectRoom ? 'rm-clickable' : ''}`}
                style={{ left: room.x * TILE, top: room.y * TILE, width: room.w * TILE, height: room.h * TILE }}
                onPointerUp={() => onPickRoom(room)}
              >
                <span className="rm-head">
                  <b>
                    {room.icon} {room.name}
                  </b>
                  {stats && stats.count > 0 && (
                    <span className={`rm-count ${stats.alert ? 'alert' : ''}`} title={stats.alert ? 'A job here is in dispute' : `${stats.count} here`}>
                      {stats.alert ? '⚠' : stats.count}
                    </span>
                  )}
                </span>
                <span className="rm-code">{room.short}</span>
                {room.doors.map((door) => (
                  <span
                    key={`${door.x}-${door.y}`}
                    className="rm-door"
                    style={{ left: (door.x - room.x) * TILE, top: (door.y - room.y) * TILE }}
                  />
                ))}
              </div>
            )
          })}

          <PropLayer />
          <ArtifactLayer flights={flights} />
          <AgentLayer agents={agents} register={register} onPick={onPick} />
        </div>

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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
