/**
 * Reading Solana accounts without a Solana SDK.
 *
 * Everything here is pure: bytes in, values out, no network and no clock. That
 * is deliberate and it is also why there is no `@solana/web3.js` dependency on
 * the read path — decoding an Anchor account is base58, base64, an 8-byte
 * discriminator and fixed-width little-endian fields, and all four are cheaper
 * to write and test than to install.
 *
 * The write path is a different question (signing needs ed25519 and transaction
 * serialisation, which is exactly what an SDK is for). Reads carry the board,
 * so they come first and they come dependency-free.
 *
 * The layout below MUST match `solana/programs/handsel-market/src/lib.rs`. It
 * is duplicated rather than generated from the IDL on purpose: the IDL only
 * exists after `anchor build`, which needs a toolchain the web app does not
 * have, and a build-time artifact that can be missing is a runtime failure
 * waiting for a deploy. `tests/solana-codec.test.ts` pins the layout so a
 * change on the Rust side that nobody mirrored here fails loudly.
 */
import { createHash } from 'node:crypto'

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]))

/**
 * Decode a base58 string to bytes. Returns null on any invalid character — a
 * caller holding a typo'd address should get "no" rather than a silently
 * different address.
 *
 * Leading `1`s are leading ZERO BYTES and are counted separately from the
 * numeric part, which is the whole subtlety of this encoding. A naive
 * accumulator that starts at `[0]` and appends a zero per leading `1` emits
 * one byte too many, and the failure is invisible on ordinary addresses — it
 * only shows on the ones that start with zeros, of which the system program
 * (32 of them) is the most common address in Solana.
 */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null
  let zeros = 0
  while (zeros < input.length && input[zeros] === '1') zeros++

  const size = input.length
  const buffer = new Uint8Array(size)
  let length = 0
  for (let i = zeros; i < input.length; i++) {
    const value = B58_INDEX.get(input[i])
    if (value === undefined) return null
    let carry = value
    let used = 0
    for (let j = size - 1; (carry !== 0 || used < length) && j >= 0; j--, used++) {
      carry += 58 * buffer[j]
      buffer[j] = carry % 256
      carry = (carry / 256) | 0
    }
    length = used
  }

  const out = new Uint8Array(zeros + length)
  out.set(buffer.subarray(size - length), zeros)
  return out
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  // log(256)/log(58) ≈ 1.366, so twice the input is a safe bound.
  const size = bytes.length * 2
  const buffer = new Uint8Array(size)
  let length = 0
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    let used = 0
    for (let j = size - 1; (carry !== 0 || used < length) && j >= 0; j--, used++) {
      carry += 256 * buffer[j]
      buffer[j] = carry % 58
      carry = (carry / 58) | 0
    }
    length = used
  }

  let out = '1'.repeat(zeros)
  for (let i = size - length; i < size; i++) out += B58_ALPHABET[buffer[i]]
  return out
}

/** A 32-byte Solana address, or null. Length is checked because base58 happily
 *  decodes a string of any length and a 31-byte "address" is not one. */
export function isValidAddress(input: string): boolean {
  const bytes = base58Decode(input)
  return bytes !== null && bytes.length === 32
}

/**
 * Anchor's account discriminator: the first 8 bytes of
 * `sha256("account:" + StructName)`, prepended to every account it owns.
 *
 * This is what makes a dependency-free read possible — `getProgramAccounts`
 * with a memcmp filter on these 8 bytes returns every Job and nothing else,
 * so no PDA has to be derived to enumerate the board.
 */
export function accountDiscriminator(structName: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`account:${structName}`).digest().subarray(0, 8))
}

/** Program status enum, in declaration order — Borsh encodes a fieldless enum
 *  as its variant index. Order is load-bearing; see the codec test. */
export const SOLANA_JOB_STATUS = [
  'Open',
  'Accepted',
  'Submitted',
  'Completed',
  'Cancelled',
  'Reclaimed',
] as const
export type SolanaJobStatus = (typeof SOLANA_JOB_STATUS)[number]

export type SolanaJob = {
  id: number
  requester: string
  worker: string
  bounty: bigint
  fee: bigint
  bond: bigint
  minScore: number
  specHash: string
  resultHash: string
  status: SolanaJobStatus
  createdAt: number
  deliveryWindow: number
  acceptedAt: number
  reviewDeadline: number
}

/** 8 discriminator + the struct's fixed-width fields. Every account this
 *  program writes is fixed size, so a wrong length is a wrong account. */
export const JOB_ACCOUNT_SIZE = 206

class Cursor {
  private offset = 0
  constructor(private readonly view: DataView, private readonly bytes: Uint8Array) {}
  skip(n: number) {
    this.offset += n
  }
  u8(): number {
    return this.view.getUint8(this.offset++)
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return v
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return v
  }
  bytes32(): Uint8Array {
    const v = this.bytes.subarray(this.offset, this.offset + 32)
    this.offset += 32
    return v
  }
}

