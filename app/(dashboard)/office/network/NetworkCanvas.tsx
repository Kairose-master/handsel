'use client'

/**
 * The constellation.
 *
 * Every dot on this canvas is a row: an agent, or an office. Every line is
 * information that actually moved between two of them — a message, a
 * delegation handoff, an escrowed job, an office connection. There is no
 * decorative starfield behind it and no filler node padding the picture out;
 * a quiet account draws a small quiet graph, which is the honest answer (see
 * CLAUDE.md, "No fake data, ever"). What LOOKS like a starfield when the
 * market is busy is the market being busy — node radius follows real degree,
 * so a silent agent genuinely is a one-pixel dot next to a hub.
 *
 * The one thing that moves on its own is the pulse travelling along an edge.
 * It encodes recency and nothing else — an edge whose newest row landed in
 * the last few hours pulses, an older one is a static line. It is NOT a
 * throughput animation; the speed is fixed, so nobody can read a rate out of
 * it that the data does not support.
 *
 * Rendering is 2D canvas rather than SVG on purpose: a few hundred nodes with
 * per-frame pulses is a few hundred DOM nodes being restyled sixty times a
 * second in SVG, and the layout (lib/agent-network.ts) already hands us
 * finished coordinates, so there is nothing the DOM would buy us here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NetworkEdge, NetworkEdgeKind, NetworkNode, NetworkLayout } from '@/lib/agent-network'

/** An edge whose newest row is younger than this pulses. */
export const LIVE_PULSE_MS = 6 * 60 * 60 * 1000

type Rgb = readonly [number, number, number]

/** Edge palette. Money is gold, the free lane is cyan, an owner's internal
 *  handoff is violet, and structure (membership, office links) is grey —
 *  structure should never out-shout traffic. */
export const EDGE_COLOR: Record<NetworkEdgeKind, Rgb> = {
  message: [96, 190, 255],
  handoff: [167, 139, 250],
  job: [251, 191, 36],
  'office-link': [45, 212, 191],
  membership: [110, 122, 148],
}

const EDGE_ALPHA: Record<NetworkEdgeKind, number> = {
  message: 0.5,
  handoff: 0.45,
  job: 0.4,
  'office-link': 0.4,
  membership: 0.14,
}

