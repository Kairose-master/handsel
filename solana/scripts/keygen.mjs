#!/usr/bin/env node
/**
 * Generate a Solana keypair using Node's built-in ed25519. No toolchain, no
 * dependencies, and nothing downloaded at the moment you make a key.
 *
 * **Why this exists rather than a one-liner.** `npx solana-keygen` does NOT
 * fetch the official Solana CLI — that is not published to npm. It fetches an
 * unrelated third-party package of the same name. A key generator is the worst
 * possible thing to run from an unvetted source: a backdoored one can emit
 * predictable keys or phone them home, and both are invisible to you. The
 * official CLI (`https://release.anza.xyz`) is fine; a random npm package with
 * a familiar name is not.
 *
 * This file is in your repo, is thirty lines, uses only `node:crypto`, and can
 * be read end to end before you run it. That is the whole argument for it.
 *
 * Usage:
 *   node solana/scripts/keygen.mjs /tmp/handsel-program.json
 *
 * It prints the PUBLIC key and nothing else. The private half only ever
 * touches the file — which belongs in a GitHub secret, never in the repo and
 * never pasted into a chat.
 */
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const size = bytes.length * 2
  const buf = new Uint8Array(size)
  let length = 0
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    let used = 0
    for (let j = size - 1; (carry !== 0 || used < length) && j >= 0; j--, used++) {
      carry += 256 * buf[j]
      buf[j] = carry % 58
      carry = (carry / 58) | 0
    }
    length = used
  }
  let out = '1'.repeat(zeros)
  for (let i = size - length; i < size; i++) out += B58[buf[i]]
  return out
}

const out = process.argv[2]
if (!out) {
  console.error('usage: node solana/scripts/keygen.mjs <output.json>')
  process.exit(1)
}
// Never clobber a key. Overwriting the program keypair means the deployed
// program becomes permanently unupgradeable and unreachable by its own id.
if (existsSync(out)) {
  console.error(`refusing to overwrite ${out} — move it aside first`)
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
// Raw bytes sit at the end of the standard DER encodings: SPKI is 12 bytes of
// header + 32 of key, PKCS8 is 16 + 32 (the SEED, not an expanded secret).
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)

// Solana's keypair file is a 64-byte array: seed ‖ public key. That is what
// `solana program deploy` and every wallet expect.
const secretKey = Buffer.concat([seed, pub])
writeFileSync(out, JSON.stringify([...secretKey]), { mode: 0o600 })

console.log(`wrote ${out} (mode 600)`)
console.log('')
console.log(`address: ${base58Encode(pub)}`)
console.log('')
console.log('The address above is PUBLIC — it belongs in declare_id!.')
console.log(`The file's CONTENTS are the private key. Put them in a GitHub secret;`)
console.log('never commit them, never paste them into a chat, and delete the file after.')
