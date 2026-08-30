import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { deckSvg, deckDataUri } from '@/lib/og-deck'
import { THEMES } from '@/app/(dashboard)/office/game3d/theme'

const W = 1200
const H = 630

/** Every coordinate the drawing actually puts on the plate. */
function points(svg: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of svg.matchAll(/points="([^"]+)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) {
      const [x, y] = pair.split(',').map(Number)
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y])
    }
  }
  for (const m of svg.matchAll(/<(?:circle|ellipse)[^>]*cx="([-\d.]+)"[^>]*cy="([-\d.]+)"/g)) {
    out.push([Number(m[1]), Number(m[2])])
  }
  return out
}

describe('the deck fits the plate', () => {
  // The defect this pins, hit twice while building the card: a hard-coded
  // tile size drew a deck that ran off the right and bottom edges, and the
  // only way to notice was to rasterise it and look. The geometry knows its
  // own extents; assert them.
  const svg = deckSvg({ width: W, height: H })
  const pts = points(svg)

  it('draws something', () => {
    expect(pts.length).toBeGreaterThan(100)
  })

  it('stays inside the canvas', () => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThanOrEqual(W)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(H)
  })

  it('leaves the left of the plate empty for the headline', () => {
    // app/opengraph-image.tsx lays 470px of text over the left. Art and
    // words competing for the same pixels is a card nobody reads.
    const leftmost = Math.min(...pts.map((p) => p[0]))
    expect(leftmost).toBeGreaterThan(500)
  })

  it('uses most of the space it is given, rather than a stamp in the corner', () => {
    const xs = pts.map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(W * 0.45)
  })

  it('scales to a different plate instead of assuming 1200x630', () => {
    const small = points(deckSvg({ width: 600, height: 315 }))
    expect(Math.max(...small.map((p) => p[0]))).toBeLessThanOrEqual(600)
    expect(Math.max(...small.map((p) => p[1]))).toBeLessThanOrEqual(315)
  })
})

describe('the palette comes from the renderer, not a copy', () => {
  // A card whose colours drift from the product it depicts is worse than no
  // card. If someone retunes the office theme, this has to move with it.
  it('paints with the active theme colours', () => {
    const t = THEMES.tactical
    const svg = deckSvg({ width: W, height: H })
    for (const color of [t.bg, t.floorDept, t.floorCeo, t.floorLounge, t.wall, t.prop.surface, t.prop.foliage, t.prop.screen]) {
      expect(svg.toLowerCase(), color).toContain(color.toLowerCase())
    }
  })

  it('renders the other registered theme too', () => {
    const svg = deckSvg({ width: W, height: H, themeId: 'diorama' })
    expect(svg.toLowerCase()).toContain(THEMES.diorama.floorDept.toLowerCase())
    expect(svg.toLowerCase()).not.toContain(THEMES.tactical.floorDept.toLowerCase())
  })

  it('reads the theme at call time', () => {
    // Not baked into a constant at import: the check above would pass on a
    // snapshot taken once and never updated again.
    const body = readFileSync('lib/og-deck.ts', 'utf8')
    expect(body).toMatch(/THEMES\[opts\.themeId \?\? 'tactical'\]/)
  })
})

describe('the SVG is well formed', () => {
  const svg = deckSvg({ width: W, height: H })

  it('opens and closes exactly one root', () => {
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.match(/<svg /g)?.length).toBe(1)
  })

  it('declares the namespace, or nothing will rasterise it', () => {
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('has no NaN coordinates', () => {
    // One undefined in the projection turns into "NaN,NaN" in a points list
    // and resvg silently drops that polygon — a hole nobody sees in a diff.
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('undefined')
  })

  it('is deterministic', () => {
    expect(deckSvg({ width: W, height: H })).toBe(svg)
  })
})

describe('deckDataUri', () => {
  it('produces something an <img src> can take', () => {
    const uri = deckDataUri({ width: W, height: H })
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const decoded = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString()
    expect(decoded).toBe(deckSvg({ width: W, height: H }))
  })
})

describe('the card is wired up', () => {
  it('exists as a route with the metadata Next reads', () => {
    const route = readFileSync('app/opengraph-image.tsx', 'utf8')
    expect(route).toMatch(/export const size = \{ width: 1200, height: 630 \}/)
    expect(route).toMatch(/export const contentType = 'image\/png'/)
    expect(route).toMatch(/export const alt =/)
    expect(route).toMatch(/deckDataUri\(/)
  })

  it('asks for the large twitter card, or the image is never shown', () => {
    // 'summary' renders the small, imageless variant no matter what image
    // the page offers — which is what shipped before this.
    expect(readFileSync('app/layout.tsx', 'utf8')).toMatch(/card: 'summary_large_image'/)
  })

  it('derives the chain line instead of writing one down', () => {
    // A stale "testnet, no real money" does the most damage in exactly this
    // place: link previews outlive the deployment they were written for.
    const route = readFileSync('app/opengraph-image.tsx', 'utf8')
    expect(route).toMatch(/isRealMoney\(\)/)
    expect(route).toMatch(/CHAIN\?\.name/)
  })
})
