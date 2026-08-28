/**
 * Pure logic behind semantic zoom (OfficeWorld.tsx) — extracted so the
 * "which room is the camera pointed at, and what does a room's badge say"
 * rules are testable without a browser, a canvas, or React.
 */
import type { Agent } from './live-engine'

const isRealRoom = (deptId: string) => deptId !== 'lounge' && deptId !== 'ceo'

/** Whichever functional department currently has the most people standing
 *  in it. `null` when nobody is anywhere but the lounge/owner's office — a
 *  live fact about the roster, never a fallback guess. */
export function hotRoomOf(agents: ReadonlyArray<Pick<Agent, 'deptId'>>): string | null {
  const counts = new Map<string, number>()
  for (const a of agents) {
    if (!isRealRoom(a.deptId)) continue
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
}

export type RoomStat = { count: number; alert: boolean }

/** Per-room occupant count and whether anything in it is a real disputed
 *  job (lib/office-functional-departments.ts's own "A job is in dispute —
 *  under adjudication." status line) — the far-zoom badge's two numbers.
 *  `alert` is never inferred from anything softer than that exact real
 *  status; a room with people in it but nothing disputed is never flagged. */
export function roomStatsOf(agents: ReadonlyArray<Pick<Agent, 'deptId' | 'status'>>): Map<string, RoomStat> {
  const stats = new Map<string, RoomStat>()
  for (const a of agents) {
    if (!isRealRoom(a.deptId)) continue
    const s = stats.get(a.deptId) ?? { count: 0, alert: false }
    s.count += 1
    if (/dispute/i.test(a.status)) s.alert = true
    stats.set(a.deptId, s)
  }
  return stats
}

/**
 * What 'close' zoom centers on. Priority: the selected AGENT's current room
 * (an agent walks between rooms as its function changes, so this is the
 * agent's live position, not wherever it happened to be selected) beats the
 * selected ROOM beats the hot room — so 'close' means something even before
 * anything has ever been clicked.
 */
export function closeRoomIdFor(params: {
  selectedId: string | null
  selectedRoomId: string | null
  agents: ReadonlyArray<Pick<Agent, 'id' | 'deptId'>>
  hotRoom: string | null
}): string | null {
  if (params.selectedId) {
    const agent = params.agents.find((a) => a.id === params.selectedId)
    if (agent) return agent.deptId
  }
  return params.selectedRoomId ?? params.hotRoom
}
