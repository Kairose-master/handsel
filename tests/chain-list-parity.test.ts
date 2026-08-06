import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The app and the deploy scripts must agree on which chains exist.
 *
 * They did not. The scripts take `base-sepolia` (their DEFAULT) or `base`; the
 * app took `sepolia`, `giwa-sepolia` or `base`. The two overlapped on mainnet
 * alone — so the chain every testnet deploy actually landed on was one the app
 * had no name for.
 *
 * And the app answered that with `?? sepolia`, which is the part that makes it
 * a real defect rather than a missing entry: pointed at a market deployed to
 * Base Sepolia, it would read that address on Ethereum Sepolia, every call
 * would revert, `isV2Market()` would answer false, and the app would go on
 * behaving as a V1 market. Every V2 path — the bond approval, `postCost`, the
 * four permissionless exits, the withdraw sweep — would silently not run.
 *
 * Measured: a market at 0xbd0fb5… on Base Sepolia (84532), an app that could
 * only be told to look at 11155111.
 *
 * That address is HISTORICAL — it is the rehearsal deploy this defect was
 * measured against, not the live testnet market, which is now
 * 0xD9bCF174…. Left in place because it is evidence for the defect above,
 * and labelled because it was read out of this comment and copied into
 * docs/deployments.md as though it were current (§27). Run
 * `node scripts/verify-deployments.mjs` for the live answer.
 */

const config = readFileSync('lib/onchain/config.ts', 'utf8')

/**
 * Chain KEYS the app accepts, read from the CHAINS literal.
 *
 * Split on commas and take the part before a colon, rather than one regex over
 * the whole literal: a pattern loose enough to catch both `sepolia` (shorthand)
 * and `'base-sepolia': baseSepolia` also catches `giwaSepolia` — the VALUE — and
 * reports it as an accepted chain name. Which is worse than missing one,
 * because the list then looks longer than it is.
 */
function appChains(): string[] {
  const m = config.match(/const CHAINS = \{([^}]*)\}/)
  if (!m) throw new Error('could not find the CHAINS literal in config.ts')
  return m[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes(':') ? entry.split(':')[0] : entry))
    .map((key) => key.trim().replace(/^['"]|['"]$/g, ''))
}

/** Chain names a deploy script will accept. */
function scriptChains(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const m of src.matchAll(/ONCHAIN_CHAIN\s*\|\|\s*'([^']+)'/g)) names.add(m[1])
  for (const m of src.matchAll(/ONCHAIN_CHAIN\s*\?\?\s*'([^']+)'/g)) names.add(m[1])
  for (const m of src.matchAll(/chainName === '([^']+)'/g)) names.add(m[1])
  for (const m of src.matchAll(/=== '([^']+)'\s*$/gm)) names.add(m[1])
  return [...names]
}

describe('the app can name every chain the scripts deploy to', () => {
  it('parses both sides — the extraction is the test here', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass while checking nothing, which is the failure mode of source scans.
    expect(appChains().length).toBeGreaterThanOrEqual(3)
    expect(appChains()).toContain('base')
    expect(scriptChains('scripts/deploy-labor-v2.mjs').length).toBeGreaterThan(0)
  })

  it('knows base-sepolia, where the deploy scripts default', () => {
    expect(appChains()).toContain('base-sepolia')
  })

  for (const script of ['scripts/deploy-labor-v2.mjs', 'scripts/deploy-registry.mjs']) {
    it(`covers every chain ${script} accepts`, () => {
      const missing = scriptChains(script).filter((c) => !appChains().includes(c))
      expect(missing, `${script} can deploy to chains the app cannot name: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('refuses an unrecognised ONCHAIN_CHAIN instead of picking one', () => {
    // The silent fallback is the whole defect. `?? sepolia` turns a typo into a
    // working app reading the wrong chain — the one failure where a wrong
    // answer is indistinguishable from a right one.
    expect(config).not.toMatch(/CHAINS\[[^\]]*\]\s*\?\?\s*sepolia/)
    expect(config).toMatch(/is not a chain this app knows/)
  })

  it('still allows the chain to be unset', () => {
    // Absent means "no on-chain layer", which is a supported way to run this
    // app and must not throw. Only a present-but-unknown value is an error.
    expect(config).toMatch(/if \(chainName && !\(chainName in CHAINS\)\)/)
  })
})
