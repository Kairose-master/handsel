/**
 * Compile contracts/src/LaborMarketV2.sol to a committed ABI + bytecode module,
 * so the server can deploy without solc on the box.
 *
 * Usage:  node scripts/compile-labor-v2.mjs
 *
 * solc is not a project dependency on purpose — it is a 30MB build-time tool
 * needed only when the contract changes. Install it where you run this:
 *   npm install --no-save solc@0.8.24
 * or point SOLC_PATH at an existing install.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const SOLC = process.env.SOLC_PATH || 'solc'

let solc
try {
  solc = require(SOLC)
} catch {
  console.error(
    `Could not load solc from "${SOLC}".\n` +
      'Install it (npm install --no-save solc@0.8.24) or set SOLC_PATH to an existing install.',
  )
  process.exit(1)
}

const SOURCE = 'contracts/src/LaborMarketV2.sol'
const OUT = 'lib/onchain/labor-v2-artifact.ts'
const CONTRACT = 'LaborMarketV2'

const input = {
  language: 'Solidity',
  sources: { [SOURCE]: { content: readFileSync(SOURCE, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // The IR pipeline, because the `jobs` public getter returns fourteen
    // fields and the legacy codegen runs out of stack slots generating it.
    // Adding a struct member should not be a refactor.
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))

const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length > 0) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}
for (const w of (output.errors ?? []).filter((e) => e.severity !== 'error')) {
  console.warn(w.formattedMessage)
}

const artifact = output.contracts?.[SOURCE]?.[CONTRACT]
if (!artifact) {
  console.error(`solc produced no ${CONTRACT} in ${SOURCE}`)
  process.exit(1)
}

const bytecode = '0x' + artifact.evm.bytecode.object
// A contract that compiles to nothing deploys as nothing, and the failure would
// only surface as a silently dead address on chain.
if (bytecode.length < 100) {
  console.error(`bytecode is suspiciously short (${bytecode.length} chars) — refusing to write`)
  process.exit(1)
}

const banner = `/**
 * GENERATED — do not edit by hand.
 * Compiled from ${SOURCE} with solc ${solc.version()} (optimizer 200 runs).
 * Regenerate: node ${path.basename(process.argv[1])}
 */`

writeFileSync(
  OUT,
  `${banner}\nexport const LABOR_MARKET_V2_ABI = ${JSON.stringify(artifact.abi)} as const\n\n` +
    `export const LABOR_MARKET_V2_BYTECODE = '${bytecode}' as const\n`,
)

const kb = (bytecode.length / 2 / 1024).toFixed(1)
console.log(`wrote ${OUT} — ${artifact.abi.length} ABI entries, ${kb} KB bytecode`)
// EIP-170 caps deployed code at 24576 bytes. Creation code is larger than
// runtime code, so this is a warning rather than a gate, but a contract near
// the limit is worth knowing about before the deploy reverts.
if (bytecode.length / 2 > 24576) console.warn('WARNING: creation bytecode exceeds 24576 bytes — check EIP-170 headroom')
