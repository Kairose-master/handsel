/**
 * Live office engine — the real-data replacement for the reference toy's
 * scripted single-day generator (see world.ts's header for why that had to
 * go). No phases, no script, no fixed clock: this holds a roster of agents,
 * and on each `applySnapshot` (called from a poll of real Handsel state) it
 * re-targets whichever agents' rooms changed. `tick` just advances anyone
 * who isn't at their target room yet, one frame at a time, along an A*
 * path — the SAME movement primitives the reference engine used, driving
 * real positions instead of a script's.
 */
import { findPath } from './pathfinding'
import { CEO_SEAT, MEETING_SEATS, doorApproach, roomOf, type Pt } from './world'
import { colorsFor, type OfficeSnapshot } from '@/lib/office-world-data'

export type Facing = 'up' | 'down' | 'left' | 'right'
export type Anim = 'idle' | 'walk' | 'type' | 'sit'

export type Agent = {
  id: string
  name: string
  role: string
  deptId: string // room id this agent is CURRENTLY targeting/occupying
  rank: 'lead' | 'member' | 'ceo'
  hair: string
  shirt: string
  accent: string
  skin: string

  x: number
  y: number
  facing: Facing
  anim: Anim
  status: string
  progress: number

  speech: string | null
  speechKind: 'talk' | 'think'

  path: Pt[]
  pathIdx: number
  jitter: number
}

const WALK_SPEED = 3.6 // tiles/sec, matches the reference engine's feel

const SKIN = ['#ffdcc4', '#f7cdae', '#ffe3cf', '#eec39f']

function seatFor(roomId: string, slot: number): Pt {
  const room = roomOf(roomId)
  if (roomId === 'meeting') return MEETING_SEATS[slot % MEETING_SEATS.length]
  if (roomId === 'ceo') return CEO_SEAT
  const desks = room.desks
  if (desks.length > 0) return desks[slot % desks.length].seat
  if (room.loiter.length > 0) return room.loiter[slot % room.loiter.length]
  return doorApproach(room)
}

function facingFor(dx: number, dy: number): Facing {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  if (dy !== 0) return dy > 0 ? 'down' : 'up'
  return 'down'
}

/** Slot index per room, so agents in the same room don't stack on one seat. */
function nextSlot(seatTaken: Map<string, number>, roomId: string): number {
  const n = seatTaken.get(roomId) ?? 0
  seatTaken.set(roomId, n + 1)
  return n
}

export class LiveOffice {
  agents: Agent[] = []
  private byId = new Map<string, Agent>()

  /** Apply a fresh real snapshot: add new agents, retarget existing ones
   *  whose department changed, drop agents no longer present. */
  applySnapshot(snap: OfficeSnapshot): void {
    const seatTaken = new Map<string, number>()
    const wanted = new Set<string>()

    // CEO
    wanted.add('ceo')
    let ceo = this.byId.get('ceo')
    if (!ceo) {
      ceo = this.spawn('ceo', snap.ceoName, 'Owner', 'ceo', 'ceo', 0)
      this.agents.push(ceo)
      this.byId.set('ceo', ceo)
    }
    ceo.status = snap.ceoLine
    this.retarget(ceo, 'ceo', nextSlot(seatTaken, 'ceo'))

    snap.staff.forEach((member, i) => {
      wanted.add(member.id)
      const roomId = member.deptId ?? 'lounge'
      let a = this.byId.get(member.id)
      if (!a) {
        a = this.spawn(member.id, member.name, member.role, member.rank, roomId, i)
        this.agents.push(a)
        this.byId.set(member.id, a)
      }
      a.name = member.name
      a.role = member.role
      a.rank = member.rank
      a.status = member.statusLine
      a.speech = member.statusLine
      a.speechKind = 'think'
      this.retarget(a, roomId, nextSlot(seatTaken, roomId))
    })

    // Agents that dropped off the roster (deleted, or moved account) leave.
    for (const a of [...this.agents]) {
      if (!wanted.has(a.id)) {
        this.agents = this.agents.filter((x) => x.id !== a.id)
        this.byId.delete(a.id)
      }
    }
  }

  private spawn(id: string, name: string, role: string, rank: Agent['rank'], deptId: string, colorSeed: number): Agent {
    const [hair, shirt, accent] = colorsFor(colorSeed)
    const start = doorApproach(roomOf(ENTRANCE_ROOM_FOR(deptId)))
    return {
      id,
      name,
      role,
      deptId,
      rank,
      hair,
      shirt,
      accent,
      skin: SKIN[colorSeed % SKIN.length],
      x: start.x,
      y: start.y,
      facing: 'down',
      anim: 'idle',
      status: '',
      progress: 0,
      speech: null,
      speechKind: 'think',
      path: [],
      pathIdx: 0,
      jitter: (colorSeed % 5) * 0.05 - 0.1,
    }
  }

  /** Point the agent at a new seat if its target room changed (or it has no
   *  path yet, e.g. freshly spawned). Idempotent — reapplying the same room
   *  while mid-walk does not interrupt the walk. */
  private retarget(a: Agent, roomId: string, slot: number): void {
    const alreadyHeadedThere = a.deptId === roomId && (a.path.length > 0 || this.atSeat(a, roomId, slot))
    a.deptId = roomId
    if (alreadyHeadedThere) return
    const seat = seatFor(roomId, slot)
    const path = findPath({ x: a.x, y: a.y }, seat)
    if (path.length === 0) {
      // Already there, or unreachable — snap and idle rather than get stuck.
      a.x = seat.x
      a.y = seat.y
      a.anim = roomId === 'lounge' || roomId === 'meeting' ? 'idle' : 'sit'
      return
    }
    a.path = path
    a.pathIdx = 0
    a.anim = 'walk'
  }

  private atSeat(a: Agent, roomId: string, slot: number): boolean {
    const seat = seatFor(roomId, slot)
    return a.x === seat.x && a.y === seat.y
  }

  /** Advance walking agents by `dtSec`. Pure animation — no data decisions
   *  happen here, only motion toward whatever `applySnapshot` last set. */
  tick(dtSec: number): void {
    const step = WALK_SPEED * dtSec
    for (const a of this.agents) {
      if (a.path.length === 0 || a.pathIdx >= a.path.length) {
        if (a.anim === 'walk') a.anim = a.deptId === 'lounge' || a.deptId === 'meeting' ? 'idle' : 'sit'
        // Gentle "typing" flicker for agents actually mid-task, so a desk
        // doesn't look frozen — cosmetic only, does not affect deptId/status.
        if (a.anim === 'sit' && a.status && /job|review|delegation/i.test(a.status)) {
          a.anim = 'type'
          a.progress = (a.progress + dtSec * 0.15) % 1
        }
        continue
      }
      const target = a.path[a.pathIdx]
      const dx = target.x - a.x
      const dy = target.y - a.y
      const dist = Math.hypot(dx, dy)
      if (dist <= step) {
        a.x = target.x
        a.y = target.y
        a.pathIdx += 1
        if (dist > 0) a.facing = facingFor(dx, dy)
      } else {
        a.facing = facingFor(dx, dy)
        a.x += (dx / dist) * step
        a.y += (dy / dist) * step
      }
    }
  }
}

/** Every current room is reachable via a normal path once the office is
 *  built, so the "entrance room" is only used for a freshly-spawned agent's
 *  starting position — never walkable(false), which findPath would reject. */
function ENTRANCE_ROOM_FOR(_deptId: string): string {
  return 'lounge'
}
