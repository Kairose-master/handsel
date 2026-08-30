import { describe, it, expect } from 'vitest'
import { existsSync, statSync } from 'node:fs'
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