const rgba = (c: Rgb, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

/** Stable per-edge phase offset, so pulses do not march in lockstep. */
function hashPhase(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

export function nodeRadius(node: NetworkNode): number {
  const base = node.kind === 'office' ? 7 : 3
  return base + Math.min(7, Math.log2(1 + node.degree) * 1.9)
}

type View = { scale: number; x: number; y: number }

export type NetworkCanvasProps = {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  layout: NetworkLayout
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function NetworkCanvas({ nodes, edges, layout, selectedId, onSelect }: NetworkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  /** Neighbours of the focused node — everything else dims, which is the
   *  only way a hairball answers "who does THIS one talk to". */
  const focusId = hoverId ?? selectedId
  const neighbours = useMemo(() => {
    if (!focusId) return null
    const set = new Set<string>([focusId])
    for (const e of edges) {
      if (e.source === focusId) set.add(e.target)
      else if (e.target === focusId) set.add(e.source)
    }
    return set
  }, [focusId, edges])

  const project = useCallback(
    (p: { x: number; y: number }, w: number, h: number, v: View) => {
      const radius = Math.min(w, h) / 2 - 36
      return { x: w / 2 + p.x * radius * v.scale + v.x, y: h / 2 + p.y * radius * v.scale + v.y }
    },
    [],
  )

  const hitTest = useCallback(
    (cx: number, cy: number, w: number, h: number, v: View): string | null => {
      let best: { id: string; d: number } | null = null
      for (const node of nodes) {
        const p = layout.get(node.id)
        if (!p) continue
        const s = project(p, w, h, v)
        const d = Math.hypot(s.x - cx, s.y - cy)
        const r = Math.max(10, nodeRadius(node) + 6)
        if (d <= r && (!best || d < best.d)) best = { id: node.id, d }
      }
      return best?.id ?? null
    },
    [nodes, layout, project],
  )

  /* Draw loop. Runs continuously because pulses move; it is a few hundred
     strokes per frame, which is cheap, and it stops with the component. */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const rect = wrap.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    const now0 = Date.now()

    const frame = (t: number) => {
      ctx.clearRect(0, 0, width, height)

      // Deep-space ground. A gradient, not a texture — nothing here pretends
      // to be a data point.
      const g = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.75)
      g.addColorStop(0, '#0b1020')
      g.addColorStop(1, '#05060d')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, width, height)

      const dimmed = (id: string) => (neighbours ? !neighbours.has(id) : false)

      /* Edges first, so nodes sit on top of their own lines. */
      for (const e of edges) {
        const a = layout.get(e.source)
        const b = layout.get(e.target)
        if (!a || !b) continue
        const pa = project(a, width, height, view)
        const pb = project(b, width, height, view)
        const faded = dimmed(e.source) && dimmed(e.target)
        const color = EDGE_COLOR[e.kind]
        const alpha = EDGE_ALPHA[e.kind] * (faded ? 0.15 : 1)

        ctx.strokeStyle = rgba(color, alpha)
        ctx.lineWidth = e.kind === 'membership' ? 0.6 : Math.min(2.2, 0.6 + Math.log2(1 + e.count) * 0.4)
        if (e.kind === 'office-link') ctx.setLineDash([5, 5])
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.stroke()
        ctx.setLineDash([])

        // Recency pulse — fixed speed, so it says "recent", not "how much".
        const fresh = e.lastAt ? now0 - Date.parse(e.lastAt) < LIVE_PULSE_MS : false
        if (fresh && !faded) {
          const phase = (t / 2600 + hashPhase(e.id)) % 1
          const px = pa.x + (pb.x - pa.x) * phase
          const py = pa.y + (pb.y - pa.y) * phase
          ctx.fillStyle = rgba(color, 0.9)
          ctx.beginPath()
          ctx.arc(px, py, 2, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      /* Nodes. */
      for (const node of nodes) {
        const p = layout.get(node.id)
        if (!p) continue
        const s = project(p, width, height, view)
        const r = nodeRadius(node) * (node.id === focusId ? 1.5 : 1)
        const faded = dimmed(node.id)
        const color: Rgb = node.kind === 'office' ? [45, 212, 191] : node.mine ? [125, 211, 252] : [148, 163, 184]
        const alpha = faded ? 0.22 : 1

        // Glow, only for nodes that carry traffic — otherwise every dot
        // looks equally important and the picture says nothing.
        if (!faded && node.degree > 0) {
          const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 4)
          glow.addColorStop(0, rgba(color, 0.28))
          glow.addColorStop(1, rgba(color, 0))
          ctx.fillStyle = glow
          ctx.beginPath()
          ctx.arc(s.x, s.y, r * 4, 0, Math.PI * 2)
          ctx.fill()
        }

        ctx.fillStyle = rgba(color, alpha)
        ctx.beginPath()
        if (node.kind === 'office') {
          // A square reads as a place; a circle reads as a person.
          ctx.rect(s.x - r, s.y - r, r * 2, r * 2)
        } else {
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
        }
        ctx.fill()

        if (node.id === selectedId) {
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2)
          ctx.stroke()
        }

        // Labels are rationed: offices, your own agents, and whatever is
        // under the cursor. Labelling everything is how a graph becomes
        // unreadable at forty nodes.
        const labelled = node.kind === 'office' || node.mine || node.id === focusId
        if (labelled && !faded) {
          ctx.font = `${node.kind === 'office' ? 600 : 400} 11px ui-sans-serif, system-ui, sans-serif`
          ctx.fillStyle = node.id === focusId ? 'rgba(255,255,255,0.95)' : 'rgba(226,232,240,0.7)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(node.label.slice(0, 24), s.x, s.y + r + 4)
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [nodes, edges, layout, view, focusId, selectedId, neighbours, project])

  /* Pointer: drag to pan, wheel to zoom, click to select. A drag that moved
     is not a click — otherwise panning past a node keeps re-selecting it. */
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    ;(ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId)
    dragRef.current = { x: ev.clientX, y: ev.clientY, moved: false }
  }

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect()
    const drag = dragRef.current
    if (drag) {
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true
        drag.x = ev.clientX
        drag.y = ev.clientY
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
      }
      return
    }
    setHoverId(hitTest(ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height, view))
  }

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.moved) return
    const rect = ev.currentTarget.getBoundingClientRect()
    onSelect(hitTest(ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height, view))
  }

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    setView((v) => ({ ...v, scale: Math.min(6, Math.max(0.4, v.scale * (ev.deltaY < 0 ? 1.12 : 0.89))) }))
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg">
      <canvas
        ref={canvasRef}
        className={hoverId ? 'cursor-pointer touch-none' : 'cursor-grab touch-none'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          dragRef.current = null
          setHoverId(null)
        }}
        onWheel={onWheel}
      />
      <button
        type="button"
        onClick={() => setView({ scale: 1, x: 0, y: 0 })}
        className="absolute bottom-3 right-3 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white/70 backdrop-blur hover:text-white"
      >
        Reset view
      </button>
    </div>
  )
}
