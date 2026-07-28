/**
 * Compile LaborMarketV2 plus its test doubles into a single fixture the EVM
 * tests load. Committed, so the suite runs without solc on the box — the same
 * reason lib/onchain/labor-v2-artifact.ts is committed.
 *
 * Usage:  SOLC_PATH=<path to solc> node scripts/compile-evm-fixtures.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const solc = require(process.env.SOLC_PATH || 'solc')

const SOURCES = ['contracts/src/LaborMarketV2.sol', 'contracts/test/TestDoubles.sol']
const OUT = 'tests/fixtures/evm-artifacts.json'

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(SOURCES.map((p) => [p, { content: readFileSync(p, 'utf8') }])),
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
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}

const artifacts = {}
for (const source of SOURCES) {
  for (const [name, c] of Object.entries(output.contracts[source] ?? {})) {
    artifacts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
  }
}

for (const required of ['LaborMarketV2', 'TestUSDC', 'TestRegistry', 'BlocklistUSDC', 'RevertingRegistry']) {
  if (!artifacts[required]) {
    console.error(`missing ${required} — refusing to write a fixture the tests cannot use`)
    process.exit(1)
  }
}

mkdirSync('tests/fixtures', { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify({ solc: solc.version(), contracts: artifacts }, null, 2) + '\n',
)
console.log(`wrote ${OUT} — ${Object.keys(artifacts).join(', ')} (solc ${solc.version()})`)
