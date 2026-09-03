/**
 * The map on the fleet landing page — a business drawn as boxes, each box
 * an agent with a wallet.
 *
 * The picture comes from a reel (docs/fleet-landing-design.md): one screen,
 * the whole company as a map — marketing, sales, customer admin, operations,
 * finance in the middle; funnels, content, ads, lead flow, email and SMS
 * around it. This module is that map as data, so the page draws it and the
 * tests can check it against what the code actually ships: every box that
 * claims an office template names a real one in OFFICE_TEMPLATES.
 *
 * Pure. No page numbers here — the live counters come from
 * app/actions/fleet.ts and are null when they cannot be read.
 */
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'

export type BoxFill =
  /** A shipped office template fills this box. */
  | { kind: 'template'; templateId: string }
  /** The owner's own worker (a Claude Code harness on their machine). */
  | { kind: 'worker' }
  /** A stranger's agent from the market — the fallback, never the headline. */
  | { kind: 'market' }

export type FleetBox = {
  id: string
  /** i18n key suffix; the label lives in the dictionary. */
  labelKey: string
  ring: 'core' | 'outer'
  fill: BoxFill
}

/** The five core functions in the middle, the eight flows around them —
 *  the reel's map, box for box. */
export const FLEET_BOXES: readonly FleetBox[] = [
  { id: 'marketing', labelKey: 'fleet.box.marketing', ring: 'core', fill: { kind: 'template', templateId: 'growth-studio' } },
  { id: 'sales', labelKey: 'fleet.box.sales', ring: 'core', fill: { kind: 'market' } },
  { id: 'customer-admin', labelKey: 'fleet.box.customerAdmin', ring: 'core', fill: { kind: 'worker' } },
  { id: 'operations', labelKey: 'fleet.box.operations', ring: 'core', fill: { kind: 'template', templateId: 'bootstrap-desk' } },
  { id: 'finance', labelKey: 'fleet.box.finance', ring: 'core', fill: { kind: 'template', templateId: 'securities-desk' } },
  { id: 'funnels', labelKey: 'fleet.box.funnels', ring: 'outer', fill: { kind: 'template', templateId: 'growth-studio' } },
  { id: 'content', labelKey: 'fleet.box.content', ring: 'outer', fill: { kind: 'worker' } },
  { id: 'ads', labelKey: 'fleet.box.ads', ring: 'outer', fill: { kind: 'worker' } },
  { id: 'lead-flow', labelKey: 'fleet.box.leadFlow', ring: 'outer', fill: { kind: 'market' } },
  { id: 'email-sms', labelKey: 'fleet.box.emailSms', ring: 'outer', fill: { kind: 'worker' } },
  { id: 'research', labelKey: 'fleet.box.research', ring: 'outer', fill: { kind: 'template', templateId: 'research-desk' } },
  { id: 'legal', labelKey: 'fleet.box.legal', ring: 'outer', fill: { kind: 'template', templateId: 'research-desk' } },
  { id: 'hiring', labelKey: 'fleet.box.hiring', ring: 'outer', fill: { kind: 'template', templateId: 'talent-agency' } },
]

/** The six steps a box goes through to be filled — the strip under the map.
 *  Each names the file that does it, so the page cannot describe a step the
 *  code does not have. */
export const PIPELINE_STEPS: readonly { id: string; labelKey: string; bodyKey: string; source: string }[] = [
  { id: 'row', labelKey: 'fleet.step.row', bodyKey: 'fleet.step.rowBody', source: 'lib/notion-desk.ts' },
  { id: 'escrow', labelKey: 'fleet.step.escrow', bodyKey: 'fleet.step.escrowBody', source: 'lib/job-post.ts' },
  { id: 'work', labelKey: 'fleet.step.work', bodyKey: 'fleet.step.workBody', source: 'public/handsel-worker.mjs' },
  { id: 'grade', labelKey: 'fleet.step.grade', bodyKey: 'fleet.step.gradeBody', source: 'lib/callback/labor-market.ts' },
  { id: 'pay', labelKey: 'fleet.step.pay', bodyKey: 'fleet.step.payBody', source: 'lib/labor-settle.ts' },
  { id: 'proof', labelKey: 'fleet.step.proof', bodyKey: 'fleet.step.proofBody', source: 'lib/work-proof-store.ts' },
]

/* ── Geometry ─────────────────────────────────────────────────────────── */

export const MAP_W = 1200
export const MAP_H = 680
export const BOX_W = 168
export const BOX_H = 60

/** Where a box sits in the viewBox. The core is a 3-over-2 block in the
 *  middle; the outer ring is an ellipse around it. Deterministic, so the
 *  page and a snapshot agree. */
export function boxPosition(box: FleetBox): { x: number; y: number } {
  const cx = MAP_W / 2
  const cy = MAP_H / 2
  if (box.ring === 'core') {
    const i = FLEET_BOXES.filter((b) => b.ring === 'core').findIndex((b) => b.id === box.id)
    const gapX = BOX_W + 18
    const gapY = BOX_H + 18
    // row 0: three boxes; row 1: two boxes, centred.
    if (i < 3) return { x: cx + (i - 1) * gapX - BOX_W / 2, y: cy - gapY / 2 - BOX_H / 2 }
    return { x: cx + (i - 3.5) * gapX - BOX_W / 2, y: cy + gapY / 2 - BOX_H / 2 }
  }
  const outer = FLEET_BOXES.filter((b) => b.ring === 'outer')
  const i = outer.findIndex((b) => b.id === box.id)
  const angle = -Math.PI / 2 + (i / outer.length) * Math.PI * 2
  const rx = 500
  const ry = 265
  return { x: cx + Math.cos(angle) * rx - BOX_W / 2, y: cy + Math.sin(angle) * ry - BOX_H / 2 }
}

/** The name of the template a box claims, or null. Reads OFFICE_TEMPLATES,
 *  so a renamed template renames the box. */
export function templateNameFor(fill: BoxFill): string | null {
  if (fill.kind !== 'template') return null
  return OFFICE_TEMPLATES.find((t) => t.id === fill.templateId)?.name ?? null
}

/** Every template id a box claims — the test checks each exists. */
export function claimedTemplateIds(): string[] {
  return Array.from(new Set(FLEET_BOXES.flatMap((b) => (b.fill.kind === 'template' ? [b.fill.templateId] : []))))
}
