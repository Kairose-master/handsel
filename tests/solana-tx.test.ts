import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INSTRUCTION_ACCOUNTS,
  PDA_SEEDS,
  bondFor,
  encodeAcceptJob,
  encodePostJob,
  encodeSetCredit,
  encodeSubmitWork,
  feeFor,
  instructionDiscriminator,
  u32le,
  u64le,
} from '@/lib/onchain/solana/tx'

/**
 * The write path's instruction layouts are duplicated from the Rust — same
 * rule as the codec (tests/solana-codec.test.ts): duplication nobody checks
 * is a second place to be wrong, so these tests read the program source and
 * diff the TypeScript against it. A new instruction, a reordered account, a
 * changed argument, or a flipped mut/signer fails here, not on devnet.
 */
const RUST_SOURCE = join(process.cwd(), 'solana/programs/handsel-market/src/lib.rs')
const src = readFileSync(RUST_SOURCE, 'utf8')

/** Borsh widths for the argument types the instructions actually take. */
const ARG_WIDTH: Record<string, number> = {
  u32: 4,
  u64: 8,
  Pubkey: 32,
  '[u8; 32]': 32,
}

/** Every `pub fn name(ctx: Context<Struct>, args…)` in the #[program] mod. */
function rustInstructions(): Array<{ name: string; struct: string; args: Array<{ name: string; type: string }> }> {
  const out: Array<{ name: string; struct: string; args: Array<{ name: string; type: string }> }> = []
  const re = /pub fn (\w+)\(\s*ctx: Context<(\w+)>([^)]*)\)/g
  for (const m of src.matchAll(re)) {
    const args = [...m[3].matchAll(/(\w+):\s*([^,]+?)(?:,|$)/g)]
      .map((a) => ({ name: a[1], type: a[2].trim() }))
      .filter((a) => a.name !== 'ctx')
    out.push({ name: m[1], struct: m[2], args })
  }
  return out
}

/** Field order + attributes of a #[derive(Accounts)] struct. */
function rustAccountFields(structName: string): Array<{ name: string; type: string; attrs: string }> {
  const start = src.indexOf(`pub struct ${structName}<'info>`)
  expect(start, `pub struct ${structName} not found`).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('{', start) + 1, src.indexOf('\n}', start))
  const fields: Array<{ name: string; type: string; attrs: string }> = []
  const re = /pub (\w+):\s*([^,]+),/g
  let prevEnd = 0
  for (const m of body.matchAll(re)) {
    fields.push({ name: m[1], type: m[2].trim(), attrs: body.slice(prevEnd, m.index) })
    prevEnd = (m.index ?? 0) + m[0].length
  }
  return fields
}

describe('instruction coverage', () => {
  it('encodes every program instruction except init_market (operator-only, done once by CI)', () => {
    const rustNames = rustInstructions().map((i) => i.name)
    const ours = Object.keys(INSTRUCTION_ACCOUNTS)
    const missing = rustNames.filter((n) => n !== 'init_market' && !ours.includes(n))
    expect(missing, `instructions in the Rust but not in tx.ts: ${missing}`).toEqual([])
    const extra = ours.filter((n) => !rustNames.includes(n))
    expect(extra, `instructions in tx.ts the program does not have: ${extra}`).toEqual([])
  })

  it('each instruction maps to the same Accounts struct as the Rust', () => {
    for (const ix of rustInstructions()) {
      if (ix.name === 'init_market') continue
      expect(INSTRUCTION_ACCOUNTS[ix.name].struct, ix.name).toBe(ix.struct)
    }
  })
})

describe('account order and flags vs the Rust structs', () => {
  for (const [name, spec] of Object.entries(INSTRUCTION_ACCOUNTS)) {
    it(`${name} (${spec.struct})`, () => {
      const rust = rustAccountFields(spec.struct)
      expect(spec.accounts.map((f) => f.name), 'field order').toEqual(rust.map((f) => f.name))
      for (let i = 0; i < rust.length; i++) {
        const isSigner = rust[i].type.includes('Signer')
        // `mut` inside the field's #[account(...)] attribute block. Constraint
        // expressions also contain the word only inside string msgs, which the
        // attrs slice for these structs does not have.
        // `mut` explicitly, or any `init` flavor — an account being created
        // (init / init_if_needed) is writable by definition.
        const isWritable = /#\[account\([^]*?\bmut\b/.test(rust[i].attrs) || /\binit(_if_needed)?\b/.test(rust[i].attrs)
        expect(spec.accounts[i].signer, `${spec.struct}.${rust[i].name} signer`).toBe(isSigner)
        expect(spec.accounts[i].writable, `${spec.struct}.${rust[i].name} writable`).toBe(isWritable)
      }
    })
  }
})

