import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { refuseUrl, htmlToText, titleFrom, MAX_FETCH_BYTES } from '@/lib/office-source-fetch'

describe('refuseUrl — the caller supplies the address and the server dials it', () => {
  it('refuses cloud metadata endpoints by name', () => {
    // The two that turn a document fetcher into a credential reader.
    expect(refuseUrl('https://169.254.169.254/latest/meta-data/')).toMatch(/metadata/i)
    expect(refuseUrl('https://metadata.google.internal/computeMetadata/v1/')).toBeTruthy()
  })

  it('refuses loopback and private ranges', () => {
    for (const u of [
      'https://localhost/doc',
      'https://127.0.0.1/doc',
      'https://10.0.0.5/doc',
      'https://172.16.0.1/doc',
      'https://172.31.255.1/doc',
      'https://192.168.1.1/doc',
      'https://[::1]/doc',
      'https://[fd00::1]/doc',
      'https://[fe80::1]/doc',
    ]) {
      expect(refuseUrl(u), u).toBeTruthy()
    }
  })

  it('does not refuse a public address that merely looks close to a private one', () => {
    // 172.32 is public; 11.x is public. An over-broad guard that blocks real
    // documents gets turned off, which is worse than a narrow one.
    expect(refuseUrl('https://172.32.0.1/doc')).toBeNull()
    expect(refuseUrl('https://11.0.0.1/doc')).toBeNull()
  })

  it('refuses internal-looking hostnames', () => {
    for (const u of ['https://wiki.internal/x', 'https://box.local/x', 'https://api.localhost/x']) {
      expect(refuseUrl(u), u).toBeTruthy()
    }
  })

  it('refuses anything that is not https', () => {
    for (const u of ['http://example.com/doc', 'file:///etc/passwd', 'gopher://x', 'ftp://x/y']) {
      expect(refuseUrl(u), u).toBeTruthy()
    }
  })

  it('refuses a non-URL rather than throwing', () => {
    expect(refuseUrl('not a url')).toBeTruthy()
    expect(refuseUrl('')).toBeTruthy()
  })

  it('allows an ordinary public document host', () => {
    expect(refuseUrl('https://www.notion.so/Some-Page-abc123')).toBeNull()
    expect(refuseUrl('https://docs.google.com/document/d/abc/edit')).toBeNull()
  })
})

describe('the guard states its own limit', () => {
  it('says it cannot catch a public name resolving to a private address', () => {
    // A floor, not a proof. Claiming more than it does is how a partial
    // defence gets treated as a complete one.
    // Comment prose wraps, so the assertion is on the flattened text rather
    // than on a phrase that happens to fit one line today.
    const flat = readFileSync('lib/office-source-fetch.ts', 'utf8').replace(/\s*\n\s*\*?\s*/g, ' ')
    expect(flat).toMatch(/RESOLVES to a private address/i)
    expect(flat).toMatch(/floor, not a proof/i)
  })

  it('re-checks the address after redirects', () => {
    // A redirect can land somewhere the first check would have refused, and
    // the final URL is the one that actually got dialled.
    const src = readFileSync('lib/office-source-fetch.ts', 'utf8')
    const fn = src.slice(src.indexOf('export async function fetchOfficeSource'))
    expect(fn).toContain('refuseUrl(res.url')
  })

  it('caps what it reads', () => {
    expect(MAX_FETCH_BYTES).toBeGreaterThan(10_000)
    expect(MAX_FETCH_BYTES).toBeLessThanOrEqual(2_000_000)
  })
})

describe('htmlToText', () => {
  it('drops scripts and styles rather than reading them as content', () => {
    const out = htmlToText('<p>keep</p><script>steal()</script><style>.a{}</style>')
    expect(out).toContain('keep')
    expect(out).not.toContain('steal')
    expect(out).not.toContain('.a{}')
  })

  it('turns block ends into line breaks so a brief stays readable', () => {
    expect(htmlToText('<li>one</li><li>two</li>')).toBe('one\ntwo')
  })

  it('unescapes the entities a document actually contains', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toContain('a & b <c> "d"')
  })
})

describe('titleFrom', () => {
  it('prefers the document’s own title', () => {
    expect(titleFrom('<title>  Q3   Board Memo </title>', 'https://x.test/a')).toBe('Q3 Board Memo')
  })

  it('falls back to the host rather than inventing a name', () => {
    expect(titleFrom('<p>no title</p>', 'https://notion.so/page')).toBe('notion.so')
  })
})

describe('a fetched source is a snapshot, not a live link', () => {
  const src = readFileSync('lib/office-source-fetch.ts', 'utf8')
  const handler = readFileSync('lib/mcp/handlers/office.ts', 'utf8')
  const office = readFileSync('lib/office.ts', 'utf8')

  it('says why a live link would be wrong', () => {
    // lib/office.ts already forbids the underlying thing: a brief that changed
    // under a posted job moves the target its worker is graded against.
    expect(src).toMatch(/graded against/)
    expect(src).toMatch(/snapshot/i)
  })

  it('hashes what was STORED, not what was fetched', () => {
    // Hashing the full text and storing a clipped version would make the
    // recorded fingerprint describe a document nobody has.
    const block = handler.slice(handler.indexOf("case 'set_office_source'"), handler.indexOf("case 'wire_office_agent'"))
    expect(block).toContain('clipped.length < body.length')
    expect(block).toContain('createHash')
  })

  it('refuses a url and a body together instead of picking one', () => {
    const block = handler.slice(handler.indexOf("case 'set_office_source'"), handler.indexOf("case 'wire_office_agent'"))
    expect(block).toMatch(/not both/)
  })

  it('clears provenance when a fetched source is pasted over', () => {
    // Leaving the old URL attached would credit new text to a document it
    // never came from.
    expect(office).toMatch(/provenance\?\.sourceUrl \?\? null/)
  })

  it('distinguishes "typed in" from "origin unknown" in the roster', () => {
    expect(handler).toMatch(/typed in, no origin document/)
  })
})
