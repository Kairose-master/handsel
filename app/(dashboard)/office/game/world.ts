/**
 * Office world map — tile grid layout, ported from the reference pixel-office
 * engine. 0 = walkable, 1 = blocked (wall/furniture).
 *
 * Room identities come from `lib/office-world-data.ts`'s OFFICE_DEPARTMENTS —
 * the nine FUNCTIONAL rooms (lib/office-functional-departments.ts): what an
 * agent is doing, not its status. A 3x3 grid, one cell per room, replaces the
 * previous 4x3 = 12 status-bucket layout. The old MEETING_ROOM ("결재" —
 * approval line, a bespoke bench layout for the reviewTier chain) is gone as
 * a separate fixed room: peer review of every kind — approval chains
 * included — now lives inside the generated Verification Court cell, so
 * there is exactly one room per function instead of one generated grid plus
 * a hand-placed extra for the same concept.
 */
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'

export const TILE = 18
export const COLS = 78
export const ROWS = 66
export const WORLD_W = COLS * TILE
export const WORLD_H = ROWS * TILE

export type Pt = { x: number; y: number }
export type RoomKind = 'dept' | 'ceo' | 'lounge'

export type Desk = { deskX: number; deskY: number; seat: Pt }

export type Room = {
  id: string
  name: string
  short: string
  icon: string
  kind: RoomKind
  x: number
  y: number
  w: number
  h: number
  doors: Pt[]
  desks: Desk[]
  loiter: Pt[]
}

// 3x3 — one cell per functional department (FUNCTIONAL_DEPARTMENTS has
// exactly nine entries; tests/office-functional-departments.test.ts pins
// that count, so this grid and the taxonomy it renders cannot silently
// drift apart in count).
const COL_X = [2, 28, 54]
const ROW_Y = [16, 33, 50]
const DEPT_W = 22
const DEPT_H = 14

function deptRoom(index: number): Room {
  const meta = OFFICE_DEPARTMENTS[index]
  const x = COL_X[index % 3]
  const y = ROW_Y[Math.floor(index / 3)]
  const desks: Desk[] = [4, 10, 16].map((dx) => ({
    deskX: x + dx - 1,
    deskY: y + 6,
    seat: { x: x + dx, y: y + 7 },
  }))
  return {
    id: meta.id,
    name: meta.name,
    short: meta.short,
    icon: meta.icon,
    kind: 'dept',
    x,
    y,
    w: DEPT_W,
    h: DEPT_H,
    doors: [
      { x: x + 10, y },
      { x: x + 11, y },
    ],
    desks,
    loiter: [
      { x: x + 2, y: y + 10 },
      { x: x + 7, y: y + 10 },
      { x: x + 14, y: y + 10 },
      { x: x + 19, y: y + 4 },
    ],
  }
}

export const CEO_ROOM: Room = {
  id: 'ceo',
  name: 'Owner',
  short: 'owner.office',
  icon: '🏢',
  kind: 'ceo',
  x: 2,
  y: 2,
  w: 35,
  h: 12,
  doors: [
    { x: 18, y: 13 },
    { x: 19, y: 13 },
  ],
  desks: [{ deskX: 18, deskY: 6, seat: { x: 20, y: 5 } }],
  loiter: [
    { x: 8, y: 10 },
    { x: 15, y: 10 },
    { x: 25, y: 10 },
    { x: 30, y: 8 },
  ],
}

// Idle really is a room in this diorama, and that is deliberate: an agent
// between functions is not "in" any of the nine departments — see
// lib/office-functional-departments.ts's departmentFor(), whose unmatched
// case returns `deptId: null` rather than guessing one. This is where
// `null` renders. It is the one room nothing derives a function from.
export const LOUNGE_ROOM: Room = {
  id: 'lounge',
  name: 'Idle',
  short: 'lounge.idle',
  icon: '☕',
  kind: 'lounge',
  x: 41,
  y: 2,
  w: 35,
  h: 12,
  doors: [
    { x: 57, y: 13 },
    { x: 58, y: 13 },
  ],
  desks: [],
  loiter: [
    { x: 45, y: 7 },
    { x: 49, y: 7 },
    { x: 53, y: 7 },
    { x: 60, y: 10 },
    { x: 66, y: 6 },
    { x: 71, y: 8 },
  ],
}

