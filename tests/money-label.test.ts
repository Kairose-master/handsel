import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_ASSERTIONS, ENVIRONMENT_KEYED, heroDisclaimerKey, tokenKey } from '@/lib/money-label'

/**
 * §26. The Base-mainnet homepage told visitors their money had no value.
 *
 * `docs/deployments.md` asserted *"Nothing asserts 'testnet' or 'mainnet'
 * anywhere; the chain does"* — and the first sentence under the headline on the
 * public landing page was a constant reading "Running on a public testnet …
 * with zero monetary value", rendered on every deployment. The banner and the
 * footer on the same page branched correctly. The hero was a plain `t()` call
 * that nobody read as a claim.
 *
 * A third-party auditor found it, which is the part worth keeping in mind: the
 * doc that made the promise passed every test we had, because we had no test
 * that could tell a promise from a fact.
 */

describe('which money the page is talking about', () => {
  it('an explicit testnet gets the test wording', () => {
    expect(tokenKey(false)).toBe('token.test')
    expect(heroDisclaimerKey(false)).toBe('guest.hero.disclaimer.testnet')
  })

  it('an explicit mainnet gets the real wording', () => {
    expect(tokenKey(true)).toBe('token.real')
    expect(heroDisclaimerKey(true)).toBe('guest.hero.disclaimer.mainnet')
  })

  /**
   * The tie-break, and the two halves break differently on purpose. A noun has
   * to be *some* word, so it takes the direction where being wrong costs less:
   * calling test tokens "USDC" makes someone over-cautious, calling real USDC
   * "test USDC" invites them to risk money they think is play money. A sentence
   * can decline to answer, so it does.
   */
  it('while the chain is still unknown, the noun reads as real money', () => {
    for (const unknown of [null, undefined]) {
      expect(tokenKey(unknown)).toBe('token.real')
    }
  })

  it('while the chain is still unknown, the sentence claims no environment', () => {
    for (const unknown of [null, undefined]) {
      expect(heroDisclaimerKey(unknown)).toBe('guest.hero.disclaimer.unknown')
    }
  })

  it('the unknown sentence really is silent about the environment', () => {
    const dict = readFileSync(join(process.cwd(), 'lib/i18n-dict.ts'), 'utf8')
    const line = dict.split('\n').find((l) => l.includes("'guest.hero.disclaimer.unknown'"))
    expect(line).toBeTruthy()
    for (const phrase of ENVIRONMENT_ASSERTIONS) {
      expect(line!.toLowerCase()).not.toContain(phrase.toLowerCase())
    }
  })
})

/**
 * The guard. Everything above tests a function; this tests the copy, which is
 * where the defect actually lived.
 */
describe('no user-facing string asserts an environment from a constant', () => {
  const dict = readFileSync(join(process.cwd(), 'lib/i18n-dict.ts'), 'utf8')

  /** Every `'key': '…value…'` pair, across all three locales. Values may wrap to
   *  the next line, which is exactly how the broken one was formatted. */
  function entries(): { key: string; value: string }[] {
    const out: { key: string; value: string }[] = []
    const lines = dict.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*'([\w.]+)':\s*(.*)$/)
      if (!m) continue
      const value = m[2].trim() === '' ? (lines[i + 1] ?? '') : m[2]
      out.push({ key: m[1], value })
    }
    return out
  }

  it('parses the dictionary — the extraction is the test here', () => {
    // A regex that quietly matches nothing makes every assertion below pass
    // while checking nothing, which is the failure mode of source scans.
    const all = entries()
    expect(all.length).toBeGreaterThan(500)
    expect(all.map((e) => e.key)).toContain('guest.hero.disclaimer.mainnet')
  })

  it('every guest-page string naming an environment is one of the branched keys', () => {
    const offenders = entries()
      .filter((e) => e.key.startsWith('guest.') || e.key.startsWith('token.'))
      .filter((e) => !ENVIRONMENT_KEYED.includes(e.key))
      .filter((e) => ENVIRONMENT_ASSERTIONS.some((p) => e.value.toLowerCase().includes(p.toLowerCase())))
      .map((e) => `${e.key} → ${e.value.slice(0, 90)}`)

    expect(
      offenders,
      'These strings state which chain the reader is on. That is live state, not copy — ' +
        'interpolate {token} or add a branched key set. See lib/money-label.ts.\n' +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('the guard would actually catch the sentence that shipped', () => {
    // The exact copy that rendered on Base mainnet. If this does not trip the
    // detector, the detector is decoration.
    const shipped = 'Running on a public testnet — real escrow, signatures, and grading, with zero monetary value.'
    expect(ENVIRONMENT_ASSERTIONS.some((p) => shipped.toLowerCase().includes(p.toLowerCase()))).toBe(true)
  })
})

describe('the guest page reads the chain instead of hardcoding it', () => {
  const src = readFileSync(join(process.cwd(), 'app/guest/page.tsx'), 'utf8')

  it('the hero disclaimer is selected, not named', () => {
    expect(src).toMatch(/heroDisclaimerKey\(data\?\.realMoney/)
    // The bare key must not survive anywhere in the page.
    expect(src).not.toMatch(/t\('guest\.hero\.disclaimer'\)/)
  })

  it('every money sentence is passed the token noun', () => {
    for (const key of ['guest.how1.body', 'guest.trust.escrow', 'guest.top.body', 'guest.jobs.body', 'guest.agents.body']) {
      expect(src, `${key} renders without {token}`).toMatch(
        new RegExp(`t\\('${key.replace(/\./g, '\\.')}',\\s*\\{\\s*token\\s*\\}\\)`),
      )
    }
  })

  it('the token itself comes from live state', () => {
    expect(src).toMatch(/const token = t\(tokenKey\(data\?\.realMoney/)
  })

  /**
   * §28: the branch above was correct and still showed the neutral fallback on
   * BOTH deployments, because the value it branched on was gated behind
   * `isOnchainConfigured` — a predicate that requires a credit VAULT, which
   * neither Base deployment has. The page's environment claim must be gated on
   * the market whose money it describes, nothing more.
   */
  it('realMoney is gated on the labor market, not the vault (§28)', () => {
    const action = readFileSync(join(process.cwd(), 'app/actions/guest.ts'), 'utf8')
    expect(action).toMatch(/isLaborMarketConfigured\s*\(\)/)
    // The word may appear in comments (the fix explains itself); what must not
    // appear is a call or an import — the forms that gate anything.
    expect(
      /isOnchainConfigured\s*\(\)|\{[^}]*\bisOnchainConfigured\b[^}]*\}/.test(action),
      'marketRealMoney (or another guest gate) reaches for isOnchainConfigured — ' +
        'that predicate requires the vault and returns false on every vaultless deployment, ' +
        'which is what blanked the mainnet disclosure. See failure-modes §28.',
    ).toBe(false)
  })
})