describe('argument encoding widths vs the Rust signatures', () => {
  const encoded: Record<string, Uint8Array> = {
    post_job: encodePostJob(1_000_000n, 0n, '11'.repeat(32), 3600),
    accept_job: encodeAcceptJob(),
    submit_work: encodeSubmitWork('22'.repeat(32)),
    set_credit: encodeSetCredit('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 100n, 500n),
  }

  it('discriminator is 8 bytes and unique per instruction', () => {
    const discs = Object.keys(INSTRUCTION_ACCOUNTS).map((n) => Buffer.from(instructionDiscriminator(n)).toString('hex'))
    expect(new Set(discs).size).toBe(discs.length)
    for (const d of discs) expect(d).toHaveLength(16)
  })

  for (const ix of rustInstructions()) {
    if (!(ix.name in encoded)) continue
    it(`${ix.name} args total ${ix.args.map((a) => a.type).join(' + ') || '(none)'}`, () => {
      const argBytes = ix.args.reduce((n, arg) => {
        const w = ARG_WIDTH[arg.type]
        expect(w, `no Borsh width for ${arg.type} — add it to ARG_WIDTH`).toBeDefined()
        return n + w
      }, 0)
      expect(encoded[ix.name].length).toBe(8 + argBytes)
    })
  }

  it('scalars are little-endian', () => {
    expect(Buffer.from(u64le(1n)).toString('hex')).toBe('0100000000000000')
    expect(Buffer.from(u32le(0x01020304)).toString('hex')).toBe('04030201')
    expect(() => u64le(-1n)).toThrow()
    expect(() => u32le(2 ** 32)).toThrow()
  })

  it('post_job payload carries the args in declaration order', () => {
    const data = encodePostJob(7n, 9n, 'ab'.repeat(32), 3600)
    expect(data.length).toBe(8 + 8 + 8 + 32 + 4)
    expect(Buffer.from(data.subarray(8, 16)).toString('hex')).toBe('0700000000000000') // bounty
    expect(Buffer.from(data.subarray(16, 24)).toString('hex')).toBe('0900000000000000') // min_score
    expect(Buffer.from(data.subarray(24, 56)).toString('hex')).toBe('ab'.repeat(32)) // spec_hash
    expect(Buffer.from(data.subarray(56, 60)).toString('hex')).toBe('100e0000') // 3600 LE
  })
})

describe('fee/bond mirrors', () => {
  // The deployed devnet market's parameters (solana/scripts/happy-path.ts):
  // 500 bps + 30_000 flat for both. On the 1.00-token bounty the happy path
  // uses, the chain said 80_000 — asserted live at every run. If the program's
  // fee_for changes shape, the happy path fails there and this pins the
  // client-side mirror to the same number.
  const market = { feeBps: 500, flatFee: 30_000n, bondBps: 500, flatBond: 30_000n }
  it('matches the deployed market arithmetic', () => {
    expect(feeFor(market, 1_000_000n)).toBe(80_000n)
    expect(bondFor(market, 1_000_000n)).toBe(80_000n)
  })
  it('integer division truncates like the Rust', () => {
    expect(feeFor(market, 3n)).toBe(30_000n) // 3 * 500 / 10_000 = 0
  })
})

describe('PDA seeds vs the Rust', () => {
  it('every seed literal exists in the program source', () => {
    for (const literal of ['b"market"', 'b"vault"', 'b"job"', 'b"withdrawable"', 'b"credit"']) {
      expect(src.includes(literal), literal).toBe(true)
    }
  })
  it('job seed uses the 8-byte LE id like job_count.to_le_bytes()', () => {
    const seeds = PDA_SEEDS.job(258n)
    expect(seeds[0].toString()).toBe('job')
    expect(seeds[1].length).toBe(8)
    expect(seeds[1].toString('hex')).toBe('0201000000000000')
  })
  it('withdrawable/credit seeds embed the 32-byte owner key', () => {
    const w = PDA_SEEDS.withdrawable('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    expect(w[1].length).toBe(32)
    const c = PDA_SEEDS.credit('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    expect(c[1].length).toBe(32)
  })
})