export const CEO_REPORT_SPOT: Pt = { x: 20, y: 9 }
export const CEO_SEAT: Pt = { x: 20, y: 5 }
export const ENTRANCE: Pt = { x: 39, y: 65 }

export const DEPT_ROOMS: Room[] = OFFICE_DEPARTMENTS.map((_, i) => deptRoom(i))
export const ROOMS: Room[] = [CEO_ROOM, LOUNGE_ROOM, ...DEPT_ROOMS]

export type Prop = {
  kind: 'desk' | 'monitor' | 'table' | 'sofa' | 'coffee' | 'plant' | 'shelf' | 'screen' | 'ceo-desk' | 'rug' | 'cabinet' | 'whiteboard'
  x: number
  y: number
  w: number
  h: number
  label?: string
}

export const PROPS: Prop[] = []

for (const room of DEPT_ROOMS) {
  for (const desk of room.desks) {
    PROPS.push({ kind: 'desk', x: desk.deskX, y: desk.deskY, w: 3, h: 1 })
  }
  PROPS.push({ kind: 'shelf', x: room.x + 1, y: room.y + 1, w: 3, h: 1 })
  PROPS.push({ kind: 'plant', x: room.x + 13, y: room.y + 1, w: 1, h: 1 })
  PROPS.push({ kind: 'cabinet', x: room.x + 12, y: room.y + 8, w: 2, h: 1 })
}

PROPS.push({ kind: 'ceo-desk', x: 18, y: 6, w: 5, h: 2 })
PROPS.push({ kind: 'rug', x: 17, y: 9, w: 7, h: 3 })
PROPS.push({ kind: 'plant', x: 4, y: 4, w: 1, h: 1 })
PROPS.push({ kind: 'plant', x: 34, y: 4, w: 1, h: 1 })

PROPS.push({ kind: 'sofa', x: 45, y: 5, w: 5, h: 1 })
PROPS.push({ kind: 'table', x: 60, y: 8, w: 3, h: 2 })
PROPS.push({ kind: 'coffee', x: 66, y: 4, w: 3, h: 1, label: '☕' })
PROPS.push({ kind: 'plant', x: 72, y: 11, w: 1, h: 1 })
PROPS.push({ kind: 'plant', x: 43, y: 11, w: 1, h: 1 })

function buildGrid(): Uint8Array {
  const grid = new Uint8Array(COLS * ROWS)

  const block = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return
    grid[y * COLS + x] = 1
  }

  for (let x = 0; x < COLS; x += 1) {
    block(x, 0)
    block(x, ROWS - 1)
  }
  for (let y = 0; y < ROWS; y += 1) {
    block(0, y)
    block(COLS - 1, y)
  }

  for (const room of ROOMS) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      block(x, room.y)
      block(x, room.y + room.h - 1)
    }
    for (let y = room.y; y < room.y + room.h; y += 1) {
      block(room.x, y)
      block(room.x + room.w - 1, y)
    }
  }

  for (const prop of PROPS) {
    if (prop.kind === 'rug') continue
    for (let y = prop.y; y < prop.y + prop.h; y += 1) {
      for (let x = prop.x; x < prop.x + prop.w; x += 1) block(x, y)
    }
  }

  for (const room of ROOMS) {
    for (const door of room.doors) grid[door.y * COLS + door.x] = 0
  }
  grid[ENTRANCE.y * COLS + ENTRANCE.x] = 0
  grid[ENTRANCE.y * COLS + ENTRANCE.x + 1] = 0

  return grid
}

export const GRID = buildGrid()

export function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false
  return GRID[y * COLS + x] === 0
}

export function roomOf(id: string): Room {
  const room = ROOMS.find((r) => r.id === id)
  if (!room) throw new Error(`unknown room: ${id}`)
  return room
}

export function doorApproach(room: Room): Pt {
  const door = room.doors[0]
  return door.y === room.y ? { x: door.x, y: door.y - 1 } : { x: door.x, y: door.y + 1 }
}
