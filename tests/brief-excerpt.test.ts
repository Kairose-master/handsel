import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  excerptForBrief,
  truncationNotice,
  HANDOFF_EXCERPT_LIMIT,
  REVIEW_EXCERPT_LIMIT,
} from '@/lib/brief-excerpt'

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('excerptForBrief', () => {
  it('passes a document shorter than the limit through untouched', () => {
    const e = excerptForBrief('short', 100)
    expect(e).toEqual({ text: 'short', truncated: false, omitted: 0 })
  })

  it('reports exactly how much it cut', () => {
    const e = excerptForBrief('x'.repeat(150), 100)
    expect(e.text).toHaveLength(100)
    expect(e.truncated).toBe(true)
    expect(e.omitted).toBe(50)
  })

  it('does not truncate at the boundary', () => {
    expect(excerptForBrief('x'.repeat(100), 100).truncated).toBe(false)
  })

  it('survives a non-string source', () => {
    expect(excerptForBrief(undefined as unknown as string, 100).text).toBe('')
  })
})

describe('the limits', () => {
  it('passes the deliverable that caused this — 19,465 chars — whole to a reviewer', () => {
    // The live memo the old 8,000-char cap cut at §2, prompting a REVISE for a
    // §6 the platform had removed.
    expect(excerptForBrief('x'.repeat(19_465), REVIEW_EXCERPT_LIMIT).truncated).toBe(false)
    expect(excerptForBrief('x'.repeat(19_465), HANDOFF_EXCERPT_LIMIT).truncated).toBe(true)
  })

  it('keeps handoff bounded — several inputs can land in one brief', () => {
    expect(HANDOFF_EXCERPT_LIMIT).toBeLessThan(REVIEW_EXCERPT_LIMIT)
  })
})

describe('truncationNotice', () => {
  const cut = { title: 'Platform recommendation', excerpt: excerptForBrief('x'.repeat(19_465), 8_000) }
  const whole = { title: 'AWS read', excerpt: excerptForBrief('short', 8_000) }

  it('says nothing when nothing was cut', () => {
    expect(truncationNotice([whole])).toBeUndefined()
    expect(truncationNotice([])).toBeUndefined()
  })

  it('names the document and the amount cut', () => {
    const n = truncationNotice([cut])!
    expect(n).toContain('Platform recommendation')
    expect(n).toContain('11,465')
  })

  it('tells a reviewer the absence is not the worker’s doing', () => {
    const n = truncationNotice([cut], { reviewing: true })!
    expect(n).toMatch(/not the worker/i)
    expect(n).toMatch(/REVISE/)
  })

  it('attributes the notice to the platform, so it cannot read as worker text', () => {
    expect(truncationNotice([cut], { reviewing: true })!).toMatch(/PLATFORM NOTICE/)
  })

  it('mentions only the inputs that were actually cut', () => {
    const n = truncationNotice([whole, cut], { reviewing: true })!
    expect(n).toContain('Platform recommendation')
    expect(n).not.toContain('AWS read')
  })
})

describe('delegation wires it', () => {
  const src = codeOnly(readFileSync('lib/delegation.ts', 'utf8'))

  it('no longer hard-codes an 8000-char slice on injected inputs', () => {
    expect(src).not.toMatch(/\.slice\(0,\s*8000\)/)
  })

  it('picks the review limit for a review and the handoff limit otherwise', () => {
    expect(src).toMatch(/st\.reviewOf\s*\?\s*REVIEW_EXCERPT_LIMIT\s*:\s*HANDOFF_EXCERPT_LIMIT/)
  })

  it('puts the notice outside the untrusted fence', () => {
    // Inside the fence it would be worker-authored text and forgeable, which
    // is the entire reason the fence exists.
    const fenceCall = src.indexOf('fenceUntrusted(`worker_output_')
    const noticeBuilt = src.indexOf('truncationNotice(')
    expect(noticeBuilt).toBeGreaterThan(-1)
    expect(noticeBuilt).toBeLessThan(fenceCall)
    expect(src).toMatch(/\$\{header\}\$\{notice/)
  })
})
