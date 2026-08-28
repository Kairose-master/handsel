import { describe, it, expect } from 'vitest'
import { ROOMS, DEPT_ROOMS, GRID, COLS, ROWS, ENTRANCE, walkable, roomOf, doorApproach, type Room } from '@/app/(dashboard)/office/game/world'
import { findPath } from '@/app/(dashboard)/office/game/pathfinding'
import { FUNCTIONAL_DEPARTMENTS } from '@/lib/office-functional-departments'

/**
 * The office-redesign PR replaced a 4x3=12 status-bucket grid with a 3x3=9
 * functional-department grid, removed the separate hardcoded MEETING_ROOM,
 * and resized the world. None of that has a DB or a browser to check it —
 * it's pure tile-grid math — so it gets a real test instead of a screenshot:
 * every room reachable, no two overlapping, doors actually in the wall.
 */
describe('office world grid — layout invariants', () => {
  it('has one dept room per functional department, plus the owner and idle rooms', () => {
    expect(DEPT_ROOMS).toHaveLength(FUNCTIONAL_DEPARTMENTS.length)
    expect(ROOMS).toHaveLength(FUNCTIONAL_DEPARTMENTS.length + 2) // + ceo + lounge
  })

  it('every dept room id matches a real functional department id', () => {
    const ids = new Set(FUNCTIONAL_DEPARTMENTS.map((d) => d.id))
    for (const room of DEPT_ROOMS) expect(ids.has(room.id as never)).toBe(true)
  })

  it('has no room named after the old status taxonomy', () => {
    const banned = ['mining', 'disputed', 'reviewing', 'delegating', 'settled', 'governance', 'external', 'template', 'erc8004', 'capable', 'meeting']
    for (const room of ROOMS) expect(banned).not.toContain(room.id)
  })

  it('GRID is sized exactly COLS x ROWS', () => {
    expect(GRID.length).toBe(COLS * ROWS)
  })

  it('no two rooms overlap in tile space', () => {
    const rectOf = (r: Room) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })
    for (let i = 0; i < ROOMS.length; i += 1) {
      for (let j = i + 1; j < ROOMS.length; j += 1) {
        const a = rectOf(ROOMS[i])
        const b = rectOf(ROOMS[j])
        const overlaps = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
        expect(overlaps, `${ROOMS[i].id} overlaps ${ROOMS[j].id}`).toBe(false)
      }
    }
  })

  it('every room fits inside the world bounds', () => {
    for (const room of ROOMS) {
      expect(room.x).toBeGreaterThanOrEqual(0)
      expect(room.y).toBeGreaterThanOrEqual(0)
      expect(room.x + room.w).toBeLessThan(COLS)
      expect(room.y + room.h).toBeLessThan(ROWS)
    }
  })

  it('every room door sits ON that room\'s own wall', () => {
    for (const room of ROOMS) {
      for (const door of room.doors) {
        const onTopOrBottomWall = (door.y === room.y || door.y === room.y + room.h - 1) && door.x >= room.x && door.x < room.x + room.w
        const onLeftOrRightWall = (door.x === room.x || door.x === room.x + room.w - 1) && door.y >= room.y && door.y < room.y + room.h
        expect(onTopOrBottomWall || onLeftOrRightWall, `${room.id} door (${door.x},${door.y})`).toBe(true)
      }
    }
  })

  it('ENTRANCE is walkable', () => {
    expect(walkable(ENTRANCE.x, ENTRANCE.y)).toBe(true)
    expect(walkable(ENTRANCE.x + 1, ENTRANCE.y)).toBe(true)
  })

  it('every room is reachable from the entrance by A*', () => {
    for (const room of ROOMS) {
      const target = doorApproach(room)
      const path = findPath(ENTRANCE, target)
      const alreadyThere = ENTRANCE.x === target.x && ENTRANCE.y === target.y
      expect(path.length > 0 || alreadyThere, `no path from entrance to ${room.id}`).toBe(true)
    }
  })

  it('every desk and loiter spot in every dept room is itself walkable', () => {
    // A seat that findPath can never reach would silently strand any agent
    // routed to it (live-engine.ts snaps and idles rather than crashing, but
    // that is exactly the kind of degraded-and-invisible failure this repo's
    // failure-modes doc warns about).
    for (const room of DEPT_ROOMS) {
      for (const desk of room.desks) expect(walkable(desk.seat.x, desk.seat.y), `${room.id} desk seat`).toBe(true)
      for (const spot of room.loiter) expect(walkable(spot.x, spot.y), `${room.id} loiter spot`).toBe(true)
    }
  })

  it('roomOf resolves every functional department id', () => {
    for (const dept of FUNCTIONAL_DEPARTMENTS) {
      expect(() => roomOf(dept.id)).not.toThrow()
    }
  })
})
