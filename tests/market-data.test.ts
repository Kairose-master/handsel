import { describe, it, expect } from 'vitest'
import { normalizeSymbol, parseNewsRss } from '@/lib/market-data'

describe('normalizeSymbol', () => {
  it('treats a bare 6-digit code as KRX and appends .KS', () => {
    expect(normalizeSymbol('005930')).toBe('005930.KS')
    expect(normalizeSymbol(' 000660 ')).toBe('000660.KS')
  })

  it('passes an already-suffixed or non-numeric symbol through unchanged (uppercased)', () => {
    expect(normalizeSymbol('aapl')).toBe('AAPL')
    expect(normalizeSymbol('005930.kq')).toBe('005930.KQ')
    expect(normalizeSymbol('BRK.B')).toBe('BRK.B')
  })
})

describe('parseNewsRss', () => {
  const sampleFeed = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Samsung posts strong Q3 results</title>
      <link>https://news.example.com/a</link>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
      <source url="https://reuters.com">Reuters</source>
    </item>
    <item>
      <title><![CDATA[AAPL &amp; the chip supply chain]]></title>
      <link>https://news.example.com/b</link>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
      <source url="https://bloomberg.com">Bloomberg</source>
    </item>
  </channel></rss>`

  it('extracts title/link/source/pubDate for each item', () => {
    const items = parseNewsRss(sampleFeed, 5)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      title: 'Samsung posts strong Q3 results',
      link: 'https://news.example.com/a',
      pubDate: 'Mon, 01 Jan 2026 00:00:00 GMT',
      source: 'Reuters',
    })
  })

  it('decodes CDATA and XML entities in titles', () => {
    const items = parseNewsRss(sampleFeed, 5)
    expect(items[1].title).toBe('AAPL & the chip supply chain')
  })

  it('respects the limit even when more items are present', () => {
    expect(parseNewsRss(sampleFeed, 1)).toHaveLength(1)
  })

  it('returns an empty array for a feed with no items', () => {
    expect(parseNewsRss('<rss><channel></channel></rss>', 5)).toEqual([])
  })

  it('skips a malformed item missing a title or link rather than throwing', () => {
    const broken = `<rss><channel><item><pubDate>x</pubDate></item></channel></rss>`
    expect(parseNewsRss(broken, 5)).toEqual([])
  })
})
