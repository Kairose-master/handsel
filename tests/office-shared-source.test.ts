import { describe, it, expect } from 'vitest'
import { briefWithOfficeSource, MAX_OFFICE_SOURCE_CHARS } from '@/lib/office-source-brief'

describe('briefWithOfficeSource', () => {
  it('leaves the brief byte-identical when the office has no source', () => {
    expect(briefWithOfficeSource('Do the thing.', null)).toBe('Do the thing.')
    expect(briefWithOfficeSource('Do the thing.', undefined)).toBe('Do the thing.')
  })

  it('treats a whitespace-only body as no source, not as an empty section', () => {
    expect(briefWithOfficeSource('Do the thing.', { title: 'Memo', body: '   \n\t ' })).toBe('Do the thing.')
  })

  it('keeps the step brief first and appends the source after it', () => {
    const out = briefWithOfficeSource('Do the thing.', { title: 'Q3 memo', body: 'Revenue fell 4%.' })
    expect(out.startsWith('Do the thing.')).toBe(true)
    expect(out).toContain('Q3 memo')
    expect(out).toContain('Revenue fell 4%.')
    expect(out.indexOf('Do the thing.')).toBeLessThan(out.indexOf('Revenue fell 4%.'))
  })

  it('says the source is shared, so a worker knows others are reading the same text', () => {
    const out = briefWithOfficeSource('x', { title: 'Spec', body: 'y' })
    expect(out).toMatch(/every agent in this office/i)
  })

  it('falls back to a heading when the source is untitled', () => {
    const out = briefWithOfficeSource('x', { title: '   ', body: 'y' })
    expect(out).toContain('Shared source')
  })

  it('cuts an over-long body at the cap', () => {
    const body = 'a'.repeat(MAX_OFFICE_SOURCE_CHARS + 500)
    const out = briefWithOfficeSource('x', { title: 'Big', body })
    expect(out).toContain('a'.repeat(MAX_OFFICE_SOURCE_CHARS))
    expect(out).not.toContain('a'.repeat(MAX_OFFICE_SOURCE_CHARS + 1))
  })

  it('passes the body through verbatim — this is the owner’s own text, not fenced input', () => {
    // Deliberate, and asserted so the decision can't be reversed by accident:
    // fencing is for text another party wrote (upstream worker output). If a
    // future source can be fetched from a URL, this test should fail and be
    // replaced by one requiring fenceUntrusted.
    const body = '## Heading\n- bullet\n```code```'
    expect(briefWithOfficeSource('x', { title: 'T', body })).toContain(body)
  })
})
