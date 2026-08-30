/**
 * The recipe endpoint tells a third party which address a genuine proof must
 * recover to. A fully paranoid verifier should not take that on our word, so
 * `docs/verifying-proofs.md` has always had a "don't even trust the recipe
 * endpoint" section naming an on-chain anchor to pin instead.
 *
 * For a long time that section named the wrong one. It said the oracle "signs
 * ERC-8004 validations on-chain, so its address appears on-chain as the
 * validator" — but the `erc8004` capability is OFF on the mainnet deployment
 * (`/api/capabilities`), so a verifier following that instruction would have
 * been sent to a registry this deployment has never written to. The anchor
 * that is real is `AgentCreditRegistry.oracle()`, a view call returning
 * exactly the attester address (checked against Base mainnet: registry
 * 0x91acc4C0…, oracle() → 0x81C76907…, equal to `/api/attestation`'s
 * `attester`).
 *
 * Invariant 28 is the reason this file exists: a documented invariant with no
 * test is a preference. The claim being pinned is an *external* interface —
 * another platform builds a verifier against it — so it drifting silently is
 * worse than most drift.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const route = readFileSync('app/api/attestation/route.ts', 'utf8')
const doc = readFileSync('docs/verifying-proofs.md', 'utf8')

describe('/api/attestation publishes an anchor a verifier can actually reach', () => {
  it('serves the anchor at all', () => {
    expect(route).toContain('attesterAnchor')
    expect(route).toContain("call: 'oracle()'")
  })

  it('derives the contract from config, never a hardcoded address', () => {
    expect(route).toContain('onchainEnv.registryAddress')
    // A literal 0x address in this file would be exactly the stale-published-
    // address failure the route's own header warns about: it would send
    // verifiers checking against the wrong contract, which is worse than
    // publishing no anchor at all.
    const literals = route.match(/['"]0x[0-9a-fA-F]{40}['"]/g) ?? []
    expect(literals).toEqual([])
  })

  it('derives the chain from CHAIN, so the anchor never asserts a network', () => {
    expect(route).toContain('chainId: CHAIN.id')
    expect(route).toContain('chain: CHAIN.name')
  })

  it('returns null rather than a fallback when no registry is configured', () => {
    // `? { … } : null` — a deployment without a registry must read as "no
    // anchor here", never as "trust the endpoint instead".
    expect(route).toMatch(/attesterAnchor: onchainEnv\.registryAddress\s*\?[\s\S]*?:\s*null/)
  })
})

describe('docs/verifying-proofs.md points at the anchor that exists', () => {
  it('documents the registry oracle() route', () => {
    expect(doc).toContain('attesterAnchor')
    expect(doc).toContain('oracle()')
  })

  it('no longer presents ERC-8004 as the live anchor', () => {
    // The capability is off on mainnet. If it is ever turned on, this
    // assertion is the right place to fail — deliberately, with a reason —
    // rather than the doc quietly regaining a claim nothing checks.
    expect(doc).not.toMatch(/oracle signs ERC-8004 validations on-chain/)
  })

  it('keeps the correction visible instead of silently rewriting history', () => {
    expect(doc).toContain('§41')
  })
})
