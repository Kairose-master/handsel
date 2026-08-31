import { describe, it, expect } from 'vitest'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { OFFICE_TEMPLATES, OFFICE_DEPARTMENTS } from '@/lib/office-world-data'

// Art referenced by id and stored by file name drifts silently: someone adds a
// ninth template, the picker renders a broken image, and nothing fails. These
// make the file name part of the build.
describe('every office template has its desk card', () => {
  it.each(OFFICE_TEMPLATES.map((t) => t.id))('%s', (id) => {
    const path = `public/office-cards/${id}.png`
    expect(existsSync(path), `${path} is missing — the picker will render a broken image`).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(2000)
  })

  it('ships no card for a template that no longer exists', () => {
    // The other direction: a deleted template leaving art behind is dead
    // weight served to every visitor.
    const ids = new Set(OFFICE_TEMPLATES.map((t) => t.id))
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    for (const file of readdirSync('public/office-cards')) {
      expect(ids.has(file.replace(/\.png$/, '')), `${file} belongs to no template`).toBe(true)
    }
  })
})

describe('every functional department has its glyph', () => {
  it.each(OFFICE_DEPARTMENTS.map((d) => d.id))('%s', (id) => {
    expect(existsSync(`public/dept/${id}.png`)).toBe(true)
  })
})

describe('the glyphs are worn, not filed', () => {
  it('the department list renders the drawn glyph', () => {
    // Nine icons committed and referenced by nothing is the exact pattern
    // this repo keeps catching itself in (docs/failure-modes.md 42-43).
    const page = readFileSync('app/(dashboard)/office/page.tsx', 'utf8')
    expect(page).toMatch(/\/dept\/\$\{deptId\}\.png/)
  })

  it('ships no v0 scaffolding', () => {
    // These were served to every visitor and imported by nothing.
    for (const dead of [
      'public/placeholder.svg',
      'public/placeholder-logo.svg',
      'public/placeholder-user.jpg',
      'public/agent-atlas.png',
    ]) {
      expect(existsSync(dead), `${dead} is dead weight`).toBe(false)
    }
  })
})

describe('the generated art is used, not filed', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('the landing page shows the product, not just the logo', () => {
    // /guest carried exactly one image — the logo — while a render of two
    // offices hiring each other sat in docs/assets doing nothing. A page
    // about a workplace that shows no workplace asks the reader to imagine
    // the product.
    const guest = read('app/guest/page.tsx')
    expect(guest).toMatch(/\/art\/hero\.webp/)
    const imgs = guest.match(/<img\b/g) ?? []
    expect(imgs.length).toBeGreaterThan(1)
  })

  it('the theme button previews the theme it switches to', () => {
    // Cycling blind is why the second theme was invisible: the only way to
    // see it was to press the button and lose your place.
    expect(read('app/(dashboard)/office/game3d/OfficeWorld3D.tsx')).toMatch(/\/art\/theme-\$\{otherTheme\.id\}\.webp/)
  })

  it('every registered theme has a preview to show', () => {
    // A third theme added without art would render a broken thumbnail in the
    // HUD, which is worse than the name it replaced.
    for (const id of ['tactical', 'diorama']) {
      expect(existsSync(`public/art/theme-${id}.webp`), `public/art/theme-${id}.webp`).toBe(true)
    }
    const themes = read('app/(dashboard)/office/game3d/theme.ts')
    const ids = [...themes.matchAll(/^\s{2}id: '([a-z-]+)',$/gm)].map((m) => m[1])
    for (const id of ids) expect(existsSync(`public/art/theme-${id}.webp`), id).toBe(true)
  })

  it('ships the art as webp, not as third-of-a-megabyte PNGs', () => {
    // The hero is above the fold on the slowest connection anyone arrives on.
    // As a PNG it was 381KB.
    for (const f of ['hero', 'theme-tactical', 'theme-diorama']) {
      expect(existsSync(`public/art/${f}.png`), `${f}.png should not ship`).toBe(false)
      expect(statSync(`public/art/${f}.webp`).size).toBeLessThan(120_000)
    }
  })
})
