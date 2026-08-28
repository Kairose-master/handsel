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

type Props = {
  agents: Agent[]
  selectedId: string | null
  follow: boolean
  onSelect: (agent: Agent) => void
  onSelectRoom?: (room: Room) => void
}

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

export default function OfficeWorld({ agents, selectedId, follow, onSelect, onSelectRoom }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const agentRefs = useRef(new Map<string, HTMLDivElement>())
  const camRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 })
  const targetRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 })
  const selectedRef = useRef<string | null>(selectedId)
  const dragRef = useRef({ on: false, px: 0, py: 0, moved: false })
  const [zoom, setZoom] = useState<'fit' | 'close'>('fit')
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  // Hot room: whichever department currently has the most people in it —
  // a live fact about the current roster, not a script beat.
  const hotRoom = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of agents) {
      if (a.deptId === 'lounge' || a.deptId === 'ceo') continue
      counts.set(a.deptId, (counts.get(a.deptId) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [id, n] of counts) {
      if (n > bestCount) {
        best = id
        bestCount = n
      }
    }
    return best
  }, [agents])

  const focus = useMemo(() => {
    if (hotRoom) {
      const room = roomOf(hotRoom)
      return { x: (room.x + room.w / 2) * TILE, y: (room.y + room.h / 2) * TILE }
    }
    return { x: CEO_ROOM.x * TILE, y: CEO_ROOM.y * TILE }
  }, [hotRoom])

  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) agentRefs.current.set(id, el)
    else agentRefs.current.delete(id)
  }, [])

  const onPick = useCallback(
    (agent: Agent) => {
      if (!dragRef.current.moved) onSelect(agent)
    },
    [onSelect],
  )

  const onPickRoom = useCallback(
    (room: Room) => {
      if (!dragRef.current.moved) onSelectRoom?.(room)
    },
    [onSelectRoom],
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const compute = () => {
      const rect = viewport.getBoundingClientRect()
      const fit = Math.min(rect.width / WORLD_W, rect.height / WORLD_H)
      if (zoom === 'fit') {
        targetRef.current = { x: WORLD_W / 2, y: WORLD_H / 2, scale: fit }
        return
      }
      const scale = Math.max(fit * 1.9, 0.95)
      targetRef.current = follow && focus ? { ...focus, scale } : { ...targetRef.current, scale }
    }

    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [zoom, follow, focus])

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
    dragRef.current = { on: true, px: e.clientX, py: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
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
    dragRef.current.on = false
    window.setTimeout(() => {
      dragRef.current.moved = false
    }, 0)
  }

  return (
    <div className="world-frame">
      <div
        className="world-viewport"
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div className="world-stage" ref={stageRef} style={{ width: WORLD_W, height: WORLD_H }}>
          <div className="world-floor" />

          {ROOMS.map((room) => (
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
          ))}

          <PropLayer />
          <AgentLayer agents={agents} register={register} onPick={onPick} />
        </div>

        <div className="world-hud">
          <button className={zoom === 'fit' ? 'on' : ''} onClick={() => setZoom('fit')}>
            🗺️ Fit
          </button>
          <button className={zoom === 'close' ? 'on' : ''} onClick={() => setZoom('close')}>
            🔍 Close
          </button>
        </div>
        <div className="world-hint">Drag to look around · click an agent for details</div>
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
