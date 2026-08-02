import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JOB_ACCOUNT_SIZE,
  MARKET_ACCOUNT_SIZE,
  SOLANA_JOB_STATUS,
  WITHDRAWABLE_ACCOUNT_SIZE,
  accountDiscriminator,
  base58Decode,
  base58Encode,
  checkMarketInvariants,
  decodeJobAccount,
  decodeMarketAccount,
  decodeWithdrawableAccount,
  escrowHeldBy,
  hasSubmission,
  isValidAddress,
  jobDeadline,
  type SolanaJob,
  type SolanaLedger,
  type SolanaMarket,
} from '@/lib/onchain/solana/codec'

/**
 * The codec reads bytes written by a program in another language, in another
 * repo directory, that this test suite cannot compile. So the layout is
 * duplicated in TypeScript — and duplication that nobody checks is just a
 * second place to be wrong.
 *
 * The cross-language tests below read `solana/programs/handsel-market/src/lib.rs`
 * and check the decoder against it. A field added on the Rust side and not
 * mirrored here fails at `npm run test`, not on devnet.
 */

const RUST_SOURCE = join(process.cwd(), 'solana/programs/handsel-market/src/lib.rs')

/** Borsh widths for the types this program's accounts actually use. */
const RUST_WIDTH: Record<string, number> = {
  u8: 1,
  u32: 4,
  u64: 8,
  i64: 8,
  Pubkey: 32,
  '[u8; 32]': 32,
  JobStatus: 1, // fieldless enum → one byte variant index
}

function rustStructFields(name: string): Array<{ field: string; type: string }> {
  const src = readFileSync(RUST_SOURCE, 'utf8')
  const start = src.indexOf(`pub struct ${name} {`)
  expect(start, `pub struct ${name} not found in the program source`).toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/pub (\w+):\s*([^,]+),/g)].map((m) => ({
    field: m[1],
    type: m[2].trim(),
  }))
}

describe('base58', () => {
  it('round-trips', () => {
    // Note 'Handse', not 'Handsel' — `l` is one of the four characters base58
    // deliberately omits. The project's own name is not valid base58, which is
    // a fair reminder that "looks like text" is not a decodability test.
    for (const value of ['1', 'z', 'Handse', '11111111111111111111111111111111']) {
      const bytes = base58Decode(value)
      expect(bytes, value).not.toBeNull()
      expect(base58Encode(bytes!)).toBe(value)
    }
  })

  it('decodes the system program id to 32 zero bytes', () => {
    // The canonical leading-zero case: every '1' is a zero byte, and an
    // implementation that drops them produces a shorter, different address.
    const bytes = base58Decode('11111111111111111111111111111111')!
    expect(bytes.length).toBe(32)
    expect([...bytes].every((b) => b === 0)).toBe(true)
  })

  it('decodes a real program id to 32 bytes', () => {
    const bytes = base58Decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    expect(bytes?.length).toBe(32)
  })

  it('refuses invalid characters rather than guessing', () => {
    // 0, O, I and l are excluded from the alphabet precisely because they are
    // easy to confuse. A typo must not silently decode to a DIFFERENT address.
    for (const bad of ['0', 'O', 'I', 'l', 'abc!def', '']) {
      expect(base58Decode(bad), bad).toBeNull()
    }
  })

  it('length is part of being an address', () => {
    expect(isValidAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true)
    expect(isValidAddress('Handsel')).toBe(false) // decodes fine, wrong length
    expect(isValidAddress('not valid base58!')).toBe(false)
  })
})

describe('Anchor discriminator', () => {
  it('is the first 8 bytes of sha256("account:Name")', () => {
    const disc = accountDiscriminator('Job')
    expect(disc.length).toBe(8)
    // Pinned. This is what the memcmp filter sends to the RPC, so a change in
    // how it is derived silently returns zero accounts — an empty board that
    // looks exactly like an empty market.
    expect(Buffer.from(disc).toString('hex')).toBe('4b7c50cba1b4ca50')
  })

  it('differs per struct', () => {
    const seen = new Set(
      ['Job', 'Market', 'Withdrawable', 'Credit'].map((n) =>
        Buffer.from(accountDiscriminator(n)).toString('hex'),
      ),
    )
    expect(seen.size).toBe(4)
  })
})

