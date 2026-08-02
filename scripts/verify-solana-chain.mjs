#!/usr/bin/env node
/**
 * Read the devnet market and say whether it is telling the truth.
 *
 * **Why this is a script and not a CI step alone.** Every time CI reported the
 * Solana deploy green this sprint, the answer that settled it came from reading
 * the chain by hand — `getProgramAccounts`, decode, compare. Three times the
 * chain disagreed with the checkmark: a `tee` that swallowed an exit code, a
 * deploy job that never ran, and a job killed ten seconds after its deploy
 * succeeded. The read was the check; CI was a convenience. So the read stops
 * being something typed out fresh each time and becomes a command.
 *
 * It needs no keys, no Solana toolchain, no `anchor build`, and no IDL — an
 * Anchor account is an 8-byte discriminator and fixed-width little-endian
 * fields, and `lib/onchain/solana/codec.ts` already knows the layout. That is
 * also why it is safe to run from anywhere, including a laptop that has never
 * touched this program.
 *
 * Usage:
 *   node scripts/verify-solana-chain.mjs [--program <id>] [--url <rpc>] [--json]
 *
 * Exits non-zero if any invariant fails, so it works as a CI gate too.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PROGRAM = argOf('--program', process.env.SOLANA_PROGRAM_ID ?? '8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H')
const RPC = argOf('--url', process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com')
const JSON_OUT = args.includes('--json')

// The decoders are TypeScript in lib/. Rather than duplicate the account
// layout here -- the one thing this repo will not do, because a second copy is
// a second thing to forget when the Rust changes -- the file is transpiled on
// the fly. It has no imports beyond node:crypto, so this is a type-strip and
// nothing more.
const require = createRequire(import.meta.url)
let codec
try {
  // Run under `tsx` (which `solana/` depends on, so CI has it) and a .ts
  // import simply works.
  codec = await import('../lib/onchain/solana/codec.ts')
} catch {
  // Plain `node`, the way a human runs it: strip the types with the compiler
  // the web app already depends on. Two paths, both real, neither installing
  // anything.
  const ts = require('typescript')
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const src = readFileSync(new URL('../lib/onchain/solana/codec.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const file = join(mkdtempSync(join(tmpdir(), 'handsel-codec-')), 'codec.mjs')
  writeFileSync(file, js)
  codec = await import(pathToFileURL(file).href)
}

const { decodeJobAccount, decodeMarketAccount, decodeWithdrawableAccount, checkMarketInvariants } = codec

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

const accounts = await rpc('getProgramAccounts', [PROGRAM, { encoding: 'base64' }])
const decoded = accounts.map((a) => ({
  pubkey: a.pubkey,
  data: Uint8Array.from(Buffer.from(a.account.data[0], 'base64')),
}))

const market = decoded.map((a) => decodeMarketAccount(a.data)).find(Boolean) ?? null
const jobs = decoded.map((a) => decodeJobAccount(a.data)).filter(Boolean).sort((a, b) => a.id - b.id)
const ledgers = decoded.map((a) => decodeWithdrawableAccount(a.data)).filter(Boolean)

if (!market) {
  console.error(`no Market account under ${PROGRAM} on ${RPC}`)
  console.error(`(${accounts.length} program accounts, none of them a Market — wrong program id or wrong cluster?)`)
  process.exit(1)
}

// A balance that could not be read must not read as zero: zero would make an
// insolvent market look merely empty, and empty look fine.
let vaultAmount = null
try {
  const bal = await rpc('getTokenAccountBalance', [market.vault])
  vaultAmount = BigInt(bal.value.amount)
} catch (err) {
  console.error(`warning: could not read the vault balance — ${err.message}`)
}

const { ok, checks } = checkMarketInvariants({ market, jobs, ledgers, vaultAmount })

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { program: PROGRAM, rpc: RPC, market, jobs, ledgers, vaultAmount, ok, checks },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  )
  process.exit(ok ? 0 : 1)
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
console.log(`program  ${PROGRAM}`)
console.log(`rpc      ${RPC}`)
console.log('')
console.log(
  `market   jobs ${market.jobCount} · escrowed ${market.totalEscrowed} · withdrawable ${market.totalWithdrawable}`,
)
console.log(
  `vault    ${short(market.vault)} holds ${vaultAmount === null ? '<unread>' : vaultAmount} of mint ${short(market.usdcMint)}`,
)
console.log('')
for (const j of jobs) {
  console.log(
    `  job #${j.id}  ${j.status.padEnd(9)} bounty ${j.bounty} fee ${j.fee} bond ${j.bond}` +
      `  ${j.status === 'Completed' || j.status === 'Submitted' ? (j.resultHash.slice(2, 10) + '…') : ''}`,
  )
}
for (const l of ledgers) {
  console.log(`  ledger ${short(l.owner)}  owed ${l.amount}`)
}
console.log('')
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(38)} ${c.detail}`)
console.log('')
console.log(ok ? 'chain agrees with itself.' : 'THE CHAIN DISAGREES WITH ITSELF.')
process.exit(ok ? 0 : 1)
