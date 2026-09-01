'use client'

/**
 * Tactical painted office — the third renderer preset, and the default one.
 *
 * The other two renderers BUILD the room out of primitives (DOM tiles,
 * extruded meshes) and pay for it in fidelity: at 480px tall they read as
 * diagrams. This one inverts the trade: a pre-rendered isometric painting of
 * the office (public/art/office-backdrop.webp, produced by the
 * docs/reference-images.md art pipeline from game3d/theme.ts's tactical
 * palette) is the scene, and only the LIVE layer — agent tokens, event
 * pulses, the activity feed — is composited on top in the browser. The
 * painting never changes, so it can look like concept art; the layer on top
 * changes only when real data does.
 *
 * The same no-fake-data rule as the other two renderers, enforced the same
 * way: every token is a real roster agent (props.agents, straight off the
 * polled snapshot), every feed row is a status line or artifact flight that
 * actually changed between polls, and the LIVE dot downgrades to LINK
 * DEGRADED off the same `healthy` signal the 3D HUD uses. There is no
 * ambient animation loop inventing activity — a quiet office looks quiet.
 *
 * Room anchors are UV coordinates into the painting, keyed by the REAL room
 * ids from world.ts (the nine functional departments plus ceo and lounge),
 * so a repainted backdrop is a retune of one table, not a rewrite. The
 * prototype this was ported from (with a mock event loop, kept for reel
 * shoots) lives at docs/prototypes/office-tactical-view/.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from './live-engine'
import { roomOf, type Room } from './world'
import type { ArtifactFlight } from '@/lib/office-world-data'

type Props = {
  agents: Agent[]
  selectedId: string | null
  selectedRoomId: string | null
  onSelect: (agent: Agent) => void
  onSelectRoom?: (room: Room) => void
  /** Real deliverables in motion — drawn as pulses at both endpoints and a
   *  feed row, since a painting has no corridors to route a dot along. */
  flights?: ArtifactFlight[]
  /** The snapshot poll's health, same signal as the 3D HUD's status dot. */
  healthy?: boolean
}

/** Native size of the painted backdrop. All live-layer positions are in this
 *  fixed scene space; the camera transform maps it onto the viewport, so
 *  nothing needs re-anchoring on resize or zoom. */
const SCENE_W = 1412
const SCENE_H = 684

/** Where each real room sits in the painting, as [u, v] into SCENE_W/H.
 *  Tuned by eye against the backdrop's painted zones: screen wall top-left =
 *  research, conference table far left = strategy, archive racks top-center =
 *  memory, bookshelf wall = skill gym, the central desk cluster =
 *  engineering, its right neighbours = qa then verification, the raised
 *  platform with the world map = the owner's office, the ornate front desk =
 *  treasury, the racks by the right door = market, sofas on the green rug =
 *  idle lounge. */
const ROOM_UV: Record<string, [number, number]> = {
  research: [0.11, 0.28],
  strategy: [0.09, 0.55],
  memory: [0.31, 0.19],
  skills: [0.3, 0.64],
  engineering: [0.47, 0.55],
  qa: [0.58, 0.47],
  verification: [0.62, 0.3],
  ceo: [0.72, 0.18],
  treasury: [0.7, 0.64],
  market: [0.87, 0.42],
  lounge: [0.24, 0.79],
}

const TOKEN_COUNT = 10

/** Stable token portrait per agent id — identity must not reshuffle between
 *  polls, so it hashes the id rather than using roster order. */
function tokenIndexFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % TOKEN_COUNT
}

function anchorFor(roomId: string): [number, number] {
  return ROOM_UV[roomId] ?? ROOM_UV.lounge
}

/** Scene-space position for the i-th of n agents in a room: a small ring
 *  around the room anchor so co-located agents stay individually clickable.
 *  Deterministic in (room, index) so positions are stable across renders. */
function seatPosition(roomId: string, index: number, count: number): { x: number; y: number } {
  const [u, v] = anchorFor(roomId)
  if (count <= 1) return { x: u * SCENE_W, y: v * SCENE_H }
  const angle = (index / count) * Math.PI * 2 + roomId.length
  const r = Math.min(0.045, 0.02 + count * 0.006)
  // The painting is isometric: a circle in floor space is an ellipse on
  // screen, so the vertical radius is squashed.
  return {
    x: (u + Math.cos(angle) * r) * SCENE_W,
    y: (v + Math.sin(angle) * r * 0.55) * SCENE_H,
  }
}

