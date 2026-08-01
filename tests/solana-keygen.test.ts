import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/onchain/solana/codec'

/**
 * A key generator is the one tool where "it seemed to work" is not evidence.
 *
 * This one exists because `npx solana-keygen` does not fetch the official
 * Solana CLI — that is not on npm — it fetches an unrelated third-party
 * package of the same name. Replacing an unvetted dependency with thirty lines
 * of `node:crypto` is only an improvement if the thirty lines are right, so
 * these tests check the output cryptographically rather than by shape: the
 * stored seed must actually derive the stored public key, and a signature made
 * with the private half must verify against it.
 */

const SCRIPT = join(process.cwd(), 'solana/scripts/keygen.mjs')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handsel-keygen-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function generate(name = 'kp.json') {
  const out = join(dir, name)
  const stdout = execFileSync('node', [SCRIPT, out], { encoding: 'utf8' })
  const address = stdout.match(/address: (\S+)/)?.[1]
  expect(address, 'the script must print an address').toBeTruthy()
  return { out, address: address!, bytes: JSON.parse(readFileSync(out, 'utf8')) as number[] }
}

describe('keygen produces a real Solana keypair', () => {
  it('writes the 64-byte seed ‖ pubkey array wallets expect', () => {
    const { bytes } = generate()
    expect(bytes.length).toBe(64)
    expect(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true)
  })

  it('the stored seed actually derives the stored public key', () => {
    // The failure this catches: emitting 64 random bytes. It would look like a
    // keypair, load into a wallet, and control nothing — every signature made
    // with the first half would verify against a different address than the
    // second half advertises.
    const { bytes } = generate()
    const seed = Buffer.from(bytes.slice(0, 32))
    const stored = Buffer.from(bytes.slice(32))
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
    const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const derived = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32)
    expect(Buffer.from(derived).equals(stored)).toBe(true)
  })

  it('signs and verifies — the key controls the address', () => {
    const { bytes } = generate()
    const seed = Buffer.from(bytes.slice(0, 32))
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
    const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const message = Buffer.from('handsel')
    expect(verify(null, message, createPublicKey(priv), sign(null, message, priv))).toBe(true)
  })

  it('the printed address is the base58 of the stored public key', () => {
    // Printing an address that does not match the file is how a program gets
    // deployed to one place while declare_id! points at another.
    const { bytes, address } = generate()
    expect(base58Encode(Uint8Array.from(bytes.slice(32)))).toBe(address)
    expect(base58Decode(address)?.length).toBe(32)
  })

  it('two runs do not produce the same key', () => {
    // Cheap, but it is the check that catches a fixed seed or a broken RNG,
    // which is precisely the backdoor an unvetted generator would ship.
    const a = generate('a.json')
    const b = generate('b.json')
    expect(a.address).not.toBe(b.address)
  })
})

describe('keygen refuses to destroy a key', () => {
  it('will not overwrite an existing file', () => {
    // Clobbering the program keypair makes the deployed program permanently
    // unupgradeable and unreachable by its own id.
    const { out, bytes } = generate()
    expect(() => execFileSync('node', [SCRIPT, out], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(bytes)
  })

  it('writes owner-only permissions', () => {
    const { out } = generate()
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })

  it('exits non-zero with no path, rather than guessing one', () => {
    expect(() => execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
  })
})

describe('the private half never reaches stdout', () => {
  it('prints the address and nothing that could be a key', () => {
    // stdout is what ends up in a terminal scrollback, a CI log, and a
    // screenshot pasted into a chat.
    const out = join(dir, 'quiet.json')
    const stdout = execFileSync('node', [SCRIPT, out], { encoding: 'utf8' })
    const bytes = JSON.parse(readFileSync(out, 'utf8')) as number[]
    const seed = Buffer.from(bytes.slice(0, 32))
    expect(stdout).not.toContain(seed.toString('hex'))
    expect(stdout).not.toContain(base58Encode(Uint8Array.from(bytes.slice(0, 32))))
    expect(stdout).not.toContain(JSON.stringify(bytes.slice(0, 32)))
  })
})
