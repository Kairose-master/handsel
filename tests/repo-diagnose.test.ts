/**
 * The free Repo Care diagnostic: normalizing whatever a stranger pastes into
 * `owner/repo`, and the wiring pins that keep it a public, no-account path
 * (never `lib/github-app.ts`'s installation-gated reader) whose checkout URL
 * is read server-side, never baked into a client bundle.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeRepoInput } from '@/lib/repo-diagnose-server'

const read = (p: string) => readFileSync(p, 'utf8')

describe('normalizeRepoInput', () => {
  it('accepts plain owner/repo', () => {
    expect(normalizeRepoInput('facebook/react')).toBe('facebook/react')
  })

  it('strips a pasted github.com URL, trailing slash and .git', () => {
    expect(normalizeRepoInput('https://github.com/facebook/react')).toBe('facebook/react')
    expect(normalizeRepoInput('http://www.github.com/facebook/react/')).toBe('facebook/react')
    expect(normalizeRepoInput('https://github.com/facebook/react.git')).toBe('facebook/react')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRepoInput('  facebook/react  ')).toBe('facebook/react')
  })

  it('rejects anything that is not owner/repo', () => {
    expect(normalizeRepoInput('')).toBeNull()
    expect(normalizeRepoInput('facebook')).toBeNull()
    expect(normalizeRepoInput('facebook/react/extra')).toBeNull()
    expect(normalizeRepoInput('a b/c')).toBeNull()
  })
})

describe('wiring: the diagnostic never needs the GitHub App, and the checkout URL stays server-side', () => {
  it('reads the public unauthenticated GitHub API, not the installation-gated reader', () => {
    const src = read('lib/repo-diagnose-server.ts')
    expect(src).toContain('https://api.github.com/repos/')
    expect(src).not.toContain("from '@/lib/github-app'")
    expect(src).not.toContain('listOpenIssues(')
  })

  it('the server action has no auth check — it must work for a signed-out visitor', () => {
    const src = read('app/actions/repo-diagnose.ts')
    expect(src).toContain("'use server'")
    expect(src).not.toMatch(/[^`]requireUser\(\)/)
  })

  it('the wizard reads the checkout URL server-side and threads it down as a prop, never a NEXT_PUBLIC_ env var', () => {
    const page = read('app/(dashboard)/office/repo-care/page.tsx')
    expect(page).toContain('process.env.LEMONSQUEEZY_PILOT_CHECKOUT_URL')
    expect(page).not.toContain('process.env.NEXT_PUBLIC_')
    expect(page).toContain('checkoutUrl={checkoutUrl}')

    const client = read('app/(dashboard)/office/repo-care/wizard-client.tsx')
    expect(client).toContain("'use client'")
    expect(client).not.toContain('process.env')
    expect(client).toContain('checkoutUrl: string | null')
  })
})
