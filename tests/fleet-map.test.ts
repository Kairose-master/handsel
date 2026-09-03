import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { BOX_H, BOX_W, FLEET_BOXES, MAP_H, MAP_W, PIPELINE_STEPS, boxPosition, claimedTemplateIds, templateNameFor } from '@/lib/fleet-map'
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'
import { DICTIONARIES } from '@/lib/i18n-dict'

describe('the map cannot advertise a desk the code does not ship', () => {
  it('every claimed template exists', () => {
    const ids = new Set(OFFICE_TEMPLATES.map((t) => t.id))
    for (const id of claimedTemplateIds()) expect(ids.has(id), id).toBe(true)
  })
  it('template names are read from the templates, never written here', () => {
    for (const b of FLEET_BOXES) {
      const fill = b.fill
      if (fill.kind === 'template') expect(templateNameFor(fill)).toBe(OFFICE_TEMPLATES.find((t) => t.id === fill.templateId)!.name)
      else expect(templateNameFor(fill)).toBeNull()
    }
  })
  it('every pipeline step names a file that exists', () => {
    for (const s of PIPELINE_STEPS) expect(() => readFileSync(s.source), s.source).not.toThrow()
  })
})

describe('the reel\'s map, box for box', () => {
  it('five core functions, eight flows, unique ids', () => {
    expect(FLEET_BOXES.filter((b) => b.ring === 'core')).toHaveLength(5)
    expect(FLEET_BOXES.filter((b) => b.ring === 'outer')).toHaveLength(8)
    expect(new Set(FLEET_BOXES.map((b) => b.id)).size).toBe(FLEET_BOXES.length)
  })
  it('every box sits inside the canvas and none overlap', () => {
    const rects = FLEET_BOXES.map((b) => ({ id: b.id, ...boxPosition(b) }))
    for (const r of rects) {
      expect(r.x, r.id).toBeGreaterThanOrEqual(0)
      expect(r.y, r.id).toBeGreaterThanOrEqual(0)
      expect(r.x + BOX_W, r.id).toBeLessThanOrEqual(MAP_W)
      expect(r.y + BOX_H, r.id).toBeLessThanOrEqual(MAP_H)
    }
    for (const a of rects)
      for (const b of rects) {
        if (a.id === b.id) continue
        const apart = a.x + BOX_W <= b.x || b.x + BOX_W <= a.x || a.y + BOX_H <= b.y || b.y + BOX_H <= a.y
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true)
      }
  })
  it('the market is the fallback, never the majority', () => {
    const market = FLEET_BOXES.filter((b) => b.fill.kind === 'market').length
    expect(market).toBeLessThan(FLEET_BOXES.length / 3)
  })
})

describe('every word on the page exists in the three maintained locales', () => {
  const page = readFileSync('app/fleet/page.tsx', 'utf8')
  const keys = new Set<string>([...page.matchAll(/t\('([a-z.]+)'/g)].map((m) => m[1]))
  for (const b of FLEET_BOXES) keys.add(b.labelKey)
  for (const s of PIPELINE_STEPS) {
    keys.add(s.labelKey)
    keys.add(s.bodyKey)
  }
  for (const k of ['one', 'two', 'three']) {
    keys.add(`fleet.start.${k}`)
    keys.add(`fleet.start.${k}Body`)
  }
  it('has keys to check', () => expect(keys.size).toBeGreaterThan(40))
  for (const loc of ['en', 'ko', 'zh'] as const) {
    it(`${loc} covers them all`, () => {
      const missing = [...keys].filter((k) => !(k in DICTIONARIES[loc]))
      expect(missing).toEqual([])
    })
  }
})

describe('the landing says the adopted line', () => {
  it('the guest hero leads with the fleet, and links to it', () => {
    expect(DICTIONARIES.en['guest.hero.title']).toBe('Run a fleet of agents that can all pay.')
    expect(DICTIONARIES.en['guest.hero.body']).toContain('trade infrastructure')
    expect(readFileSync('app/guest/page.tsx', 'utf8')).toContain('href="/fleet"')
  })
  it('never promises payment for effort', () => {
    const en = DICTIONARIES.en
    for (const [k, v] of Object.entries(en)) {
      if (!k.startsWith('fleet.')) continue
      expect(v.toLowerCase(), k).not.toMatch(/per (minute|hour)|hourly rate|pay(s|ing)? for (time|effort)/)
    }
    expect(en['fleet.how.rule']).toContain('nothing is paid for effort')
  })
})