type FeedRow = { key: string; who: string; text: string; tone: 'info' | 'ok' }
type Pulse = { key: string; x: number; y: number }

const FEED_MAX = 6
const FLIGHT_LABEL: Record<ArtifactFlight['kind'], string> = {
  handoff: 'handoff',
  review: 'review',
  synthesis: 'synthesis',
}

const DeptLabels = memo(function DeptLabels({ onPickRoom }: { onPickRoom?: (room: Room) => void }) {
  return (
    <>
      {Object.keys(ROOM_UV).map((id) => {
        const room = roomOf(id)
        const [u, v] = ROOM_UV[id]
        return (
          <button
            key={id}
            type="button"
            className="tac-dept"
            style={{ left: u * SCENE_W, top: v * SCENE_H + 34 }}
            onClick={onPickRoom ? () => onPickRoom(room) : undefined}
          >
            {room.short}
          </button>
        )
      })}
    </>
  )
})

export default function TacticalView({
  agents,
  selectedId,
  selectedRoomId,
  onSelect,
  onSelectRoom,
  flights = [],
  healthy = true,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [coverScale, setCoverScale] = useState(1)
  // Transitions (camera zoom, token walks) switch on only after the first
  // real layout pass, so the initial cover-scale fit snaps into place
  // instead of animating from the placeholder scale — the prototype's
  // double-rAF ".ready" trick, kept for the same reason.
  const [ready, setReady] = useState(false)
  const [feed, setFeed] = useState<FeedRow[]>([])
  const [pulses, setPulses] = useState<Pulse[]>([])
  // Parallax is applied to an outer camera div (untransitioned) while
  // focus/zoom transitions run on the scene div — combined on one element
  // the mousemove would keep interrupting the zoom transition.
  const cameraRef = useRef<HTMLDivElement>(null)
  const lastStatus = useRef(new Map<string, string>())
  const seenFlights = useRef(new Set<string>())
  const feedSeq = useRef(0)
  const pulseTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  // Scale the fixed-size scene to COVER the viewport (the painting has no
  // edges worth showing), recomputed only on resize.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const compute = () => {
      const rect = viewport.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setCoverScale(Math.max(rect.width / SCENE_W, rect.height / SCENE_H))
      }
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(viewport)
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  // Feed rows come from what actually CHANGED between polls: a status line
  // that differs from the last one seen for that agent, or a flight id not
  // seen before. First poll seeds the baseline silently — replaying the
  // whole roster as "news" on mount would be fake activity.
  useEffect(() => {
    const rows: FeedRow[] = []
    const seeding = lastStatus.current.size === 0
    for (const a of agents) {
      const prev = lastStatus.current.get(a.id)
      lastStatus.current.set(a.id, a.status)
      if (!seeding && prev !== undefined && prev !== a.status && a.status) {
        rows.push({ key: `s${feedSeq.current++}`, who: a.name, text: a.status, tone: 'info' })
      }
    }
    if (rows.length) setFeed((f) => [...rows.reverse(), ...f].slice(0, FEED_MAX))
  }, [agents])

  useEffect(() => {
    const rows: FeedRow[] = []
    const fresh: Pulse[] = []
    for (const f of flights) {
      if (seenFlights.current.has(f.id)) continue
      seenFlights.current.add(f.id)
      rows.push({ key: `f${feedSeq.current++}`, who: FLIGHT_LABEL[f.kind], text: f.label, tone: 'ok' })
      for (const dept of [f.fromDeptId, f.toDeptId]) {
        const [u, v] = anchorFor(dept ?? 'lounge')
        fresh.push({ key: `p${feedSeq.current++}`, x: u * SCENE_W, y: v * SCENE_H })
      }
    }
    if (rows.length) setFeed((f) => [...rows.reverse(), ...f].slice(0, FEED_MAX))
    if (fresh.length) {
      setPulses((p) => [...p, ...fresh])
      const keys = new Set(fresh.map((p) => p.key))
      // Not this effect's cleanup: cancelling on the NEXT flights change
      // would strand the previous batch's pulses on screen forever.
      pulseTimers.current.push(
        setTimeout(() => setPulses((p) => p.filter((x) => !keys.has(x.key))), 1900),
      )
    }
  }, [flights])

  useEffect(() => {
    const timers = pulseTimers.current
    return () => timers.forEach(clearTimeout)
  }, [])

  // Idle parallax — a subtle perspective tilt following the pointer. Motion
  // of the CAMERA, not of the data: it stops dead the moment the pointer
  // leaves, and invents nothing.
  useEffect(() => {
    const viewport = viewportRef.current
    const camera = cameraRef.current
    if (!viewport || !camera) return
    const onMove = (e: PointerEvent) => {
      const rect = viewport.getBoundingClientRect()
      const dx = (e.clientX - rect.left) / rect.width - 0.5
      const dy = (e.clientY - rect.top) / rect.height - 0.5
      camera.style.transform = `perspective(1200px) rotateY(${dx * 2.4}deg) rotateX(${-dy * 1.8}deg)`
    }
    const onLeave = () => {
      camera.style.transform = ''
    }
    viewport.addEventListener('pointermove', onMove)
    viewport.addEventListener('pointerleave', onLeave)
    return () => {
      viewport.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  // Camera: centered overview by default; a selection zooms toward the
  // selected agent's room (or the clicked room). Same math as the prototype:
  // translate(T) scale(S) about center moves scene point d=(u-.5)*W to
  // S*d + T, so T = -S*d centers the focus point.
  const focusRoomId = useMemo(() => {
    if (selectedId) {
      const agent = agents.find((a) => a.id === selectedId)
      if (agent) return agent.deptId
    }
    return selectedRoomId
  }, [selectedId, selectedRoomId, agents])

  const sceneTransform = useMemo(() => {
    const zoomed = focusRoomId !== null && focusRoomId !== undefined
    const s = coverScale * (zoomed ? 1.65 : 1.02)
    const [u, v] = zoomed ? anchorFor(focusRoomId) : [0.5, 0.5]
    const tx = -s * (u - 0.5) * SCENE_W
    const ty = -s * (v - 0.5) * SCENE_H
    return `translate(${tx}px, ${ty}px) scale(${s})`
  }, [coverScale, focusRoomId])

  // Group agents per room so co-located tokens fan out into a ring.
  const placed = useMemo(() => {
    const byRoom = new Map<string, Agent[]>()
    for (const a of agents) {
      const list = byRoom.get(a.deptId)
      if (list) list.push(a)
      else byRoom.set(a.deptId, [a])
    }
    const out: Array<{ agent: Agent; x: number; y: number }> = []
    for (const [roomId, list] of byRoom) {
      list.forEach((agent, i) => out.push({ agent, ...seatPosition(roomId, i, list.length) }))
    }
    return out
  }, [agents])

  return (
    <div className="tac-viewport" ref={viewportRef}>
      <div className="tac-camera" ref={cameraRef}>
        <div
          className={`tac-scene${ready ? ' ready' : ''}`}
          style={{ width: SCENE_W, height: SCENE_H, transform: sceneTransform }}
        >
          {/* Fixed-size scene inside a transformed camera — next/image's
              responsive sizing would fight the transform math for nothing. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="tac-backdrop" src="/art/office-backdrop.webp" alt="" width={SCENE_W} height={SCENE_H} />
          <div className="tac-light" />
          <div className="tac-sweep" />

          <DeptLabels onPickRoom={onSelectRoom} />

          {pulses.map((p) => (
            <span key={p.key} className="tac-pulse" style={{ left: p.x, top: p.y }} />
          ))}

          {placed.map(({ agent, x, y }) => (
            <button
              key={agent.id}
              type="button"
              className={
                'tac-agent' +
                (agent.anim === 'type' ? ' busy' : '') +
                (agent.id === selectedId ? ' selected' : '')
              }
              style={{
                left: x,
                top: y,
                backgroundImage: `url(/art/agent-token-${tokenIndexFor(agent.id)}.webp)`,
              }}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(agent)
              }}
              title={agent.status || agent.role}
            >
              <span className="tac-tag">
                {agent.name}
                {agent.rank === 'lead' ? <em>lead</em> : null}
                {agent.rank === 'ceo' ? <em>owner</em> : null}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="tac-hud">
        <span className="tac-brand">
          HAND<em>SEL</em> · OFFICE
        </span>
        <span className={`tac-live ${healthy ? '' : 'degraded'}`}>
          <span className="tac-dot" /> {healthy ? 'LIVE' : 'LINK DEGRADED'}
        </span>
      </div>

      {feed.length > 0 && (
        <div className="tac-feed">
          {feed.map((row) => (
            <div key={row.key} className={`tac-row ${row.tone}`}>
              <b>{row.who}</b> {row.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
