import { describe, expect, it, vi } from 'vitest'
import { publishCarousel } from '@/lib/social/instagram/carousel'
import { publishContainerSafely, publishImagePost } from '@/lib/social/instagram/publish'
import type { InstagramConfig } from '@/lib/social/instagram/types'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const cfg = (fetchImpl: typeof fetch): InstagramConfig => ({
  accessToken: 'tok',
  accountId: '178',
  apiVersion: 'v25.0',
  graphHost: 'graph.instagram.com',
  fetchImpl,
})

type Route = { match: (url: string, method: string) => boolean; respond: (url: string, body: string) => unknown }

/** Tiny scripted Graph API: routes checked in order; `respond` may consume per-call state. */
const graphFetch = (routes: Route[]): typeof fetch =>
  vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    for (const r of routes) {
      if (r.match(url, method)) return Promise.resolve(jsonResponse(r.respond(url, String(init?.body ?? ''))))
    }
    return Promise.resolve(jsonResponse({ error: { message: `unrouted ${method} ${url}`, code: 100 } }, 400))
  })

describe('publishContainerSafely — the duplicate-publish guard', () => {
  it('waits for FINISHED then publishes exactly once', async () => {
    let publishes = 0
    const fetchImpl = graphFetch([
      { match: (u, m) => m === 'GET' && u.includes('/c1?'), respond: () => ({ id: 'c1', status_code: 'FINISHED' }) },
      {
        match: (u, m) => m === 'POST' && u.includes('/media_publish'),
        respond: () => {
          publishes++
          return { id: 'media_77' }
        },
      },
    ])
    const res = await publishContainerSafely(cfg(fetchImpl), 'c1', { initialDelayMs: 1 })
    expect(res).toEqual({ mediaId: 'media_77', containerId: 'c1' })
    expect(publishes).toBe(1)
  })

  it('a container that is already PUBLISHED is never published again — the id is recovered instead', async () => {
    let publishes = 0
    const fetchImpl = graphFetch([
      { match: (u, m) => m === 'GET' && u.includes('/c1?'), respond: () => ({ id: 'c1', status_code: 'PUBLISHED' }) },
      { match: (u, m) => m === 'GET' && u.includes('/178/media?'), respond: () => ({ data: [{ id: 'media_prev' }] }) },
      {
        match: (u, m) => m === 'POST' && u.includes('/media_publish'),
        respond: () => {
          publishes++
          return { id: 'media_dup' }
        },
      },
    ])
    const res = await publishContainerSafely(cfg(fetchImpl), 'c1', { initialDelayMs: 1 })
    expect(res.mediaId).toBe('media_prev')
    expect(publishes).toBe(0)
  })

  it('a publish that errors AFTER taking effect is detected via the container, not replayed', async () => {
    // media_publish 500s, but the container then reads PUBLISHED — the retry
    // path must recover the id rather than post a second time.
    let statusCalls = 0
    const fetchImpl = graphFetch([
      {
        match: (u, m) => m === 'GET' && u.includes('/c1?'),
        respond: () => ({ id: 'c1', status_code: ++statusCalls === 1 ? 'FINISHED' : 'PUBLISHED' }),
      },
      { match: (u, m) => m === 'GET' && u.includes('/178/media?'), respond: () => ({ data: [{ id: 'media_real' }] }) },
    ])
    // media_publish falls through to the unrouted 400 — a hard failure.
    const res = await publishContainerSafely(cfg(fetchImpl), 'c1', { initialDelayMs: 1 })
    expect(res.mediaId).toBe('media_real')
  })
})

describe('publishImagePost', () => {
  it('creates the container, reports it to the checkpoint, then publishes', async () => {
    const phases: string[] = []
    const fetchImpl = graphFetch([
      {
        match: (u, m) => m === 'POST' && /\/178\/media$/.test(u),
        respond: (_u, body) => {
          expect(body).toContain('image_url=')
          return { id: 'c_img' }
        },
      },
      { match: (u, m) => m === 'GET' && u.includes('/c_img?'), respond: () => ({ id: 'c_img', status_code: 'FINISHED' }) },
      { match: (u, m) => m === 'POST' && u.includes('/media_publish'), respond: () => ({ id: 'media_1' }) },
    ])
    const res = await publishImagePost(
      cfg(fetchImpl),
      { kind: 'post', imageUrl: 'https://cdn.example/a.png', caption: 'hi', altText: 'alt' },
      { onContainer: (id) => void phases.push(`container:${id}`) },
      { initialDelayMs: 1 },
    )
    expect(res.mediaId).toBe('media_1')
    expect(phases).toEqual(['container:c_img'])
  })
})

describe('publishCarousel', () => {
  it('creates each child, waits for them, builds the parent, publishes once', async () => {
    let containerCount = 0
    const publishCalls: string[] = []
    const fetchImpl = graphFetch([
      {
        match: (u, m) => m === 'POST' && /\/178\/media$/.test(u),
        respond: (_u, body) => {
          if (body.includes('media_type=CAROUSEL')) {
            expect(decodeURIComponent(body)).toContain('children=child1,child2')
            return { id: 'parent1' }
          }
          expect(body).toContain('is_carousel_item=true')
          return { id: `child${++containerCount}` }
        },
      },
      {
        match: (u, m) => m === 'GET' && /\/(child\d|parent1)\?/.test(u),
        respond: () => ({ id: 'x', status_code: 'FINISHED' }),
      },
      {
        match: (u, m) => m === 'POST' && u.includes('/media_publish'),
        respond: (_u, body) => {
          publishCalls.push(body)
          return { id: 'media_car' }
        },
      },
    ])
    const children: string[][] = []
    const res = await publishCarousel(
      cfg(fetchImpl),
      {
        kind: 'carousel',
        items: [{ imageUrl: 'https://cdn.example/1.png' }, { imageUrl: 'https://cdn.example/2.png' }],
        caption: 'two slides',
      },
      { onChildren: (ids) => void children.push(ids) },
      { initialDelayMs: 1 },
    )
    expect(res.mediaId).toBe('media_car')
    expect(children).toEqual([['child1', 'child2']])
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0]).toContain('creation_id=parent1')
  })

  it('rejects out-of-bounds item counts before any network call', async () => {
    const fetchImpl = vi.fn()
    await expect(
      publishCarousel(cfg(fetchImpl), { kind: 'carousel', items: [{ imageUrl: 'https://x/a.png' }] }),
    ).rejects.toThrow(/2–10/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
