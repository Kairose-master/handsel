import { describe, expect, it, vi } from 'vitest'
import { publishWithConfig } from '@/lib/social/instagram-publisher'
import type { InstagramConfig } from '@/lib/social/instagram'
import type { PublishCheckpoint, SocialJob } from '@/lib/social/social-job'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const cfg = (fetchImpl: typeof fetch): InstagramConfig => ({
  accessToken: 'tok_secret',
  accountId: '178',
  apiVersion: 'v25.0',
  graphHost: 'graph.instagram.com',
  fetchImpl,
})

const job = (over: Partial<SocialJob> = {}): SocialJob => ({
  id: 'soc_1',
  userId: 'u1',
  agentId: null,
  platform: 'instagram',
  kind: 'post',
  payload: { imageUrl: 'https://cdn.example/a.png', caption: 'hi' },
  status: 'PREPARING',
  campaign: null,
  scheduledAt: null,
  approvedAt: new Date(),
  approvedBy: 'op@example.com',
  approvedFingerprint: 'fp',
  containerId: null,
  childContainerIds: null,
  remoteMediaId: null,
  permalink: null,
  attempts: 0,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  ...over,
})

const recordingCheckpoint = () => {
  const phases: string[] = []
  const containers: Array<{ id: string; children?: string[] }> = []
  const checkpoint: PublishCheckpoint = {
    saveContainer: async (id, children) => void containers.push({ id, children }),
    setPhase: async (p) => void phases.push(p),
  }
  return { phases, containers, checkpoint }
}

type Route = { match: (url: string, method: string) => boolean; respond: (url: string, body: string) => unknown }
const graphFetch = (routes: Route[]): typeof fetch =>
  vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    for (const r of routes) {
      if (r.match(url, method)) return Promise.resolve(jsonResponse(r.respond(url, String(init?.body ?? ''))))
    }
    return Promise.resolve(jsonResponse({ error: { message: `unrouted ${method} ${url}`, code: 100 } }, 400))
  })

const quotaRoute = (usage: number): Route => ({
  match: (u) => u.includes('content_publishing_limit'),
  respond: () => ({ data: [{ quota_usage: usage, config: { quota_total: 100, quota_duration: 86400 } }] }),
})

describe('publishWithConfig — a post, end to end', () => {
  it('checks quota, creates + checkpoints the container, walks the phases, publishes', async () => {
    const { phases, containers, checkpoint } = recordingCheckpoint()
    const fetchImpl = graphFetch([
      quotaRoute(3),
      { match: (u, m) => m === 'POST' && /\/178\/media$/.test(u), respond: () => ({ id: 'c_post' }) },
      { match: (u, m) => m === 'GET' && u.includes('/c_post?'), respond: () => ({ id: 'c_post', status_code: 'FINISHED' }) },
      { match: (u, m) => m === 'POST' && u.includes('media_publish'), respond: () => ({ id: 'media_9' }) },
      { match: (u, m) => m === 'GET' && u.includes('/media_9?'), respond: () => ({ id: 'media_9', permalink: 'https://instagram.com/p/x' }) },
    ])
    const out = await publishWithConfig(cfg(fetchImpl), job(), checkpoint)
    expect(out).toEqual({ ok: true, remoteMediaId: 'media_9', containerId: 'c_post', permalink: 'https://instagram.com/p/x' })
    expect(phases).toEqual(['UPLOADING', 'PROCESSING', 'PUBLISHING'])
    expect(containers.map((c) => c.id)).toContain('c_post')
  })

  it('a full quota defers WITHOUT creating a container or burning an attempt', async () => {
    const { checkpoint } = recordingCheckpoint()
    let mediaPosts = 0
    const fetchImpl = graphFetch([
      quotaRoute(100),
      {
        match: (u, m) => m === 'POST' && /\/178\/media$/.test(u),
        respond: () => {
          mediaPosts++
          return { id: 'never' }
        },
      },
    ])
    const out = await publishWithConfig(cfg(fetchImpl), job(), checkpoint)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.deferred).toBe(true)
      expect(out.retryable).toBe(true)
    }
    expect(mediaPosts).toBe(0)
  })

  it('resumes a checkpointed container — no quota call, no re-creation, no duplicate', async () => {
    const { phases, checkpoint } = recordingCheckpoint()
    let creations = 0
    const fetchImpl = graphFetch([
      {
        match: (u, m) => m === 'POST' && /\/178\/media$/.test(u),
        respond: () => {
          creations++
          return { id: 'new' }
        },
      },
      { match: (u, m) => m === 'GET' && u.includes('/c_resume?'), respond: () => ({ id: 'c_resume', status_code: 'FINISHED' }) },
      { match: (u, m) => m === 'POST' && u.includes('media_publish'), respond: () => ({ id: 'media_r' }) },
      { match: (u, m) => m === 'GET' && u.includes('/media_r?'), respond: () => ({ id: 'media_r' }) },
    ])
    const out = await publishWithConfig(cfg(fetchImpl), job({ containerId: 'c_resume' }), checkpoint)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.remoteMediaId).toBe('media_r')
    expect(creations).toBe(0)
    // Resume skips UPLOADING — there is nothing to upload.
    expect(phases).toEqual(['PROCESSING', 'PUBLISHING'])
  })
})

describe('publishWithConfig — failure classification', () => {
  it('an expired container comes back as containerExpired (checkpoint must be discarded)', async () => {
    const { checkpoint } = recordingCheckpoint()
    const fetchImpl = graphFetch([
      { match: (u, m) => m === 'GET' && u.includes('/c_old?'), respond: () => ({ id: 'c_old', status_code: 'EXPIRED' }) },
    ])
    const out = await publishWithConfig(cfg(fetchImpl), job({ containerId: 'c_old' }), checkpoint)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.containerExpired).toBe(true)
      expect(out.retryable).toBe(false)
    }
  })

  it('a dead token comes back as needsAuth with the token redacted from the error', async () => {
    const { checkpoint } = recordingCheckpoint()
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: 'Session tok_secret invalid', type: 'OAuthException', code: 190 } },
        401,
      ),
    )
    const out = await publishWithConfig(cfg(fetchImpl), job(), checkpoint)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.needsAuth).toBe(true)
      expect(out.retryable).toBe(false)
      expect(out.error).not.toContain('tok_secret')
    }
  })

  it('a still-processing video surfaces as retryable, with the container checkpointed for resume', async () => {
    const { containers, checkpoint } = recordingCheckpoint()
    const fetchImpl = graphFetch([
      quotaRoute(0),
      { match: (u, m) => m === 'POST' && /\/178\/media$/.test(u), respond: () => ({ id: 'c_vid' }) },
      { match: (u, m) => m === 'GET' && u.includes('/c_vid?'), respond: () => ({ id: 'c_vid', status_code: 'IN_PROGRESS' }) },
    ])
    const reel = job({
      kind: 'reel',
      payload: { videoUrl: 'https://cdn.example/a.mp4', caption: 'r', shareToFeed: true },
    })
    const out = await publishWithConfig(cfg(fetchImpl), reel, checkpoint, { timeoutMs: 15, initialDelayMs: 5 })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.retryable).toBe(true)
      expect(out.needsAuth).toBeUndefined()
      expect(out.containerExpired).toBeUndefined()
    }
    // The container id was persisted BEFORE the wait — the next tick resumes it.
    expect(containers.map((c) => c.id)).toContain('c_vid')
  })
})
