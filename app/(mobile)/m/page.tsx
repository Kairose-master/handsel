'use client'

/**
 * /m — the mobile office. One full-screen tactical painted view with the
 * touch camera (drag to pan, pinch to zoom, tap to inspect), fed by the
 * SAME real snapshot poll as the desktop /office panel: myOfficeWorld
 * through LiveOffice, nothing invented for the small screen. m.<host>
 * rewrites here via middleware.ts, so this is what "m.handsel" opens on.
 *
 * Deliberately a viewer, not a console: hiring, wiring, storefronts and the
 * rest of the desk work stay on /office (linked below). A phone is where
 * you check on the office, not where you rewire it — the page carries
 * exactly the state that matters at a glance (who is where, what changed,
 * whether the link is healthy) and one tap of detail per agent or room.
 *
 * Slot 0 only for now: the first office is the one the mobile glance is
 * for. Multi-slot switching stays a desktop affordance until someone
 * actually asks for it on a phone.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import TacticalView from '@/app/(dashboard)/office/game/TacticalView'
import { LiveOffice, type Agent } from '@/app/(dashboard)/office/game/live-engine'
import type { Room } from '@/app/(dashboard)/office/game/world'
import { myOfficeWorld } from '@/app/actions/office'
import type { ArtifactFlight } from '@/lib/office-world-data'
import '@/app/(dashboard)/office/game/office-tactical.css'

const POLL_MS = 12_000
const SLOT = 0

export default function MobileOfficePage() {
  const engineRef = useRef(new LiveOffice())
  const [agents, setAgents] = useState<Agent[]>([])
  const [flights, setFlights] = useState<ArtifactFlight[]>([])
  const [ceoLine, setCeoLine] = useState('')
  const [healthy, setHealthy] = useState(true)
  const [selected, setSelected] = useState<Agent | null>(null)
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)

  useEffect(() => {
    let dead = false
    const poll = async () => {
      try {
        const snap = await myOfficeWorld(SLOT)
        if (dead) return
        engineRef.current.applySnapshot(snap)
        setAgents([...engineRef.current.agents])
        setFlights(snap.artifactFlights)
        setCeoLine(snap.ceoLine)
        setHealthy(true)
      } catch (error) {
        console.error('[m] snapshot poll failed:', error)
        if (!dead) setHealthy(false)
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => {
      dead = true
      clearInterval(interval)
    }
  }, [])

  // One detail card, one selection — same exclusivity rule as the desktop
  // panel, on a screen with room for exactly one card.
  const pickAgent = (agent: Agent) => {
    setSelectedRoom(null)
    setSelected(agent)
  }
  const pickRoom = (room: Room) => {
    setSelected(null)
    setSelectedRoom(room)
  }
  const clear = () => {
    setSelected(null)
    setSelectedRoom(null)
  }

  return (
    <div className="fixed inset-0 bg-[#070a0f]">
      <TacticalView
        agents={agents}
        selectedId={selected?.id ?? null}
        selectedRoomId={selectedRoom?.id ?? null}
        onSelect={pickAgent}
        onSelectRoom={pickRoom}
        flights={flights}
        healthy={healthy}
      />

      {(selected || selectedRoom) && (
        <div className="absolute inset-x-3 bottom-3 z-10 rounded-xl border border-[#1e2c3a] bg-[#0d151d]/95 p-4 text-sm text-[#dff4ff] backdrop-blur">
          <button
            type="button"
            onClick={clear}
            aria-label="Close details"
            className="absolute right-3 top-3 text-[#7f97ab]"
          >
            ✕
          </button>
          {selected && (
            <>
              <div className="font-semibold">
                {selected.name}
                <span className="ml-2 text-xs uppercase tracking-wider text-[#4fd8ff]">
                  {selected.rank === 'ceo' ? 'owner' : selected.rank}
                </span>
              </div>
              <div className="text-xs text-[#7f97ab]">{selected.role}</div>
              <div className="mt-1 text-[#7f97ab]">{selected.status || 'Idle.'}</div>
            </>
          )}
          {selectedRoom && (
            <>
              <div className="font-semibold">
                {selectedRoom.icon} {selectedRoom.name}
              </div>
              <div className="mt-1 text-[#7f97ab]">
                {agents.filter((a) => a.deptId === selectedRoom.id).length} here right now.
              </div>
            </>
          )}
        </div>
      )}

      {/* ceoLine doubles as the "is this my office" sanity line; the full
          console link is the only way off this surface on purpose. */}
      <div className="absolute inset-x-0 top-10 z-10 flex justify-center px-4">
        <div className="max-w-full truncate rounded-full border border-[#1e2c3a] bg-[#070a0f]/70 px-3 py-1 text-[11px] text-[#7f97ab] backdrop-blur">
          {ceoLine || 'Loading your agents…'}
          <Link href="/office" className="ml-2 text-[#4fd8ff]">
            full console →
          </Link>
        </div>
      </div>
    </div>
  )
}
