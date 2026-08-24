/**
 * Office world map — tile grid layout, ported from the reference pixel-office
 * engine. 0 = walkable, 1 = blocked (wall/furniture).
 *
 * Room identities come from `lib/office-world-data.ts`'s OFFICE_DEPARTMENTS —
 * real Handsel states (working, reviewing, delegating, ...), not a fictional
 * company's org chart. The 4x3 = 12 fixed layout is inherited from the
 * reference engine; MEETING_ROOM ("결재" — approval) now genuinely maps onto
 * the reviewTier chain feature instead of a scripted meeting.
 */
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'

export const TILE = 18
export const COLS = 74
export const ROWS = 58
export const WORLD_W = COLS * TILE
export const WORLD_H = ROWS * TILE

export type Pt = { x: number; y: number }
export type RoomKind = 'dept' | 'ceo' | 'meeting' | 'lounge'

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

const COL_X = [2, 20, 38, 56]
const ROW_Y = [17, 31, 45]
const DEPT_W = 15
const DEPT_H = 11

function deptRoom(index: number): Room {
  const meta = OFFICE_DEPARTMENTS[index]
  const x = COL_X[index % 4]
  const y = ROW_Y[Math.floor(index / 4)]
  const desks: Desk[] = [3, 7, 11].map((dx) => ({
    deskX: x + dx - 1,
    deskY: y + 5,
    seat: { x: x + dx, y: y + 6 },
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
      { x: x + 7, y },
      { x: x + 8, y },
    ],
    desks,
    loiter: [
      { x: x + 1, y: y + 8 },
      { x: x + 5, y: y + 8 },
      { x: x + 9, y: y + 8 },
      { x: x + 13, y: y + 3 },
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
  w: 18,
  h: 12,
  doors: [
    { x: 10, y: 13 },
    { x: 11, y: 13 },
  ],
  desks: [{ deskX: 9, deskY: 6, seat: { x: 11, y: 5 } }],
  loiter: [
    { x: 8, y: 10 },
    { x: 11, y: 10 },
    { x: 14, y: 10 },
    { x: 6, y: 8 },
  ],
}

export const MEETING_ROOM: Room = {
  id: 'meeting',
  name: 'Approval line',
  short: 'review.hall',
  icon: '🖋️',
  kind: 'meeting',
  x: 23,
  y: 2,
  w: 26,
  h: 12,
  doors: [
    { x: 35, y: 13 },
    { x: 36, y: 13 },
  ],
  desks: [],
  loiter: [
    { x: 26, y: 10 },
    { x: 45, y: 10 },
  ],
}

export const LOUNGE_ROOM: Room = {
  id: 'lounge',
  name: 'Idle',
  short: 'lounge.idle',
  icon: '☕',
  kind: 'lounge',
  x: 52,
  y: 2,
  w: 20,
  h: 12,
  doors: [
    { x: 61, y: 13 },
    { x: 62, y: 13 },
  ],
  desks: [],
  loiter: [
    { x: 56, y: 7 },
    { x: 58, y: 7 },
    { x: 60, y: 7 },
    { x: 63, y: 10 },
    { x: 66, y: 6 },
    { x: 69, y: 8 },
  ],
}

export const MEETING_SEATS: Pt[] = [
  { x: 31, y: 5 },
  { x: 34, y: 5 },
  { x: 37, y: 5 },
  { x: 40, y: 5 },
  { x: 31, y: 9 },
  { x: 34, y: 9 },
  { x: 37, y: 9 },
  { x: 40, y: 9 },
]

export const CEO_REPORT_SPOT: Pt = { x: 11, y: 9 }
export const CEO_SEAT: Pt = { x: 11, y: 5 }
export const ENTRANCE: Pt = { x: 36, y: 57 }

export const DEPT_ROOMS: Room[] = OFFICE_DEPARTMENTS.map((_, i) => deptRoom(i))
export const ROOMS: Room[] = [CEO_ROOM, MEETING_ROOM, LOUNGE_ROOM, ...DEPT_ROOMS]

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

PROPS.push({ kind: 'ceo-desk', x: 9, y: 6, w: 5, h: 2 })
PROPS.push({ kind: 'rug', x: 8, y: 9, w: 7, h: 3 })
PROPS.push({ kind: 'plant', x: 4, y: 4, w: 1, h: 1 })
PROPS.push({ kind: 'plant', x: 17, y: 4, w: 1, h: 1 })

PROPS.push({ kind: 'table', x: 31, y: 6, w: 10, h: 3 })
PROPS.push({ kind: 'screen', x: 28, y: 3, w: 5, h: 1, label: 'REVIEW LINE' })
PROPS.push({ kind: 'whiteboard', x: 42, y: 3, w: 5, h: 1 })
PROPS.push({ kind: 'plant', x: 25, y: 11, w: 1, h: 1 })
PROPS.push({ kind: 'plant', x: 46, y: 11, w: 1, h: 1 })

PROPS.push({ kind: 'sofa', x: 56, y: 5, w: 5, h: 1 })
PROPS.push({ kind: 'table', x: 62, y: 8, w: 3, h: 2 })
PROPS.push({ kind: 'coffee', x: 66, y: 4, w: 3, h: 1, label: '☕' })
PROPS.push({ kind: 'plant', x: 70, y: 11, w: 1, h: 1 })
PROPS.push({ kind: 'plant', x: 53, y: 11, w: 1, h: 1 })

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
