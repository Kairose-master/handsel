/**
 * Produce everything Basescan needs to verify a LaborMarketV2 deployment, and
 * PROVE it reproduces the deployed code before anybody uploads anything.
 *
 * Usage:
 *   node scripts/verify-bundle-labor-v2.mjs 0x<market address> [--rpc URL]
 *
 * A failed verification tells you almost nothing about why. Solc version,
 * optimizer runs, viaIR, EVM version and the exact source bytes all have to
 * match, and Basescan reports one generic mismatch for any of them. So this
 * checks the two things that can be checked locally FIRST:
 *
 *   1. recompiling the committed source reproduces the creation-bytecode keccak
 *      the deploy script recorded, and
 *   2. that compile's runtime bytecode equals the code actually at the address.
 *
 * (2) is the real proof. Runtime code is what the chain holds and what Basescan
 * compares, so if it matches, a verification failure afterwards is a form-filling
 * mistake and not a source mismatch — which is worth knowing before you spend an
 * afternoon on it.
 *
 * Emits the standard-JSON input rather than flattened source. Flattening is a
 * text transform that has to preserve pragma and import semantics exactly;
 * standard JSON is the same object solc already compiled, so it cannot drift.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPublicClient, http, keccak256, encodeAbiParameters, getAddress } from 'viem'
import { baseSepolia, base, sepolia } from 'viem/chains'

const require = createRequire(import.meta.url)
const SOURCE = 'contracts/src/LaborMarketV2.sol'
const CONTRACT = 'LaborMarketV2'
const OUT = 'docs/verify-labor-v2.standard.json'

const address = process.argv[2]
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error('Usage: node scripts/verify-bundle-labor-v2.mjs 0x<market address> [--rpc URL]')
  process.exit(1)
}
const rpcFlag = process.argv.indexOf('--rpc')
const rpcUrl = rpcFlag > -1 ? process.argv[rpcFlag + 1] : process.env.ONCHAIN_RPC_URL || 'https://sepolia.base.org'

let solc
try {
  solc = require(process.env.SOLC_PATH || 'solc')
} catch {
  console.error('solc not available. npm install --no-save solc@0.8.24')
  process.exit(1)
}

// The SAME settings object the artifact was built with. Duplicated here on
// purpose rather than imported: if compile-labor-v2.mjs ever changes its
// settings, this must fail loudly at the keccak check instead of silently
// following along and producing a bundle for a different compile.
const input = {
  language: 'Solidity',
  sources: { [SOURCE]: { content: readFileSync(SOURCE, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: {
      '*': {
        '*': [
          'abi',
          'evm.bytecode.object',
          'evm.deployedBytecode.object',
          // Where the immutables live. Without this the runtime comparison below
          // cannot be made correctly — see the masking note there.
          'evm.deployedBytecode.immutableReferences',
        ],
      },
    },
  },
}

console.log(`solc            ${solc.version()}`)
const out = JSON.parse(solc.compile(JSON.stringify(input)))
for (const e of out.errors ?? []) {
  if (e.severity === 'error') {
    console.error(e.formattedMessage)
    process.exit(1)
  }
}
const c = out.contracts[SOURCE][CONTRACT]
const creation = `0x${c.evm.bytecode.object}`
const runtime = `0x${c.evm.deployedBytecode.object}`

const EXPECTED_CREATION_KECCAK = '0xf9e4abc1c2838a357245c66e3d2e77dbab41b98f35b039140da6352ea0bc3bcd'
const gotKeccak = keccak256(creation)
console.log(`creation keccak ${gotKeccak}`)
console.log(`  expected      ${EXPECTED_CREATION_KECCAK}`)
if (gotKeccak !== EXPECTED_CREATION_KECCAK) {
  console.error('\nMISMATCH — the committed source no longer compiles to the artifact that was deployed.')
  console.error('Do not verify with this bundle: it describes different code.')
  process.exit(1)
}
console.log('  ✅ committed source reproduces the deployed artifact')

const CHAINS = { 84532: baseSepolia, 8453: base, 11155111: sepolia }
const probe = createPublicClient({ transport: http(rpcUrl) })
const chainId = await probe.getChainId()
const client = createPublicClient({ chain: CHAINS[chainId] ?? baseSepolia, transport: http(rpcUrl) })
const onchain = await client.getCode({ address: getAddress(address) })
if (!onchain || onchain === '0x') {
  console.error(`\nNo contract code at ${address} on chain ${chainId}.`)
  process.exit(1)
}

/**
 * Compare runtime code, with the immutables masked out.
 *
 * This contract has fifteen `immutable` members, and an immutable is written INTO
 * the runtime bytecode by the constructor. So a local compile carries zeros where
 * the deployed code carries the configured values, and a byte-for-byte comparison
 * of the two is guaranteed to fail on a correct deployment. The first version of
 * this check did exactly that and reported "runtime code DIFFERS" for a contract
 * that was perfectly fine — same length, identical metadata trailer, differing
 * middle, which is the signature of precisely this.
 *
 * solc reports the byte ranges in `immutableReferences`, so mask those and
 * compare the rest. Masking is not weakening the check: the immutable VALUES are
 * verified separately and far better, by reading them back through their public
 * getters below.
 */
