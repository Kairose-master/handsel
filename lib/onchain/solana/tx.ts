/**
 * Instruction encoding for the devnet program — the PURE half of the write
 * path. Everything here is bytes-in-bytes-out and unit-testable without a
 * cluster; signing and sending live in `write.ts`, which is the only file
 * that needs an SDK.
 *
 * The same duplication rule as the codec applies (see `codec.ts` and
 * `tests/solana-codec.test.ts`): the instruction names, argument layouts and
 * account orders here are duplicated from the Rust, and duplication nobody
 * checks is a second place to be wrong — so `tests/solana-tx.test.ts` reads
 * `solana/programs/handsel-market/src/lib.rs` and asserts this file against
 * it. A new instruction, a reordered account, or a changed argument fails at
 * `npm run test`, not on devnet.
 */
import { createHash } from 'node:crypto'
import { base58Decode } from './codec'
import type { SolanaMarket } from './codec'

/** Anchor's instruction discriminator: sha256("global:<snake_name>")[0..8]. */
export function instructionDiscriminator(snakeName: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${snakeName}`).digest().subarray(0, 8))
}

// ── little-endian scalar encoders ─────────────────────────────────────────

export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${value}`)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

export function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`u32 out of range: ${value}`)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function bytes32(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`not a 32-byte hex string: ${hex}`)
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function pubkeyBytes(address: string): Uint8Array {
  const decoded = base58Decode(address)
  if (!decoded || decoded.length !== 32) throw new Error(`not a valid address: ${address}`)
  return decoded
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ── instruction data (discriminator + Borsh args) ─────────────────────────

/** post_job(bounty: u64, min_score: u64, spec_hash: [u8;32], delivery_window: u32) */
export function encodePostJob(bounty: bigint, minScore: bigint, specHashHex: string, deliveryWindow: number): Uint8Array {
  return concat(
    instructionDiscriminator('post_job'),
    u64le(bounty),
    u64le(minScore),
    bytes32(specHashHex),
    u32le(deliveryWindow),
  )
}

/** accept_job() */
export const encodeAcceptJob = () => instructionDiscriminator('accept_job')

/** submit_work(result_hash: [u8;32]) */
export function encodeSubmitWork(resultHashHex: string): Uint8Array {
  return concat(instructionDiscriminator('submit_work'), bytes32(resultHashHex))
}

/** approve_job() */
export const encodeApproveJob = () => instructionDiscriminator('approve_job')

/** expire_review() */
export const encodeExpireReview = () => instructionDiscriminator('expire_review')

/** cancel_job() */
export const encodeCancelJob = () => instructionDiscriminator('cancel_job')

/** reclaim_job() */
export const encodeReclaimJob = () => instructionDiscriminator('reclaim_job')

/** withdraw() */
export const encodeWithdraw = () => instructionDiscriminator('withdraw')

/** set_credit(agent: Pubkey, score: u64, limit: u64) */
export function encodeSetCredit(agent: string, score: bigint, limit: bigint): Uint8Array {
  return concat(instructionDiscriminator('set_credit'), pubkeyBytes(agent), u64le(score), u64le(limit))
}

// ── fee / bond mirrors ────────────────────────────────────────────────────
// Duplicated from the program's fee_for/bond_for on purpose, same as the
// happy-path script: a constant changed on one side and not the other should
// fail an assertion loudly, not let the client quietly agree with the chain.

const BPS_DENOM = 10_000n

export function feeFor(market: Pick<SolanaMarket, 'feeBps' | 'flatFee'>, bounty: bigint): bigint {
  return market.flatFee + (bounty * BigInt(market.feeBps)) / BPS_DENOM
}

export function bondFor(market: Pick<SolanaMarket, 'bondBps' | 'flatBond'>, bounty: bigint): bigint {
  return market.flatBond + (bounty * BigInt(market.bondBps)) / BPS_DENOM
}

// ── account orders ────────────────────────────────────────────────────────
// One entry per #[derive(Accounts)] field, in DECLARATION ORDER — the order
// IS the wire format for Anchor. `signer`/`writable` mirror the Rust
// attributes. The test parses the Rust structs and diffs against these.

export interface AccountSpec {
  /** snake_case field name as it appears in the Rust struct. */
  name: string
  writable: boolean
  signer: boolean
}

const a = (name: string, writable = false, signer = false): AccountSpec => ({ name, writable, signer })

/** Instruction name → its Accounts struct name and ordered account list. */
export const INSTRUCTION_ACCOUNTS: Record<string, { struct: string; accounts: AccountSpec[] }> = {
  post_job: {
    struct: 'PostJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('requester', true, true),
      a('requester_token', true),
      a('vault', true),
      a('token_program'),
      a('system_program'),
    ],
  },
  accept_job: {
    struct: 'AcceptJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('worker', true, true),
      a('worker_token', true),
      a('vault', true),
      a('worker_credit'), // Option<...> — pass the program id itself for None
      a('token_program'),
    ],
  },
  submit_work: {
    struct: 'WorkerOnJob',
    accounts: [a('market'), a('job', true), a('worker', false, true)],
  },
  approve_job: {
    struct: 'SettleJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('authority', true, true),
      a('worker_withdrawable', true),
      a('fee_withdrawable', true),
      a('system_program'),
    ],
  },
  expire_review: {
    struct: 'SettleJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('authority', true, true),
      a('worker_withdrawable', true),
      a('fee_withdrawable', true),
      a('system_program'),
    ],
  },
  cancel_job: {
    struct: 'RefundJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('requester', true, true),
      a('requester_withdrawable', true),
      a('system_program'),
    ],
  },
  reclaim_job: {
    struct: 'ReclaimJob',
    accounts: [
      a('market', true),
      a('job', true),
      a('requester', true, true),
      a('requester_withdrawable', true),
      a('usdc_mint', true),
      a('vault', true),
      a('token_program'),
      a('system_program'),
    ],
  },
  withdraw: {
    struct: 'Withdraw',
    accounts: [
      a('market', true),
      a('withdrawable', true),
      a('owner', false, true),
      a('owner_token', true),
      a('vault', true),
      a('token_program'),
    ],
  },
  set_credit: {
    struct: 'SetCredit',
    accounts: [a('market'), a('credit', true), a('oracle', true, true), a('system_program')],
  },
}

/** PDA seed layouts, mirrored from the Rust `seeds = [...]` attributes.
 *  Derivation itself (the ed25519 off-curve search) lives in write.ts with
 *  the SDK; the SEEDS are pure data and pinned by the test. */
export const PDA_SEEDS = {
  market: () => [Buffer.from('market')],
  vault: () => [Buffer.from('vault')],
  job: (id: bigint) => [Buffer.from('job'), Buffer.from(u64le(id))],
  withdrawable: (owner: string) => [Buffer.from('withdrawable'), Buffer.from(pubkeyBytes(owner))],
  credit: (agent: string) => [Buffer.from('credit'), Buffer.from(pubkeyBytes(agent))],
} as const