function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Decode one `Job` account.
 *
 * Returns null rather than throwing on a wrong discriminator or length: this
 * runs over whatever `getProgramAccounts` returned, and one unrecognised
 * account (a Market, a Withdrawable, a future struct) must not take the board
 * down. Callers filter nulls.
 */
export function decodeJobAccount(data: Uint8Array): SolanaJob | null {
  if (data.length !== JOB_ACCOUNT_SIZE) return null
  const expected = accountDiscriminator('Job')
  for (let i = 0; i < 8; i++) if (data[i] !== expected[i]) return null

  const cursor = new Cursor(new DataView(data.buffer, data.byteOffset, data.byteLength), data)
  cursor.skip(8)

  const id = cursor.u64()
  const requester = base58Encode(cursor.bytes32())
  const worker = base58Encode(cursor.bytes32())
  const bounty = cursor.u64()
  const fee = cursor.u64()
  const bond = cursor.u64()
  const minScore = cursor.u64()
  const specHash = toHex(cursor.bytes32())
  const resultHash = toHex(cursor.bytes32())
  const statusIndex = cursor.u8()
  const createdAt = cursor.i64()
  const deliveryWindow = cursor.u32()
  const acceptedAt = cursor.i64()
  const reviewDeadline = cursor.i64()

  const status = SOLANA_JOB_STATUS[statusIndex]
  // An unknown variant means the program grew a state this build has never
  // heard of. Guessing which one would put a verdict on the board that nobody
  // reached — the same mistake `OnchainJob.status` widened to `Expired` to
  // avoid — so the row is dropped and the caller reports a short read.
  if (!status) return null

  return {
    id: Number(id),
    requester,
    worker,
    bounty,
    fee,
    bond,
    minScore: Number(minScore),
    specHash,
    resultHash,
    status,
    createdAt: Number(createdAt),
    deliveryWindow,
    acceptedAt: Number(acceptedAt),
    reviewDeadline: Number(reviewDeadline),
  }
}

/**
 * The deadline that governs a job's CURRENT state, or null when none does.
 *
 * Same reasoning as `OnchainJob.deadline` on the EVM side: status alone does
 * not say what may be done to a job, because the enum only changes when
 * somebody CALLS an exit. An `Accepted` job whose delivery window lapsed an
 * hour ago still reads `Accepted`, and the difference between the two is
 * whether `submit_work` reverts.
 *
 * `Open` has no deadline here and that is not an oversight — open-window
 * expiry is a documented v0.1 cut (`docs/solana-port.md`). Returning null says
 * "nothing is counting down", which is true, rather than inventing one.
 */
export function jobDeadline(job: SolanaJob): number | null {
  switch (job.status) {
    case 'Accepted':
      return job.acceptedAt + job.deliveryWindow
    case 'Submitted':
      return job.reviewDeadline
    default:
      return null
  }
}

/** Whether a submission actually landed on chain. The zero hash is the exact
 *  signal `lib/job-grade.ts` reads on the EVM side, kept bit-compatible so one
 *  rule covers both runtimes. */
export function hasSubmission(job: SolanaJob): boolean {
  return /[1-9a-f]/.test(job.resultHash.slice(2))
}

export type SolanaMarket = {
  authority: string
  oracle: string
  feeRecipient: string
  usdcMint: string
  vault: string
  feeBps: number
  flatFee: bigint
  bondBps: number
  flatBond: bigint
  reviewWindow: number
  minBounty: bigint
  jobCount: number
  totalEscrowed: bigint
  totalWithdrawable: bigint
}

export type SolanaLedger = { owner: string; amount: bigint; bump: number }

export const MARKET_ACCOUNT_SIZE = 225
export const WITHDRAWABLE_ACCOUNT_SIZE = 49

function discriminatorMatches(data: Uint8Array, structName: string): boolean {
  const expected = accountDiscriminator(structName)
  for (let i = 0; i < 8; i++) if (data[i] !== expected[i]) return false
  return true
}

/** Decode the singleton `Market`. Null on a wrong discriminator or length, for
 *  the same reason `decodeJobAccount` does: this runs over everything
 *  `getProgramAccounts` returned. */
export function decodeMarketAccount(data: Uint8Array): SolanaMarket | null {
  if (data.length !== MARKET_ACCOUNT_SIZE) return null
  if (!discriminatorMatches(data, 'Market')) return null

  const cursor = new Cursor(new DataView(data.buffer, data.byteOffset, data.byteLength), data)
  cursor.skip(8)
  return {
    authority: base58Encode(cursor.bytes32()),
    oracle: base58Encode(cursor.bytes32()),
    feeRecipient: base58Encode(cursor.bytes32()),
    usdcMint: base58Encode(cursor.bytes32()),
    vault: base58Encode(cursor.bytes32()),
    feeBps: cursor.u16(),
    flatFee: cursor.u64(),
    bondBps: cursor.u16(),
    flatBond: cursor.u64(),
    reviewWindow: cursor.u32(),
    minBounty: cursor.u64(),
    jobCount: Number(cursor.u64()),
    totalEscrowed: cursor.u64(),
    totalWithdrawable: cursor.u64(),
  }
}

