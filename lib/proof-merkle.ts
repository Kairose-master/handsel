/**
 * Merkle batching for work proofs — the pure half of proof anchoring.
 *
 * Every settled job already gets an EIP-712-signed proof (lib/attestation.ts),
 * off-chain and gas-free. What that proof cannot show a stranger is that it
 * EXISTED at a point in time and that the set of proofs has not been quietly
 * pruned since: a signature from a key we hold proves who signed, not when,
 * and a database we run proves nothing about deletions. Anchoring closes
 * both: every epoch, the proofs issued since the last anchor are hashed into
 * one Merkle root and that 32-byte root is written on-chain (ProofAnchor.sol,
 * one event per epoch). A proof plus its inclusion path then verifies
 * against the chain alone — no Handsel API in the loop.
 *
 * Cost shape (the reason it is a batch): one root per epoch regardless of how
 * many proofs it covers. The Agent Flight Recorder paper measured the same
 * design at roughly $2.30 per 100k events on an L2; ours is one small
 * transaction per hour at most.
 *
 * Leaf = keccak256(proofId ‖ contentHash ‖ signature) as canonical JSON, so a
 * leaf commits to the specific signed record, not just to the deliverable.
 * Tree = sorted-pair keccak (OpenZeppelin MerkleProof-compatible), duplicate
 * last leaf on odd levels. Pure; the chain and the store are elsewhere.
 */
import { keccak256, type Hex } from 'viem'
import { canonicalJson } from '@/lib/attestation'

export type ProofLeafInput = { id: string; contentHash: Hex; signature: Hex | string }

export function proofLeaf(p: ProofLeafInput): Hex {
  return keccak256(Buffer.from(canonicalJson({ id: p.id, contentHash: p.contentHash, signature: p.signature }), 'utf8'))
}

function hexToBytes(h: Hex): Buffer {
  return Buffer.from(h.slice(2), 'hex')
}

/** OpenZeppelin-style commutative pair hash: sort, then keccak of the concat. */
export function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return keccak256(Buffer.concat([hexToBytes(lo), hexToBytes(hi)]))
}

export type MerkleTree = { root: Hex; layers: Hex[][] }

export function buildTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error('cannot build a tree over zero leaves')
  const layers: Hex[][] = [leaves.map((l) => l.toLowerCase() as Hex)]
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1]
    const next: Hex[] = []
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i]
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i]
      next.push(hashPair(left, right))
    }
    layers.push(next)
  }
  return { root: layers[layers.length - 1][0], layers }
}

/** Sibling path from a leaf to the root, in bottom-up order. */
export function inclusionProof(tree: MerkleTree, leafIndex: number): Hex[] {
  if (leafIndex < 0 || leafIndex >= tree.layers[0].length) throw new Error('leaf index out of range')
  const path: Hex[] = []
  let idx = leafIndex
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level]
    const sibling = idx % 2 === 0 ? (idx + 1 < layer.length ? layer[idx + 1] : layer[idx]) : layer[idx - 1]
    path.push(sibling)
    idx = Math.floor(idx / 2)
  }
  return path
}

/** Recompute the root from a leaf and its path. Pure and local — the check a
 *  third party runs against the on-chain root. */
export function verifyInclusion(leaf: Hex, path: readonly Hex[], root: Hex): boolean {
  let acc = leaf.toLowerCase() as Hex
  for (const sib of path) acc = hashPair(acc, sib)
  return acc === root.toLowerCase()
}

/** What an anchor record carries, on-chain and in the store. */
export type ProofAnchorRecord = {
  epoch: number
  root: Hex
  count: number
  /** ISO timestamps of the first and last proof in the batch. */
  from: string
  to: string
}
