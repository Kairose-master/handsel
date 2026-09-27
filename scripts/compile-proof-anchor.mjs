#!/usr/bin/env node
/**
 * Compile contracts/ProofAnchor.sol → lib/onchain/proof-anchor-artifact.ts
 * (ABI + deploy bytecode). The artifact is committed so the production
 * server can deploy without bundling solc; rerun this after any .sol edit.
 *
 *   node scripts/compile-proof-anchor.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import solc from 'solc'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = readFileSync(join(root, 'contracts', 'ProofAnchor.sol'), 'utf8')

const input = {
  language: 'Solidity',
  sources: { 'ProofAnchor.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors || []).filter((e) => e.severity === 'error')
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'))
  process.exit(1)
}
const a = out.contracts['ProofAnchor.sol'].ProofAnchor
writeFileSync(
  join(root, 'lib', 'onchain', 'proof-anchor-artifact.ts'),
  `/**
 * GENERATED — do not edit by hand.
 * Compiled from contracts/ProofAnchor.sol with solc ${solc.version()} (optimizer 200 runs).
 * Regenerate: node scripts/compile-proof-anchor.mjs
 */
export const PROOF_ANCHOR_ABI = ${JSON.stringify(a.abi)} as const

export const PROOF_ANCHOR_BYTECODE = '0x${a.evm.bytecode.object}' as const
`,
)
console.log('wrote lib/onchain/proof-anchor-artifact.ts —', a.evm.bytecode.object.length / 2, 'bytecode bytes')