/** Decode one pull-payment ledger. */
export function decodeWithdrawableAccount(data: Uint8Array): SolanaLedger | null {
  if (data.length !== WITHDRAWABLE_ACCOUNT_SIZE) return null
  if (!discriminatorMatches(data, 'Withdrawable')) return null

  const cursor = new Cursor(new DataView(data.buffer, data.byteOffset, data.byteLength), data)
  cursor.skip(8)
  return { owner: base58Encode(cursor.bytes32()), amount: cursor.u64(), bump: cursor.u8() }
}

/**
 * What the program's own accounting says each job should still be holding.
 *
 * `post_job` escrows bounty + fee; `accept_job` adds the bond; every exit
 * (`credit`, the reclaim burn) takes it back out. So a job's contribution to
 * `total_escrowed` is decided entirely by its status.
 */
export function escrowHeldBy(job: SolanaJob): bigint {
  switch (job.status) {
    case 'Open':
      return job.bounty + job.fee
    case 'Accepted':
    case 'Submitted':
      return job.bounty + job.fee + job.bond
    default:
      return 0n
  }
}

export type Invariant = { name: string; ok: boolean; detail: string }

/**
 * The checks that decide whether the market is telling the truth.
 *
 * Pure on purpose: the network fetch belongs to the caller, so every one of
 * these is exercised by unit tests against hand-built states rather than by
 * hoping devnet produces the interesting case. `vaultAmount` is the vault
 * token account's balance, or null when it could not be read — an unread
 * balance reports as an unrun check, never as a passing one.
 *
 * The one that matters most is solvency, and it is one comparison, as the
 * program's own header says: the vault must hold at least what the market
 * claims to owe. It is stated as `>=` rather than `==` because a donation to
 * the vault is not a defect; owing more than you hold is.
 */
export function checkMarketInvariants(state: {
  market: SolanaMarket
  jobs: SolanaJob[]
  ledgers: SolanaLedger[]
  vaultAmount: bigint | null
}): { ok: boolean; checks: Invariant[] } {
  const { market, jobs, ledgers, vaultAmount } = state
  const checks: Invariant[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const ids = new Set(jobs.map((j) => j.id))
  const missing = [...Array(market.jobCount).keys()].filter((i) => !ids.has(i))
  add(
    'every posted job has an account',
    missing.length === 0 && jobs.length === market.jobCount,
    missing.length ? `job_count=${market.jobCount}, missing #${missing.join(', #')}` : `${jobs.length} of ${market.jobCount}`,
  )

  const escrowExpected = jobs.reduce((sum, j) => sum + escrowHeldBy(j), 0n)
  add(
    'total_escrowed matches the open jobs',
    market.totalEscrowed === escrowExpected,
    `market says ${market.totalEscrowed}, jobs imply ${escrowExpected}`,
  )

  const owedExpected = ledgers.reduce((sum, l) => sum + l.amount, 0n)
  add(
    'total_withdrawable matches the ledgers',
    market.totalWithdrawable === owedExpected,
    `market says ${market.totalWithdrawable}, ledgers hold ${owedExpected}`,
  )

  const owed = market.totalEscrowed + market.totalWithdrawable
  add(
    'solvent — the vault covers what is owed',
    vaultAmount !== null && vaultAmount >= owed,
    vaultAmount === null ? 'vault balance unread' : `owes ${owed}, holds ${vaultAmount}`,
  )

  // A Completed job with a zero result hash means settlement ran without a
  // deliverable — the exact shape `hasSubmission` exists to catch on the EVM
  // side, checked here against the chain rather than against a request.
  const settledBlind = jobs.filter((j) => j.status === 'Completed' && !hasSubmission(j))
  add(
    'no job completed without a submission',
    settledBlind.length === 0,
    settledBlind.length ? `#${settledBlind.map((j) => j.id).join(', #')}` : `${jobs.filter((j) => j.status === 'Completed').length} completed`,
  )

  // `credit()` stamps the owner on first use. A funded ledger owned by nobody
  // is the bug this sprint already paid for once.
  const orphaned = ledgers.filter((l) => l.amount > 0n && /^1{32}$/.test(l.owner))
  add('no funded ledger without an owner', orphaned.length === 0, `${ledgers.length} ledgers`)

  return { ok: checks.every((c) => c.ok), checks }
}
