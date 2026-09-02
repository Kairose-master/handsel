import { describe, expect, it } from 'vitest'
import { resolveOrigin } from '@/lib/origin'

describe('resolveOrigin — precedence', () => {
  it('prefers an explicitly configured origin over anything Vercel provides', () => {
    expect(
      resolveOrigin({
        PUBLIC_ORIGIN: 'https://handsel.example',
        VERCEL_PROJECT_PRODUCTION_URL: 'proj.vercel.app',
        VERCEL_URL: 'dep-abc.vercel.app',
      }),
    ).toBe('https://handsel.example')
  })

  it('prefers the stable production host over the per-deployment one', () => {
    // A per-deployment URL baked into a sent email is a link that dies at the
    // next deploy.
    expect(
      resolveOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'proj.vercel.app', VERCEL_URL: 'dep-abc.vercel.app' }),
    ).toBe('https://proj.vercel.app')
  })

  it('falls back to the deployment URL when that is all there is', () => {
    expect(resolveOrigin({ VERCEL_URL: 'dep-abc.vercel.app' })).toBe('https://dep-abc.vercel.app')
  })

  it('falls back to localhost for development', () => {
    expect(resolveOrigin({})).toBe('http://localhost:3000')
  })
})

describe('resolveOrigin — shapes that arrive from real config', () => {
  it('adds the scheme Vercel omits', () => {
    expect(resolveOrigin({ VERCEL_URL: 'x.vercel.app' })).toBe('https://x.vercel.app')
  })

  it('leaves an explicit scheme alone, including http for a local origin', () => {
    expect(resolveOrigin({ PUBLIC_ORIGIN: 'http://localhost:4000' })).toBe('http://localhost:4000')
  })

  it('strips a trailing slash, so callers can concatenate a path safely', () => {
    expect(resolveOrigin({ PUBLIC_ORIGIN: 'https://handsel.example/' })).toBe('https://handsel.example')
    expect(resolveOrigin({ PUBLIC_ORIGIN: 'https://handsel.example///' })).toBe('https://handsel.example')
  })

  it('treats an empty or whitespace value as unset rather than as an origin', () => {
    // An empty env var is the classic way a "configured" value becomes ''
    // and every generated link turns into a bare path.
    expect(resolveOrigin({ PUBLIC_ORIGIN: '', VERCEL_URL: 'x.vercel.app' })).toBe('https://x.vercel.app')
    expect(resolveOrigin({ PUBLIC_ORIGIN: '   ', VERCEL_URL: 'x.vercel.app' })).toBe('https://x.vercel.app')
  })
})

describe('origin() in the browser is the page origin, never the env fallback', () => {
  // lib/origin.ts reads server env that is NOT in the client bundle (none of
  // it is NEXT_PUBLIC_), so every 'use client' caller — /try's Copy URL for
  // the MCP connector, most visibly — hydrated to http://localhost:3000.
  // Real visitors were handed a localhost URL to paste into Claude. In the
  // browser the deployment's origin IS the page's origin.
  it('prefers window.location.origin when a window exists', async () => {
    const g = globalThis as { window?: unknown }
    g.window = { location: { origin: 'https://www.handsel.dev' } }
    try {
      // dynamic import AFTER installing the fake window would be cached —
      // origin() reads window at call time, so the already-imported module
      // sees it too.
      const { origin } = await import('@/lib/origin')
      expect(origin()).toBe('https://www.handsel.dev')
    } finally {
      delete g.window
    }
  })
})