describe('the decoder matches the Rust struct', () => {
  const fields = rustStructFields('Job')

  it('has the same fields, in the same order', () => {
    expect(fields.map((f) => f.field)).toEqual([
      'id',
      'requester',
      'worker',
      'bounty',
      'fee',
      'bond',
      'min_score',
      'spec_hash',
      'result_hash',
      'status',
      'created_at',
      'delivery_window',
      'accepted_at',
      'review_deadline',
      'bump',
    ])
  })

  it('sums to JOB_ACCOUNT_SIZE', () => {
    const body = fields.reduce((sum, f) => {
      const width = RUST_WIDTH[f.type]
      expect(width, `no Borsh width known for ${f.field}: ${f.type}`).toBeDefined()
      return sum + width
    }, 0)
    expect(body + 8).toBe(JOB_ACCOUNT_SIZE) // + Anchor's discriminator
  })

  it('the status enum has the same variants in the same order', () => {
    const src = readFileSync(RUST_SOURCE, 'utf8')
    const start = src.indexOf('pub enum JobStatus {')
    const body = src.slice(start, src.indexOf('\n}', start))
    const variants = [...body.matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1])
    // Borsh encodes a fieldless enum as its INDEX, so reordering the Rust
    // variants silently re-labels every job on the board.
    expect(variants).toEqual([...SOLANA_JOB_STATUS])
  })
})

/** Build a Job account the way the program would, for decode assertions. */
function encodeJob(over: Partial<Record<string, number | bigint | Uint8Array>> = {}): Uint8Array {
  const buf = Buffer.alloc(JOB_ACCOUNT_SIZE)
  Buffer.from(accountDiscriminator('Job')).copy(buf, 0)
  let o = 8
  const u64 = (v: bigint) => {
    buf.writeBigUInt64LE(v, o)
    o += 8
  }
  const i64 = (v: bigint) => {
    buf.writeBigInt64LE(v, o)
    o += 8
  }
  const key = (v: Uint8Array) => {
    Buffer.from(v).copy(buf, o)
    o += 32
  }
  u64(BigInt((over.id as number) ?? 3))
  key((over.requester as Uint8Array) ?? new Uint8Array(32).fill(1))
  key((over.worker as Uint8Array) ?? new Uint8Array(32).fill(2))
  u64(BigInt((over.bounty as number) ?? 1_000_000))
  u64(BigInt((over.fee as number) ?? 80_000))
  u64(BigInt((over.bond as number) ?? 80_000))
  u64(BigInt((over.minScore as number) ?? 600))
  key((over.specHash as Uint8Array) ?? new Uint8Array(32).fill(7))
  key((over.resultHash as Uint8Array) ?? new Uint8Array(32))
  buf.writeUInt8((over.status as number) ?? 1, o)
  o += 1
  i64(BigInt((over.createdAt as number) ?? 1_700_000_000))
  buf.writeUInt32LE((over.deliveryWindow as number) ?? 3600, o)
  o += 4
  i64(BigInt((over.acceptedAt as number) ?? 1_700_000_100))
  i64(BigInt((over.reviewDeadline as number) ?? 0))
  buf.writeUInt8(255, o)
  return new Uint8Array(buf)
}

describe('decodeJobAccount', () => {
  it('reads every field back', () => {
    const job = decodeJobAccount(encodeJob())!
    expect(job.id).toBe(3)
    expect(job.bounty).toBe(1_000_000n)
    expect(job.fee).toBe(80_000n)
    expect(job.bond).toBe(80_000n)
    expect(job.minScore).toBe(600)
    expect(job.status).toBe('Accepted')
    expect(job.deliveryWindow).toBe(3600)
    expect(job.acceptedAt).toBe(1_700_000_100)
    expect(isValidAddress(job.requester)).toBe(true)
    expect(isValidAddress(job.worker)).toBe(true)
  })

  it('rejects a wrong discriminator instead of returning garbage', () => {
    const bytes = encodeJob()
    bytes[0] ^= 0xff
    expect(decodeJobAccount(bytes)).toBeNull()
  })

  it('rejects a wrong length', () => {
    expect(decodeJobAccount(encodeJob().slice(0, JOB_ACCOUNT_SIZE - 1))).toBeNull()
    expect(decodeJobAccount(new Uint8Array(0))).toBeNull()
  })

  it('drops a status this build has never heard of', () => {
    // A program that grew a state must not have it guessed into an existing
    // one — that puts a verdict on the board nobody reached.
    const bytes = encodeJob({ status: SOLANA_JOB_STATUS.length })
    expect(decodeJobAccount(bytes)).toBeNull()
  })
})

