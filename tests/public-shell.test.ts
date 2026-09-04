import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const PUBLIC_PAGES = ['app/guest/page.tsx', 'app/directory/page.tsx', 'app/live/page.tsx', 'app/try/page.tsx', 'app/pilot/page.tsx']

describe('every page a stranger can reach discloses its environment', () => {
  // SiteFooter carries the mainnet/testnet disclosure and the only links to
  // the privacy policy and terms. It existed, and exactly ONE of four public
  // pages rendered it — on a deployment handling real USDC. The component was
  // complete and unreachable, which is the defect this repo keeps catching
  // itself in (docs/failure-modes.md 42, 43, 53), this time in the layout.
  it.each(PUBLIC_PAGES)('%s renders the footer', (page) => {
    const src = readFileSync(page, 'utf8')
    const direct = /<SiteFooter\b/.test(src)
    const viaShell = /<PublicShell\b/.test(src)
    expect(direct || viaShell, `${page} has no environment disclosure and no legal links`).toBe(true)
  })

  it('never hardcodes which environment it is', () => {
    // A disclosure written from a constant turned false the day the
    // deployment moved to Base mainnet.
    const shell = readFileSync('components/public-shell.tsx', 'utf8')
    expect(shell).toMatch(/realMoney/)
    expect(shell).not.toMatch(/realMoney=\{(true|false)\}/)
  })
})

describe('the shell is one thing, not four', () => {
  const shell = readFileSync('components/public-shell.tsx', 'utf8')

  it('defines the public nav once', () => {
    expect(shell).toMatch(/const NAV = \[/)
    for (const href of ['/guest', '/directory', '/live', '/try']) {
      expect(shell).toContain(`href: '${href}'`)
    }
  })

  it('marks the current page for people who need to know where they are', () => {
    expect(shell).toMatch(/aria-current=\{active \? 'page' : undefined\}/)
  })

  it('lets a keyboard user past the sticky header', () => {
    // Otherwise they tab the whole nav on every page before reaching content.
    expect(shell).toMatch(/href="#content"/)
    expect(shell).toMatch(/id="content"/)
  })

  it('offers a named set of widths rather than a number per page', () => {
    // The four pages had 1100px, 1200px and max-w-2xl between them, with no
    // rule about which meant what.
    expect(shell).toMatch(/const WIDTH: Record<ShellWidth, string>/)
    expect(shell).toMatch(/prose:/)
  })

  it('keeps the dark spectacle page dark instead of flattening it', () => {
    expect(shell).toMatch(/tone === 'dark'/)
  })
})

describe('no dead ends', () => {
  it('has a branded 404 with somewhere to go', () => {
    expect(existsSync('app/not-found.tsx')).toBe(true)
    const src = readFileSync('app/not-found.tsx', 'utf8')
    expect(src).toMatch(/<PublicShell/)
    expect((src.match(/href: '\//g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('does not apologise at the reader', () => {
    // Apologetic copy and exclamation marks are the house style of an
    // interface that is not sure of itself.
    //
    // Comments are stripped first, or this passes on a file whose only
    // mention of the word is a comment saying not to use it — which is
    // exactly what happened the first time this ran, and would have made the
    // check unable to fail for the real reason.
    const src = readFileSync('app/not-found.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/oops/i)
    expect(src).not.toMatch(/sorry/i)
    expect(src).not.toMatch(/found!/)
  })
})
