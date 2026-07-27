import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DOCS_JOB_SOURCES,
  docsJobAcceptanceCriteria,
  docsJobDescription,
  docsJobTitle,
  isDogfoodJobTitle,
  splitMarkdownSections,
} from '@/lib/docs-jobs'

describe('isDogfoodJobTitle', () => {
  it('recognizes both dogfood families and rejects practice titles', () => {
    expect(isDogfoodJobTitle('i18n → zh: translate 12 UI strings [a…]')).toBe(true)
    expect(isDogfoodJobTitle('docs → Korean: translate docs/mcp-connector.md (part 1/3)')).toBe(true)
    expect(isDogfoodJobTitle('Implement sum_multiples(n)')).toBe(false)
    expect(isDogfoodJobTitle('Reverse the words of a string')).toBe(false)
  })
})

describe('splitMarkdownSections', () => {
  it('keeps whole ## sections and attaches the preamble to the first chunk', () => {
    const md = ['# Title', 'intro', '## A', 'aaa', '## B', 'bbb'].join('\n')
    const chunks = splitMarkdownSections(md, 14) // force tiny chunks
    expect(chunks[0]).toContain('# Title')
    expect(chunks[0]).toContain('intro')
    // every section header survives exactly once across chunks
    const joined = chunks.join('\n')
    expect(joined.match(/^## A$/m)).toBeTruthy()
    expect(joined.match(/^## B$/m)).toBeTruthy()
    // no chunk starts mid-section
    for (const c of chunks.slice(1)) expect(c.startsWith('## ')).toBe(true)
  })

  it('a single oversized section becomes its own chunk, never split', () => {
    const big = `## Huge\n${'x'.repeat(500)}`
    const chunks = splitMarkdownSections(`## Small\nok\n${big}`, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toBe(big)
  })

  it('reassembles losslessly (concatenation equals the source)', () => {
    const md = readFileSync('docs/mcp-connector.md', 'utf8')
    const chunks = splitMarkdownSections(md)
    expect(chunks.join('\n')).toBe(md)
    expect(chunks.length).toBeGreaterThan(1) // the real README does need chunking
  })
})

describe('briefs', () => {
  // Derived from the source rather than hardcoded. The list is real work that
  // changes as docs are written and translated, and a test that pins today's
  // first entry fails for reasons that have nothing to do with the briefs.
  const source = DOCS_JOB_SOURCES[0]!

  it('title carries the target language, path and part', () => {
    expect(docsJobTitle(source, 2, 3)).toBe(`docs → ${source.to}: translate ${source.path} (part 2/3)`)
    expect(docsJobTitle(source, 1, 1)).toBe(`docs → ${source.to}: translate ${source.path}`)
  })

  it('description embeds the chunk and the review-and-commit expectation', () => {
    const d = docsJobDescription(source, '## Build\nmvn package', 1, 2)
    expect(d).toContain('## Build')
    expect(d).toContain(`${source.from} to ${source.to}`)
    expect(d).toContain('maintainer reviews and commits')
  })

  it('acceptance criteria pin completeness and verbatim code blocks', () => {
    const c = docsJobAcceptanceCriteria(source)
    expect(c).toContain(`complete ${source.to} translation`)
    expect(c).toContain('unchanged')
  })
})