describe('submission and deadlines', () => {
  it('a zero result hash means no submission landed', () => {
    const accepted = decodeJobAccount(encodeJob({ status: 1 }))!
    expect(hasSubmission(accepted)).toBe(false)
  })

  it('a hash that merely STARTS with zeros is still a submission', () => {
    const hash = new Uint8Array(32)
    hash[31] = 0xab
    const job = decodeJobAccount(encodeJob({ status: 2, resultHash: hash }))!
    expect(hasSubmission(job)).toBe(true)
  })

  it('Accepted counts down the delivery window', () => {
    const job = decodeJobAccount(encodeJob({ status: 1, acceptedAt: 1000, deliveryWindow: 3600 }))!
    expect(jobDeadline(job)).toBe(4600)
  })

  it('Submitted counts down the review window', () => {
    const job = decodeJobAccount(encodeJob({ status: 2, reviewDeadline: 9999 }))!
    expect(jobDeadline(job)).toBe(9999)
  })

  it('Open has no deadline — open-window expiry is a documented cut, not a zero', () => {
    const job = decodeJobAccount(encodeJob({ status: 0 }))!
    expect(jobDeadline(job)).toBeNull()
  })

  it('terminal states count down nothing', () => {
    for (const status of [3, 4, 5]) {
      const job = decodeJobAccount(encodeJob({ status }))!
      expect(jobDeadline(job), job.status).toBeNull()
    }
  })
})

/**
 * A seeds constraint must not read a bump the program might never write.
 *
 * `withdraw` derived its ledger address with `bump = withdrawable.bump`, and
 * nothing ever assigned that field — `credit()` is a plain helper with no
 * access to `ctx.bumps`, so it set `owner` and `amount` and left `bump` at 0.
 * Settlement credited the ledger and `withdraw` then failed its seeds check:
 * money in, money permanently stuck. Found by reading devnet state after CI
 * called the run green, which is two failures for the price of one.
 *
 * Limit worth stating: this checks that the identifier named in the constraint
 * is assigned SOMEWHERE in the file. It cannot prove the assignment is on every
 * path that creates the account. It does catch the shape that actually
 * happened — a constraint naming an account nobody writes by that name.
 */
describe('stored bumps are written before they are trusted', () => {
  const src = readFileSync(RUST_SOURCE, 'utf8')

  it('every `bump = x.bump` constraint has a matching `x.bump =` assignment', () => {
    const readers = [...src.matchAll(/bump\s*=\s*(\w+)\.bump\b/g)].map((m) => m[1])
    const unwritten = [...new Set(readers)].filter(
      (name) => !new RegExp(`\\b${name}\\.bump\\s*=[^=]`).test(src),
    )
    expect(
      unwritten,
      `constraints read these bumps but nothing assigns them: ${unwritten.join(', ')}`,
    ).toEqual([])
  })

  it('the withdraw path does not depend on a stored bump at all', () => {
    // Belt and braces on the one instruction whose failure strands funds.
    // `bump` with no `= expr` re-derives canonically and cannot be wrong.
    // Just the withdrawable field's own attribute block. Slicing the whole
    // struct would sweep in `market`, which reads `bump = market.bump`
    // legitimately — that one IS written, in init_market.
    const ctx = src.slice(src.indexOf('pub struct Withdraw<'))
    const fieldAt = ctx.indexOf('pub withdrawable:')
    const attr = ctx.slice(ctx.lastIndexOf('#[account(', fieldAt), fieldAt)
    expect(attr).not.toMatch(/bump\s*=\s*\w+\.bump/)
    expect(attr).toMatch(/^\s*bump,\s*$/m)
  })
})

// ── Market and the pull-payment ledgers ──────────────────────────────────

