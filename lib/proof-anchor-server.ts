/**
 * Proof anchoring — the impure half of lib/proof-merkle.ts.
 *
 * Once per ops cycle, every work proof issued since the last anchor is
 * batched into a Merkle tree and the root is written to ProofAnchor.sol by
 * the attestation oracle. Each proof row then remembers its epoch and leaf
 * index, so `inclusionFor(proofId)` can hand a verifier the path they need
 * to check the proof against the chain with nothing from us but the bytes.
 *
 * Off unless `PROOF_ANCHOR_ADDRESS` is set (the optional-on-chain
 * convention). Never blocks issuance: proofs are issued unanchored and picked
 * up by the next sweep. Epoch = the unix hour, bumped past the contract's
 * `latestEpoch` if the clock and the chain ever disagree, because the
 * contract refuses a non-increasing epoch and a refused anchor is a batch
 * that never gets anchored.
 */
import { pool } from '@/lib/db'
import { buildTree, inclusionProof, proofLeaf, type ProofAnchorRecord } from '@/lib/proof-merkle'
import type { Hex } from 'viem'

export const PROOF_ANCHOR_BATCH_MAX = 4096

export function proofAnchorAddress(): Hex | null {
  const a = process.env.PROOF_ANCHOR_ADDRESS
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Hex) : null
}

let ensured: Promise<void> | null = null
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS proof_anchors (
           epoch bigint PRIMARY KEY,
           root text NOT NULL,
           count integer NOT NULL,
           from_ts timestamptz NOT NULL,
           to_ts timestamptz NOT NULL,
           tx_hash text NOT NULL,
           contract text NOT NULL,
           chain_id integer NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      await pool.query(`ALTER TABLE work_proofs ADD COLUMN IF NOT EXISTS anchor_epoch bigint`)
      await pool.query(`ALTER TABLE work_proofs ADD COLUMN IF NOT EXISTS anchor_index integer`)
      await pool.query(`CREATE INDEX IF NOT EXISTS work_proofs_anchor_idx ON work_proofs (anchor_epoch, anchor_index)`)
    })().catch((e) => {
      ensured = null
      throw e
    })
  }
  return ensured
}

type PendingRow = { id: string; content_hash: Hex; signature: string; created_at: Date }

export type AnchorSweepResult =
  | { status: 'idle'; reason: 'unconfigured' | 'nothing-pending' }
  | { status: 'anchored'; record: ProofAnchorRecord; txHash: Hex }
  | { status: 'failed'; error: string }

/** The ops-cycle step. One batch per call; a backlog drains over cycles. */
export async function anchorPendingProofs(now = new Date()): Promise<AnchorSweepResult> {
  const contract = proofAnchorAddress()
  if (!contract) return { status: 'idle', reason: 'unconfigured' }
  try {
    await ensureTables()
    const { rows } = await pool.query<PendingRow>(
      `SELECT id, content_hash, signature, created_at FROM work_proofs
        WHERE anchor_epoch IS NULL ORDER BY created_at, id LIMIT $1`,
      [PROOF_ANCHOR_BATCH_MAX],
    )
    if (rows.length === 0) return { status: 'idle', reason: 'nothing-pending' }

    const leaves = rows.map((r) => proofLeaf({ id: r.id, contentHash: r.content_hash, signature: r.signature }))
    const tree = buildTree(leaves)

    const { publicClient, oracleWallet } = await import('@/lib/onchain/clients')
    const { PROOF_ANCHOR_ABI } = await import('@/lib/onchain/proof-anchor-artifact')
    const { CHAIN } = await import('@/lib/onchain/config')
    const client = publicClient()
    const latest = (await client.readContract({ address: contract, abi: PROOF_ANCHOR_ABI, functionName: 'latestEpoch' })) as bigint
    const hourEpoch = BigInt(Math.floor(now.getTime() / 3_600_000))
    const epoch = hourEpoch > latest ? hourEpoch : latest + 1n

    const fromTs = rows[0].created_at
    const toTs = rows[rows.length - 1].created_at
    const wallet = oracleWallet()
    const txHash = await wallet.writeContract({
      address: contract,
      abi: PROOF_ANCHOR_ABI,
      functionName: 'anchor',
      args: [epoch, tree.root, rows.length, BigInt(Math.floor(fromTs.getTime() / 1000)), BigInt(Math.floor(toTs.getTime() / 1000))],
    })
    const receipt = await client.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') return { status: 'failed', error: `anchor tx ${txHash} reverted` }

    // Only after the chain has it: a DB row that says "anchored" for a
    // reverted transaction would be exactly the kind of claim this exists
    // to make impossible.
    await pool.query(
      `INSERT INTO proof_anchors (epoch, root, count, from_ts, to_ts, tx_hash, contract, chain_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [epoch.toString(), tree.root, rows.length, fromTs, toTs, txHash, contract, CHAIN.id],
    )
    for (let i = 0; i < rows.length; i++) {
      await pool.query(`UPDATE work_proofs SET anchor_epoch = $1, anchor_index = $2 WHERE id = $3`, [epoch.toString(), i, rows[i].id])
    }
    return {
      status: 'anchored',
      txHash,
      record: { epoch: Number(epoch), root: tree.root, count: rows.length, from: fromTs.toISOString(), to: toTs.toISOString() },
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

export type ProofInclusion = {
  proofId: string
  leaf: Hex
  epoch: number
  index: number
  root: Hex
  path: Hex[]
  txHash: string
  contract: string
  chainId: number
  /** How to check it with nothing but an RPC: call `verify(epoch, leaf, path)`. */
  verify: string
}

/** The inclusion path for one anchored proof, or null if it is not anchored
 *  yet (or anchoring is off). Rebuilds the epoch's tree from the stored
 *  order — leaves are recomputed from the rows, never trusted from a cache. */
export async function inclusionFor(proofId: string): Promise<ProofInclusion | null> {
  try {
    await ensureTables()
    const { rows: mine } = await pool.query<{ anchor_epoch: string | null; anchor_index: number | null }>(
      `SELECT anchor_epoch, anchor_index FROM work_proofs WHERE id = $1`,
      [proofId],
    )
    const me = mine[0]
    if (!me || me.anchor_epoch === null || me.anchor_index === null) return null
    const { rows } = await pool.query<PendingRow>(
      `SELECT id, content_hash, signature, created_at FROM work_proofs WHERE anchor_epoch = $1 ORDER BY anchor_index`,
      [me.anchor_epoch],
    )
    const { rows: anchors } = await pool.query<{ root: Hex; tx_hash: string; contract: string; chain_id: number }>(
      `SELECT root, tx_hash, contract, chain_id FROM proof_anchors WHERE epoch = $1`,
      [me.anchor_epoch],
    )
    const anchor = anchors[0]
    if (!anchor) return null
    const leaves = rows.map((r) => proofLeaf({ id: r.id, contentHash: r.content_hash, signature: r.signature }))
    const tree = buildTree(leaves)
    if (tree.root !== anchor.root.toLowerCase()) return null // the store disagrees with what was anchored — say nothing rather than something false
    const index = me.anchor_index
    return {
      proofId,
      leaf: leaves[index],
      epoch: Number(me.anchor_epoch),
      index,
      root: tree.root,
      path: inclusionProof(tree, index),
      txHash: anchor.tx_hash,
      contract: anchor.contract,
      chainId: anchor.chain_id,
      verify: `ProofAnchor(${anchor.contract}).verify(${me.anchor_epoch}, leaf, path) on chain ${anchor.chain_id}; leaf = keccak256(canonicalJson({id, contentHash, signature}))`,
    }
  } catch {
    return null
  }
}
