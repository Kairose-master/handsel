import { describe, expect, it, vi } from 'vitest'
import {
  createCarouselContainer,
  createImageContainer,
  createVideoContainer,
  getContainerStatus,
  waitForContainer,
} from '@/lib/social/instagram/containers'
import { ContainerFailedError, ContainerTimeoutError } from '@/lib/social/instagram/errors'
import type { ContainerStatusCode, InstagramConfig } from '@/lib/social/instagram/types'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const cfg = (fetchImpl: typeof fetch): InstagramConfig => ({
  accessToken: 'tok',
  accountId: '178',
  apiVersion: 'v25.0',
  graphHost: 'graph.instagram.com',
  fetchImpl,
})

/** A fetch that answers each status poll with the next scripted status_code. */
const statusSequence = (codes: ContainerStatusCode[]): typeof fetch => {
  const queue = [...codes]
  return vi.fn().mockImplementation(() => {
    const status_code = queue.length > 1 ? queue.shift() : queue[0]
    return Promise.resolve(jsonResponse({ id: 'c1', status_code, status: `detail:${status_code}` }))
  })
}

describe('container creation', () => {
  it('image container sends image_url, caption and alt_text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'c9' }))
    const id = await createImageContainer(cfg(fetchImpl), {
      imageUrl: 'https://cdn.example/a.png',
      caption: 'cap',
      altText: 'an office diorama',
    })
    expect(id).toBe('c9')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/178/media')
    const body = String(init.body)
    expect(body).toContain('alt_text=an+office+diorama')
    expect(body).not.toContain('media_type')
  })

  it('reel container sends media_type=REELS with share_to_feed and cover', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'c9' }))
    await createVideoContainer(cfg(fetchImpl), {
      videoUrl: 'https://cdn.example/a.mp4',
      mediaType: 'REELS',
      shareToFeed: true,
      coverUrl: 'https://cdn.example/cover.png',
    })
    const body = String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)
    expect(body).toContain('media_type=REELS')
    expect(body).toContain('share_to_feed=true')
    expect(body).toContain('cover_url=')
  })

  it('carousel parent refuses fewer than 2 or more than 10 children without any network call', async () => {
    const fetchImpl = vi.fn()
    await expect(createCarouselContainer(cfg(fetchImpl), { children: ['a'] })).rejects.toThrow(/2–10/)
    await expect(createCarouselContainer(cfg(fetchImpl), { children: Array(11).fill('x') })).rejects.toThrow(/2–10/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('carousel parent joins children in order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'parent' }))
    await createCarouselContainer(cfg(fetchImpl), { children: ['a', 'b', 'c'], caption: 'trio' })
    const body = String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)
    expect(decodeURIComponent(body)).toContain('children=a,b,c')
  })
})

describe('container polling', () => {
  it('reads status_code and detail', async () => {
    const fetchImpl = statusSequence(['IN_PROGRESS'])
    const s = await getContainerStatus(cfg(fetchImpl), 'c1')
    expect(s).toEqual({ id: 'c1', statusCode: 'IN_PROGRESS', status: 'detail:IN_PROGRESS' })
  })

  it('polls IN_PROGRESS until FINISHED', async () => {
    const fetchImpl = statusSequence(['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'])
    const s = await waitForContainer(cfg(fetchImpl), 'c1', { initialDelayMs: 1, timeoutMs: 5000 })
    expect(s.statusCode).toBe('FINISHED')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('an already-PUBLISHED container returns (the duplicate guard needs to see it, not an error)', async () => {
    const fetchImpl = statusSequence(['PUBLISHED'])
    const s = await waitForContainer(cfg(fetchImpl), 'c1', { initialDelayMs: 1 })
    expect(s.statusCode).toBe('PUBLISHED')
  })

  it('ERROR raises ContainerFailedError carrying the detail — a new container is required', async () => {
    const fetchImpl = statusSequence(['IN_PROGRESS', 'ERROR'])
    const err = await waitForContainer(cfg(fetchImpl), 'c1', { initialDelayMs: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(ContainerFailedError)
    expect(err.statusCode).toBe('ERROR')
    expect(err.detail).toBe('detail:ERROR')
  })

  it('EXPIRED raises ContainerFailedError', async () => {
    const fetchImpl = statusSequence(['EXPIRED'])
    const err = await waitForContainer(cfg(fetchImpl), 'c1', { initialDelayMs: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(ContainerFailedError)
    expect(err.statusCode).toBe('EXPIRED')
  })

  it('a spent budget raises ContainerTimeoutError naming the container (resumable, not fatal)', async () => {
    const fetchImpl = statusSequence(['IN_PROGRESS'])
    const err = await waitForContainer(cfg(fetchImpl), 'c1', { initialDelayMs: 5, timeoutMs: 12 }).catch((e) => e)
    expect(err).toBeInstanceOf(ContainerTimeoutError)
    expect(err.containerId).toBe('c1')
  })
})