describe('the Market decoder matches the Rust struct', () => {
  const fields = rustStructFields('Market')

  it('has the same fields, in the same order', () => {
    expect(fields.map((f) => f.field)).toEqual([
      'authority',
      'oracle',
      'fee_recipient',
      'usdc_mint',
      'vault',
      'fee_bps',
      'flat_fee',
      'bond_bps',
      'flat_bond',
      'review_window',
      'min_bounty',
      'job_count',
      'total_escrowed',
      'total_withdrawable',
      'bump',
    ])
  })

  it('sums to MARKET_ACCOUNT_SIZE', () => {
    // u16 shows up for the first time here — a width the Job struct never
    // used, and getting it wrong shifts every number after it by two bytes
    // while still decoding to plausible-looking values.
    const body = fields.reduce((sum, f) => {
      const width = { ...RUST_WIDTH, u16: 2 }[f.type]
      expect(width, `no Borsh width known for ${f.field}: ${f.type}`).toBeDefined()
      return sum + width!
    }, 0)
    expect(body + 8).toBe(MARKET_ACCOUNT_SIZE)
  })
})

describe('the Withdrawable decoder matches the Rust struct', () => {
  it('has the same fields and sums to WITHDRAWABLE_ACCOUNT_SIZE', () => {
    const fields = rustStructFields('Withdrawable')
    expect(fields.map((f) => f.field)).toEqual(['owner', 'amount', 'bump'])
    const body = fields.reduce((sum, f) => sum + RUST_WIDTH[f.type], 0)
    expect(body + 8).toBe(WITHDRAWABLE_ACCOUNT_SIZE)
  })
})

function encodeMarket(over: Partial<Record<string, number | bigint>> = {}): Uint8Array {
  const buf = Buffer.alloc(MARKET_ACCOUNT_SIZE)
  Buffer.from(accountDiscriminator('Market')).copy(buf, 0)
  for (let i = 0; i < 5; i++) buf.fill(i + 1, 8 + i * 32, 40 + i * 32)
  buf.writeUInt16LE((over.feeBps as number) ?? 500, 168)
  buf.writeBigUInt64LE(BigInt((over.flatFee as number) ?? 30_000), 170)
  buf.writeUInt16LE((over.bondBps as number) ?? 500, 178)
  buf.writeBigUInt64LE(BigInt((over.flatBond as number) ?? 30_000), 180)
  buf.writeUInt32LE((over.reviewWindow as number) ?? 600, 188)
  buf.writeBigUInt64LE(BigInt((over.minBounty as number) ?? 1), 192)
  buf.writeBigUInt64LE(BigInt((over.jobCount as number) ?? 1), 200)
  buf.writeBigUInt64LE(BigInt((over.totalEscrowed as number) ?? 0), 208)
  buf.writeBigUInt64LE(BigInt((over.totalWithdrawable as number) ?? 0), 216)
  buf.writeUInt8(255, 224)
  return new Uint8Array(buf)
}

function encodeLedger(amount: bigint, ownerByte = 9): Uint8Array {
  const buf = Buffer.alloc(WITHDRAWABLE_ACCOUNT_SIZE)
  Buffer.from(accountDiscriminator('Withdrawable')).copy(buf, 0)
  buf.fill(ownerByte, 8, 40)
  buf.writeBigUInt64LE(amount, 40)
  return new Uint8Array(buf)
}

describe('decodeMarketAccount', () => {
  it('reads every field back', () => {
    const m = decodeMarketAccount(encodeMarket({ totalWithdrawable: 1_160_000 }))!
    expect(m.feeBps).toBe(500)
    expect(m.flatFee).toBe(30_000n)
    expect(m.bondBps).toBe(500)
    expect(m.flatBond).toBe(30_000n)
    expect(m.reviewWindow).toBe(600)
    expect(m.jobCount).toBe(1)
    expect(m.totalEscrowed).toBe(0n)
    expect(m.totalWithdrawable).toBe(1_160_000n)
    expect(base58Decode(m.vault)?.length).toBe(32)
  })

  it('refuses a Job, a ledger and a truncated buffer', () => {
    expect(decodeMarketAccount(encodeJob())).toBeNull()
    expect(decodeMarketAccount(encodeLedger(1n))).toBeNull()
    expect(decodeMarketAccount(encodeMarket().subarray(0, 200))).toBeNull()
  })
})

