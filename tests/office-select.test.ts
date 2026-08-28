import { describe, it, expect } from 'vitest'
import { screenToWorld, screenBoxToWorldBox, agentsInWorldBox, selectionSummary, MIN_SELECT_BOX_PX } from '@/app/(dashboard)/office/game/select'
import { TILE } from '@/app/(dashboard)/office/game/world'

describe('screenToWorld', () => {
  it('the viewport center maps to the camera position, at any scale', () => {
    const cam = { x: 500, y: 300, scale: 2 }
    expect(screenToWorld(400, 200, 800, 400, cam)).toEqual({ x: 500, y: 300 })
  })

  it('scales the offset from center by 1/cam.scale', () => {
    const cam = { x: 0, y: 0, scale: 2 }
    // 100px right of center at 2x zoom is 50 world px from the camera.
    expect(screenToWorld(400 + 100, 200, 800, 400, cam)).toEqual({ x: 50, y: 0 })
  })

  it('is the exact inverse of the paint loop\'s forward transform', () => {
    // Forward (OfficeWorld.tsx's paint loop): ox = viewportW/2 - cam.x*scale;
    // screenX = ox + worldX*scale. Round-tripping a world point through the
    // forward transform and back must return the same point.
    const cam = { x: 137, y: -42, scale: 0.73 }
    const viewportW = 913
    const viewportH = 511
    const worldX = 284
    const worldY = 66
    const ox = viewportW / 2 - cam.x * cam.scale
    const oy = viewportH / 2 - cam.y * cam.scale
    const screenX = ox + worldX * cam.scale
    const screenY = oy + worldY * cam.scale
    const back = screenToWorld(screenX, screenY, viewportW, viewportH, cam)
    expect(back.x).toBeCloseTo(worldX, 6)
    expect(back.y).toBeCloseTo(worldY, 6)
  })
})

describe('screenBoxToWorldBox', () => {
  const cam = { x: 0, y: 0, scale: 1 }

  it('normalizes min/max regardless of drag direction', () => {
    const forward = screenBoxToWorldBox({ x0: 100, y0: 100, x1: 300, y1: 300 }, 800, 400, cam)
    const backward = screenBoxToWorldBox({ x0: 300, y0: 300, x1: 100, y1: 100 }, 800, 400, cam)
    expect(forward).toEqual(backward)
    expect(forward.xmin).toBeLessThan(forward.xmax)
    expect(forward.ymin).toBeLessThan(forward.ymax)
  })
})

describe('agentsInWorldBox', () => {
  const agents = [
    { id: 'a1', x: 10, y: 10 }, // sprite point (10.5*T, 10.9*T)
    { id: 'a2', x: 20, y: 20 },
    { id: 'a3', x: 30, y: 30 },
  ]

  it('picks up exactly the agents whose sprite point falls inside the box', () => {
    const box = { xmin: 0, xmax: 15 * TILE, ymin: 0, ymax: 15 * TILE }
    expect(agentsInWorldBox(agents, box)).toEqual(['a1'])
  })

  it('an empty box selects nobody', () => {
    const box = { xmin: 1000, xmax: 1001, ymin: 1000, ymax: 1001 }
    expect(agentsInWorldBox(agents, box)).toEqual([])
  })

  it('a box spanning everyone selects everyone, in roster order', () => {
    const box = { xmin: 0, xmax: 1000, ymin: 0, ymax: 1000 }
    expect(agentsInWorldBox(agents, box)).toEqual(['a1', 'a2', 'a3'])
  })

  it('uses the exact sprite point the paint loop draws at, not the raw tile x/y', () => {
    // A box that stops just short of (x+0.5)*TILE must exclude the agent —
    // proves this reads the actual drawn position, not a rounded tile cell.
    const spriteX = (10 + 0.5) * TILE
    const justShort = { xmin: 0, xmax: spriteX - 1, ymin: 0, ymax: 1000 }
    expect(agentsInWorldBox([agents[0]], justShort)).toEqual([])
    const justEnough = { xmin: 0, xmax: spriteX, ymin: 0, ymax: 1000 }
    expect(agentsInWorldBox([agents[0]], justEnough)).toEqual(['a1'])
  })
})

describe('MIN_SELECT_BOX_PX', () => {
  it('is bigger than the existing 4px click-vs-drag threshold', () => {
    // A selection gesture is a bigger, more deliberate motion than a pick —
    // this must not fire on the same jitter that already counts as a click.
    expect(MIN_SELECT_BOX_PX).toBeGreaterThan(4)
  })
})

describe('selectionSummary', () => {
  it('counts total and breaks down by department', () => {
    const s = selectionSummary([{ deptId: 'research' }, { deptId: 'research' }, { deptId: 'engineering' }])
    expect(s.count).toBe(3)
    expect(s.byDept.get('research')).toBe(2)
    expect(s.byDept.get('engineering')).toBe(1)
  })

  it('an empty selection summarizes to zero, not a missing value', () => {
    const s = selectionSummary([])
    expect(s.count).toBe(0)
    expect(s.byDept.size).toBe(0)
  })

  it('lounge and ceo are counted like any other department — no special-casing', () => {
    // Unlike hotRoomOf/roomStatsOf (which deliberately exclude these because
    // they answer "which functional room is busiest"), a group summary must
    // account for every agent actually selected, wherever it's standing.
    const s = selectionSummary([{ deptId: 'lounge' }, { deptId: 'ceo' }])
    expect(s.count).toBe(2)
    expect(s.byDept.get('lounge')).toBe(1)
    expect(s.byDept.get('ceo')).toBe(1)
  })
})
