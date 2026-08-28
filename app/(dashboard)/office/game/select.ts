/**
 * Pure geometry and aggregation behind RTS-style box multi-select
 * (OfficeWorld.tsx) — screen-space drag rectangle → world-space agent hits,
 * and what a group of selected agents adds up to. No DOM, no camera object
 * with methods, no React: every input is a plain number or plain object, so
 * this is testable without a browser.
 */
import { TILE } from './world'
import type { Agent } from './live-engine'
import type { FunctionalDeptId } from '@/lib/office-functional-departments'

export type Cam = { x: number; y: number; scale: number }
export type ScreenBox = { x0: number; y0: number; x1: number; y1: number }
export type WorldBox = { xmin: number; xmax: number; ymin: number; ymax: number }

/** Convert one screen point (relative to the viewport's own top-left) into
 *  world pixels, inverting the exact transform the paint loop applies to
 *  the stage (`translate3d(rect.width/2 - cam.x*cam.scale, …) scale(cam.scale)`).
 *  A box-select must hit-test against what the camera is ACTUALLY showing at
 *  the moment of release, not a guessed or stale transform. */
export function screenToWorld(screenX: number, screenY: number, viewportW: number, viewportH: number, cam: Cam): { x: number; y: number } {
  return {
    x: (screenX - viewportW / 2) / cam.scale + cam.x,
    y: (screenY - viewportH / 2) / cam.scale + cam.y,
  }
}

/** A screen-space drag rectangle, converted to a normalized world-space box
 *  (min/max, not start/end — a box dragged bottom-right to top-left is the
 *  same box). */
export function screenBoxToWorldBox(box: ScreenBox, viewportW: number, viewportH: number, cam: Cam): WorldBox {
  const a = screenToWorld(box.x0, box.y0, viewportW, viewportH, cam)
  const b = screenToWorld(box.x1, box.y1, viewportW, viewportH, cam)
  return { xmin: Math.min(a.x, b.x), xmax: Math.max(a.x, b.x), ymin: Math.min(a.y, b.y), ymax: Math.max(a.y, b.y) }
}

/** Which agents' current (live, walking) position falls inside a world-space
 *  box — the same point the paint loop actually draws each agent's sprite
 *  at (`(x+0.5)*TILE`, `(y+0.9)*TILE`), so a box drawn around what's visibly
 *  on screen matches what gets selected. */
export function agentsInWorldBox(agents: ReadonlyArray<Pick<Agent, 'id' | 'x' | 'y'>>, box: WorldBox): string[] {
  return agents
    .filter((a) => {
      const px = (a.x + 0.5) * TILE
      const py = (a.y + 0.9) * TILE
      return px >= box.xmin && px <= box.xmax && py >= box.ymin && py <= box.ymax
    })
    .map((a) => a.id)
}

/** A drag under this many screen pixels is a click that missed, not a
 *  deliberate box — same idea as the existing 4px pan/click threshold, sized
 *  up because a selection box is a bigger gesture than a pointer click. */
export const MIN_SELECT_BOX_PX = 6

export type SelectionSummary = {
  count: number
  byDept: Map<FunctionalDeptId | 'lounge' | 'ceo', number>
}

/** What a multi-selection adds up to — count and a department breakdown.
 *  Inspect only: no aggregate here ever authorizes an action (see this
 *  file's header and docs/office-departments.md — assigning objectives or
 *  moving budget stays out of scope until it has real backend
 *  authorization and a confirmation step, per the redesign brief's own
 *  caution against irreversible RTS commands). */
export function selectionSummary(agents: ReadonlyArray<Pick<Agent, 'deptId'>>): SelectionSummary {
  const byDept = new Map<FunctionalDeptId | 'lounge' | 'ceo', number>()
  for (const a of agents) {
    const key = a.deptId as FunctionalDeptId | 'lounge' | 'ceo'
    byDept.set(key, (byDept.get(key) ?? 0) + 1)
  }
  return { count: agents.length, byDept }
}