describe('decodeWithdrawableAccount', () => {
  it('reads the owner and amount', () => {
    const l = decodeWithdrawableAccount(encodeLedger(1_080_000n))!
    expect(l.amount).toBe(1_080_000n)
    expect(base58Decode(l.owner)?.length).toBe(32)
  })

  it('refuses a Market and a Job', () => {
    expect(decodeWithdrawableAccount(encodeMarket())).toBeNull()
    expect(decodeWithdrawableAccount(encodeJob())).toBeNull()
  })
})

describe('escrowHeldBy follows the program, not the intuition', () => {
  const at = (status: number) => decodeJobAccount(encodeJob({ status }))!
  it('Open holds bounty + fee, before any bond exists', () => {
    expect(escrowHeldBy(at(0))).toBe(1_080_000n)
  })
  it('Accepted and Submitted also hold the bond', () => {
    expect(escrowHeldBy(at(1))).toBe(1_160_000n)
    expect(escrowHeldBy(at(2))).toBe(1_160_000n)
  })
  it('every terminal state holds nothing — settlement moved it to a ledger', () => {
    for (const status of [3, 4, 5]) expect(escrowHeldBy(at(status))).toBe(0n)
  })
})

describe('checkMarketInvariants', () => {
  const market = (over: Partial<SolanaMarket> = {}): SolanaMarket => ({
    ...decodeMarketAccount(encodeMarket())!,
    ...over,
  })
  const completed = decodeJobAccount(
    encodeJob({ id: 0, status: 3, resultHash: new Uint8Array(32).fill(42) }),
  )! as SolanaJob
  const ledgers: SolanaLedger[] = [
    decodeWithdrawableAccount(encodeLedger(1_080_000n, 9))!,
    decodeWithdrawableAccount(encodeLedger(80_000n, 10))!,
  ]
  const healthy = {
    market: market({ jobCount: 1, totalEscrowed: 0n, totalWithdrawable: 1_160_000n }),
    jobs: [completed],
    ledgers,
    vaultAmount: 1_160_000n,
  }
  const failing = (state: Parameters<typeof checkMarketInvariants>[0]) =>
    checkMarketInvariants(state).checks.filter((c) => !c.ok).map((c) => c.name)

  it('passes the state devnet is actually in', () => {
    const { ok, checks } = checkMarketInvariants(healthy)
    expect(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok))).toBe(true)
    expect(ok).toBe(true)
  })

  it('catches a job the market counted but never wrote', () => {
    expect(failing({ ...healthy, market: market({ jobCount: 2, totalWithdrawable: 1_160_000n }) })).toContain(
      'every posted job has an account',
    )
  })

  it('catches escrow the jobs do not account for', () => {
    expect(failing({ ...healthy, market: { ...healthy.market, totalEscrowed: 500n } })).toContain(
      'total_escrowed matches the open jobs',
    )
  })

  it('catches a ledger total that disagrees with the market', () => {
    expect(failing({ ...healthy, ledgers: [ledgers[0]] })).toContain(
      'total_withdrawable matches the ledgers',
    )
  })

  it('catches insolvency — owing more than the vault holds', () => {
    expect(failing({ ...healthy, vaultAmount: 1_159_999n })).toContain(
      'solvent — the vault covers what is owed',
    )
  })

  it('an unread vault balance is a failed check, never a passing one', () => {
    // The whole sprint's lesson in one assertion: null must not read as zero,
    // and "could not check" must not read as "checked and fine".
    expect(failing({ ...healthy, vaultAmount: null })).toContain(
      'solvent — the vault covers what is owed',
    )
  })

  it('a donation to the vault is not a defect', () => {
    expect(failing({ ...healthy, vaultAmount: 2_000_000n })).toEqual([])
  })

  it('catches a job completed with no deliverable', () => {
    const blind = decodeJobAccount(encodeJob({ id: 0, status: 3, resultHash: new Uint8Array(32) }))!
    expect(failing({ ...healthy, jobs: [blind] })).toContain('no job completed without a submission')
  })

  it('catches a funded ledger nobody owns', () => {
    // credit() stamps the owner on first use; a funded ledger at the default
    // pubkey is the shape of the bug this sprint already paid for.
    const orphan = decodeWithdrawableAccount(encodeLedger(1_080_000n, 0))!
    expect(failing({ ...healthy, ledgers: [orphan, ledgers[1]] })).toContain(
      'no funded ledger without an owner',
    )
  })
})
