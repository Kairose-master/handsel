import { describe, expect, it } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { buildTree, hashPair, inclusionProof, proofLeaf, verifyInclusion } from '@/lib/proof-merkle'

/**
 * The Merkle batch that ProofAnchor.sol anchors. Pinned: sorted-pair hashing
 * (so the Solidity verify() and this file agree), odd-level duplication, that
 * every leaf's path verifies and no tampered leaf does, and that a leaf
 * commits to the signed record (id + contentHash + signature), not just the
 * deliverable.
 */

const h = (s: string) => keccak256(Buffer.from(s)) as Hex

describe('hashPair', () => {
  it('is commutative — the property Solidity verify() relies on', () => {
    expect(hashPair(h('a'), h('b'))).toBe(hashPair(h('b'), h('a')))
  })
  it('matches keccak256(lo ‖ hi) byte for byte', () => {
    const a = h('a'), b = h('b')
    const [lo, hi] = a < b ? [a, b] : [b, a]
    expect(hashPair(a, b)).toBe(keccak256(Buffer.concat([Buffer.from(lo.slice(2), 'hex'), Buffer.from(hi.slice(2), 'hex')])))
  })
})

describe('buildTree + inclusionProof + verifyInclusion', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 13]) {
    it(`every one of ${n} leaves verifies against the root`, () => {
      const leaves = Array.from({ length: n }, (_, i) => h(`leaf-${i}`))
      const tree = buildTree(leaves)
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(leaves[i], inclusionProof(tree, i), tree.root)).toBe(true)
      }
    })
  }
  it('a single leaf is its own root with an empty path', () => {
    const tree = buildTree([h('only')])
    expect(tree.root).toBe(h('only'))
    expect(inclusionProof(tree, 0)).toEqual([])
  })
  it('a tampered leaf or a wrong path fails', () => {
    const leaves = [h('a'), h('b'), h('c')]
    const tree = buildTree(leaves)
    const path = inclusionProof(tree, 1)
    expect(verifyInclusion(h('b'), path, tree.root)).toBe(true)
    expect(verifyInclusion(h('B'), path, tree.root)).toBe(false)
    expect(verifyInclusion(h('b'), inclusionProof(tree, 0), tree.root)).toBe(false)
  })
  it('refuses an empty batch and an out-of-range index', () => {
    expect(() => buildTree([])).toThrow()
    expect(() => inclusionProof(buildTree([h('a')]), 1)).toThrow()
  })
  it('the root depends on order (an anchor commits to a sequence)', () => {
    expect(buildTree([h('a'), h('b'), h('c')]).root).not.toBe(buildTree([h('c'), h('b'), h('a')]).root)
  })
})

describe('proofLeaf', () => {
  it('commits to the signed record, so re-signing the same deliverable is a different leaf', () => {
    const base = { id: 'p1', contentHash: h('deliverable'), signature: '0xsig1' }
    expect(proofLeaf(base)).toBe(proofLeaf({ ...base }))
    expect(proofLeaf(base)).not.toBe(proofLeaf({ ...base, signature: '0xsig2' }))
    expect(proofLeaf(base)).not.toBe(proofLeaf({ ...base, id: 'p2' }))
  })
})
