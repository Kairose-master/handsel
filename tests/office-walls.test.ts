import { describe, it, expect } from 'vitest'
import { ROOMS, type Room } from '@/app/(dashboard)/office/game/world'
import {
  WALL_H,
  WALL_CUT_H,
  sideNormal,
  wallRuns,
  wallHeightFor,
  wallCarriesDecor,
  type WallSide,
} from '@/app/(dashboard)/office/game3d/walls'

/** The tiles a run actually covers, back in tile coordinates. */
function tilesOf(run: ReturnType<typeof wallRuns>[number]): string[] {
  const out: string[] = []
  if (run.alongX) {
    const x0 = run.x - run.length / 2
    const z = Math.floor(run.z)
    for (let i = 0; i < run.length; i += 1) out.push(`${x0 + i},${z}`)
  } else {
    const z0 = run.z - run.length / 2
    const x = Math.floor(run.x)
    for (let i = 0; i < run.length; i += 1) out.push(`${x},${z0 + i}`)
  }
  return out
}

/** Every boundary tile of a room, the same set `buildGrid` blocks. */
function boundaryTiles(room: Room): Set<string> {
  const out = new Set<string>()
  for (let x = room.x; x < room.x + room.w; x += 1) {
    out.add(`${x},${room.y}`)
    out.add(`${x},${room.y + room.h - 1}`)
  }
  for (let y = room.y; y < room.y + room.h; y += 1) {
    out.add(`${room.x},${y}`)
    out.add(`${room.x + room.w - 1},${y}`)
  }
  return out
}

describe('wall runs', () => {
  it('covers exactly the boundary tiles that are not doors, for every room', () => {
    for (const room of ROOMS) {
      const doors = new Set(room.doors.map((d) => `${d.x},${d.y}`))
      const expected = new Set([...boundaryTiles(room)].filter((t) => !doors.has(t)))
      const covered = new Set(wallRuns(room).flatMap(tilesOf))
      expect(covered, room.id).toEqual(expected)
    }
  })

  it('never covers a tile twice — a doubled corner is a dark seam under SSAO', () => {
    for (const room of ROOMS) {
      const tiles = wallRuns(room).flatMap(tilesOf)
      expect(new Set(tiles).size, room.id).toBe(tiles.length)
    }
  })

  it('never walls up a door', () => {
    for (const room of ROOMS) {
      const covered = new Set(wallRuns(room).flatMap(tilesOf))
      for (const d of room.doors) expect(covered.has(`${d.x},${d.y}`), `${room.id} door`).toBe(false)
    }
  })

  it('is dramatically cheaper than one mesh per tile — the reason runs exist', () => {
    const tiles = ROOMS.reduce((n, r) => n + boundaryTiles(r).size, 0)
    const runs = ROOMS.reduce((n, r) => n + wallRuns(r).length, 0)
    expect(tiles).toBeGreaterThan(600)
    expect(runs).toBeLessThan(tiles / 6)
  })

  it('each room has runs on all four sides (no room is open-sided)', () => {
    for (const room of ROOMS) {
      const sides = new Set(wallRuns(room).map((r) => r.side))
      expect(sides, room.id).toEqual(new Set<WallSide>(['n', 's', 'e', 'w']))
    }
  })

  it('a doorway in the middle of a side splits that side into two runs', () => {
    // Every room in world.ts puts its two door tiles mid-side, so the side
    // carrying them is the only one that comes back as a pair.
    for (const room of ROOMS) {
      const doorZ = room.doors[0].y
      const side: WallSide = doorZ === room.y ? 'n' : 's'
      expect(wallRuns(room).filter((r) => r.side === side), room.id).toHaveLength(2)
    }
  })
})

describe('the cutaway', () => {
  const iso = (x: number, z: number) => {
    const len = Math.hypot(x, z)
    return [x / len, z / len] as const
  }

  it('drops a wall the viewer is looking through, and stands up the one behind it', () => {
    // Looking from +X/+Z toward the origin: the east and south walls are in
    // the way, the north and west ones are the backdrop.
    const [fx, fz] = iso(-1, -1)
    const facing = (s: WallSide) => {
      const [nx, nz] = sideNormal(s)
      return nx * fx + nz * fz
    }
    expect(wallHeightFor(facing('e'))).toBe(WALL_CUT_H)
    expect(wallHeightFor(facing('s'))).toBe(WALL_CUT_H)
    expect(wallHeightFor(facing('n'))).toBe(WALL_H)
    expect(wallHeightFor(facing('w'))).toBe(WALL_H)
  })

  it('swaps which walls are cut when the deck turns a quarter', () => {
    // Same rig, one quarter-turn on: now the camera is at +X/-Z.
    const [fx, fz] = iso(-1, 1)
    const facing = (s: WallSide) => {
      const [nx, nz] = sideNormal(s)
      return nx * fx + nz * fz
    }
    expect(wallHeightFor(facing('e'))).toBe(WALL_CUT_H)
    expect(wallHeightFor(facing('n'))).toBe(WALL_CUT_H)
    expect(wallHeightFor(facing('s'))).toBe(WALL_H)
    expect(wallHeightFor(facing('w'))).toBe(WALL_H)
  })

  it('passes through the middle rather than snapping, so a turn reads as walls rising', () => {
    const mid = wallHeightFor(0)
    expect(mid).toBeGreaterThan(WALL_CUT_H)
    expect(mid).toBeLessThan(WALL_H)
    // Monotonic across the band.
    for (let f = -0.2; f < 0.2; f += 0.01) {
      expect(wallHeightFor(f + 0.01)).toBeGreaterThanOrEqual(wallHeightFor(f))
    }
  })

  it('takes the panels off a wall before that wall is short enough to sink them', () => {
    expect(wallCarriesDecor(WALL_H)).toBe(true)
    expect(wallCarriesDecor(WALL_CUT_H)).toBe(false)
  })
})
