import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JOB_ACCOUNT_SIZE,
  SOLANA_JOB_STATUS,
  accountDiscriminator,
  base58Decode,
  base58Encode,
  decodeJobAccount,
  hasSubmission,
  isValidAddress,
  jobDeadline,
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
