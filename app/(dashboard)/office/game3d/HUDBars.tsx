'use client'

/**
 * Top/bottom telemetry bars — the tactical-command-center HUD framing the
 * 3D scene. Every number here is a real, already-computed signal; nothing
 * is invented to fill a slot the way a decorative mockup would (no CPU/
 * memory gauges — this platform has no such metric, so there is no "system
 * metrics" row pretending otherwise). `roomStatsOf` is the same pure
 * function `zoom.ts`'s far-zoom room badges already call — one source of
 * truth for "how many, and is anything alerting" reused a third time.
 */
import { useEffect, useState } from 'react'
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'
import { roomStatsOf } from '../game/zoom'
import type { Agent } from '../game/live-engine'
import type { ArtifactFlight } from '@/lib/office-world-data'

function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now.toLocaleTimeString('en-US', { hour12: false })
}

export function TopStatusBar({ healthy }: { healthy: boolean }) {
  const clock = useClock()
  return (
    <div className="hud3d-top">
      <span className="hud3d-brand">HANDSEL // OFFICE DECK</span>
      <span className="hud3d-status">
        <i className={`hud3d-dot${healthy ? '' : ' down'}`} />
        {healthy ? 'OPERATIONAL' : 'LINK DEGRADED'}
        <span className="hud3d-clock">{clock}</span>
      </span>
    </div>
  )
}

export function BottomTelemetryBar({ agents, flights }: { agents: Agent[]; flights: ArtifactFlight[] }) {
  const stats = roomStatsOf(agents)
  const active = OFFICE_DEPARTMENTS.map((d) => ({ ...d, stat: stats.get(d.id) })).filter((d) => d.stat && d.stat.count > 0)
  const alerts = active.filter((d) => d.stat!.alert).length

  return (
    <div className="hud3d-bottom">
      <div className="hud3d-stat">
        <span className="hud3d-label">AGENTS</span>
        <span className="hud3d-value">{agents.length}</span>
      </div>
      <div className="hud3d-depts">
        {active.length === 0 ? (
          <span className="hud3d-empty">[ NO ACTIVE FUNCTIONS ]</span>
        ) : (
          active.map((d) => (
            <span key={d.id} className={`hud3d-chip${d.stat!.alert ? ' alert' : ''}`}>
              {d.icon} {d.short.split('.')[0].toUpperCase()} <b>{d.stat!.count}</b>
            </span>
          ))
        )}
      </div>
      <div className="hud3d-stat">
        <span className="hud3d-label">FLIGHTS</span>
        <span className="hud3d-value">{flights.length}</span>
      </div>
      <div className={`hud3d-stat${alerts > 0 ? ' alert' : ''}`}>
        <span className="hud3d-label">ALERTS</span>
        <span className="hud3d-value">{alerts}</span>
      </div>
    </div>
  )
}
