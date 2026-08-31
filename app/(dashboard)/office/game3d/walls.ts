/**
 * Wall geometry, as data.
 *
 * Two problems with how the deck used to be built, both visible in one
 * glance at the reference renders this scene is aimed at:
 *
 * **The walls were knee-high.** 1.3 world units against a 0.62 desk — a pen,
 * not a room. The renders read as building interiors because their walls are
 * roughly four desk-heights tall, the openings are real doorways cut through
 * something solid, and the near side is CUT AWAY so you can look in. A short
 * wall needs no cutaway, which is exactly why the scene had none, and why it
 * read as a floor plan with furniture standing on it.
 *
 * **One box per boundary tile.** ~750 meshes for eleven rooms, every one of
 * them a separate draw call, and every corner two boxes deep. A wall is a
 * RUN of adjacent tiles broken only where a door is; expressing it that way
 * collapses those 750 meshes to about 70 and — the actual point — makes a
 * wall a thing you can put a cap and a light strip on without tripling the
 * mesh count again.
 *
 * So: runs, not tiles, and a height that depends on which way the wall
 * faces. Pure functions with no three.js in them, because the interesting
 * part (which tiles are wall, where the doors break them, how tall a wall
 * facing the camera should be) is arithmetic and belongs under test rather
 * than under a screenshot.
 */
import type { Room } from '../game/world'

/** Full height, in tiles. Bounded by the gaps BETWEEN rooms, not by taste:
 *  at the fixed isometric elevation a wall of height H hides ground for
 *  about 0.74·H tiles behind it, and the tightest gap in `world.ts` is the
 *  two tiles between the owner's office and the first department row. 2.6
 *  keeps that reach under two tiles, so no room's far wall can ever eat the
 *  room behind it. Raising this without re-checking that is how a diorama
 *  turns into a wall of boxes. */
export const WALL_H = 2.6
/** What a wall between the viewer and the room it encloses drops to. Not
 *  zero: the reference cutaways leave a curb, which is what stops a room
 *  from bleeding into its neighbour and gives the floor an edge to end on. */
export const WALL_CUT_H = 0.42
/** Wall thickness. Just under a tile, because the collision grid blocks the
 *  whole boundary tile and a wall thinner than its own footprint reads as
 *  scenery rather than structure. */
export const WALL_T = 0.94
/** The lighter coping along the top of a full-height wall. */
export const WALL_CAP_T = 0.1

export type WallSide = 'n' | 's' | 'e' | 'w'

export type WallRun = {
  side: WallSide
  /** Centre of the run, in world units. */
  x: number
  z: number
  /** How many tiles long. */
  length: number
  /** True for the north/south runs, which extend along X. */
  alongX: boolean
}

/** Outward-pointing normal of a side, in the XZ plane. */
export function sideNormal(side: WallSide): [x: number, z: number] {
  switch (side) {
    case 'n':
      return [0, -1]
    case 's':
      return [0, 1]
    case 'w':
      return [-1, 0]
    case 'e':
      return [1, 0]
  }
}

function runsAlong(from: number, to: number, isDoor: (i: number) => boolean): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let start: number | null = null
  for (let i = from; i <= to; i += 1) {
    if (isDoor(i)) {
      if (start !== null) {
        out.push({ start, end: i - 1 })
        start = null
      }
    } else if (start === null) {
      start = i
    }
  }
  if (start !== null) out.push({ start, end: to })
  return out
}

/**
 * Every unbroken stretch of wall around a room.
 *
 * Corners belong to the north and south runs, so the east and west sides
 * span only the tiles between them — the same convention the per-tile
 * version used, kept because it is what stops a corner being drawn twice
 * and darkening under SSAO.
 */
export function wallRuns(room: Room): WallRun[] {
  const doors = new Set(room.doors.map((d) => `${d.x},${d.y}`))
  const north = room.y
  const south = room.y + room.h - 1
  const west = room.x
  const east = room.x + room.w - 1
  const out: WallRun[] = []

  for (const [side, z] of [
    ['n', north],
    ['s', south],
  ] as const) {
    for (const run of runsAlong(west, east, (x) => doors.has(`${x},${z}`))) {
      out.push({
        side,
        x: (run.start + run.end + 1) / 2,
        z: z + 0.5,
        length: run.end - run.start + 1,
        alongX: true,
      })
    }
  }

  for (const [side, x] of [
    ['w', west],
    ['e', east],
  ] as const) {
    for (const run of runsAlong(north + 1, south - 1, (y) => doors.has(`${x},${y}`))) {
      out.push({
        side,
        x: x + 0.5,
        z: (run.start + run.end + 1) / 2,
        length: run.end - run.start + 1,
        alongX: false,
      })
    }
  }

  return out
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * How tall this wall should stand, given where the camera is looking.
 *
 * `facing` is the dot product of the wall's outward normal with the camera's
 * forward direction. Negative means the wall's outside is turned toward the
 * viewer — it stands between them and the room, so it drops to a curb.
 *
 * Smoothstepped rather than switched, because the deck turns in damped
 * quarter-turns and a boolean would slam every wall on the deck up or down
 * in one frame halfway through the spin. Over the narrow band around zero
 * the walls rise as they rotate out of the way, which is the read the
 * reference cutaways get for free by being a still image.
 */
export function wallHeightFor(facing: number): number {
  return WALL_CUT_H + (WALL_H - WALL_CUT_H) * smoothstep(facing, -0.12, 0.12)
}

/** Whether a wall this tall is still tall enough to hang something on. */
export function wallCarriesDecor(height: number): boolean {
  return height > 1.3
}