function maskImmutables(hex, refs) {
  const bytes = Buffer.from(hex.slice(2), 'hex')
  let masked = 0
  for (const spots of Object.values(refs ?? {})) {
    for (const { start, length } of spots) {
      bytes.fill(0, start, start + length)
      masked += length
    }
  }
  return { hex: `0x${bytes.toString('hex')}`, masked }
}

console.log(`\nchain           ${chainId}`)
console.log(`runtime bytes   local ${(runtime.length - 2) / 2}   onchain ${(onchain.length - 2) / 2}`)
const refs = c.evm.deployedBytecode.immutableReferences
const a = maskImmutables(runtime, refs)
const b = maskImmutables(onchain, refs)
console.log(`immutables      ${Object.keys(refs ?? {}).length} members, ${a.masked} bytes masked in both`)
const bodyMatch = a.hex === b.hex
console.log(bodyMatch ? '  ✅ runtime code matches the deployed contract' : '  ❌ runtime code DIFFERS')
if (!bodyMatch) {
  // Where, so the next person is not left guessing.
  for (let i = 2; i < Math.min(a.hex.length, b.hex.length); i += 2) {
    if (a.hex.slice(i, i + 2) !== b.hex.slice(i, i + 2)) {
      console.error(`  first difference at byte ${(i - 2) / 2}`)
      break
    }
  }
  process.exit(1)
}

writeFileSync(OUT, JSON.stringify(input, null, 2))
console.log(`\nwrote ${OUT}  (${(JSON.stringify(input).length / 1024).toFixed(1)} KB)`)

// Constructor arguments, read back FROM THE CHAIN rather than retyped. Retyping
// them is the single most common reason a correct source fails to verify, and
// every one of these has a public getter.
const abi = JSON.parse(
  readFileSync('lib/onchain/labor-v2-artifact.ts', 'utf8').match(
    /export const LABOR_MARKET_V2_ABI = (\[[\s\S]*?\]) as const/,
  )[1],
)
const get = (fn) => client.readContract({ address: getAddress(address), abi, functionName: fn })
const cfg = {
  feeBps: Number(await get('feeBps')),
  feeRecipient: await get('feeRecipient'),
  flatFee: await get('flatFee'),
  bondBps: Number(await get('bondBps')),
  flatBond: await get('flatBond'),
  minDeliveryWindow: Number(await get('MIN_DELIVERY_WINDOW')),
  maxDeliveryWindow: Number(await get('MAX_DELIVERY_WINDOW')),
  reviewWindow: Number(await get('REVIEW_WINDOW')),
  maxOpenWindow: Number(await get('MAX_OPEN_WINDOW')),
  disputeWindow: Number(await get('DISPUTE_WINDOW')),
  silenceForfeitBps: Number(await get('SILENCE_FORFEIT_BPS')),
  minBounty: await get('MIN_BOUNTY'),
}
const ctor = abi.find((x) => x.type === 'constructor')
const encoded = encodeAbiParameters(ctor.inputs, [
  await get('usdc'),
  await get('registry'),
  await get('arbiter'),
  cfg,
])

console.log('\nconstructor arguments, read from the chain:')
console.log(`  usdc      ${await get('usdc')}`)
console.log(`  registry  ${await get('registry')}`)
console.log(`  arbiter   ${await get('arbiter')}`)
for (const [k, v] of Object.entries(cfg)) console.log(`  ${k.padEnd(18)} ${v}`)
console.log('\nABI-encoded constructor arguments (paste WITHOUT the 0x):')
console.log(encoded.slice(2))

console.log(`
Basescan form
  Compiler type      Solidity (Standard-Json-Input)
  Compiler version   v0.8.24+commit.e11b9ed9
  Open source licence  as declared in the SPDX header of ${SOURCE}
  Upload             ${OUT}
  Constructor args   the hex above, no 0x prefix

Optimizer and viaIR come from the JSON, so there is nothing to re-enter and
nothing to get wrong.`)
