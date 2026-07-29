#!/usr/bin/env node
/**
 * Deploy AgentCreditRegistry — the prerequisite for LaborMarketV2.
 *
 * The market takes `registry` as an IMMUTABLE constructor argument, so this has
 * to exist first and can never be swapped afterwards. Replacing a compromised
 * registry means replacing the market too and waiting out every live job, which
 * is why the oracle key below deserves more care than a backend key usually
 * gets.
 *
 * ## What the oracle key can and cannot do
 *
 * Cannot: touch escrowed money. That was executed end-to-end during round 2 of
 * the audit with a stolen key and the answer was zero — the market never pays on
 * the strength of a score, only on approval, ruling, or silence.
 *
 * Can: forge every score the market gates on, and hand itself the registry via
 * `setOracle`, which is a single-step transfer with no two-step accept. So a
 * compromise is a race the attacker wins if they move first.
 *
 * Use a hardware-backed key, and do not reuse the arbiter's.
 *
 * ## Env
 *
 *   DEPLOYER_PRIVATE_KEY   funded key that pays gas
 *   ONCHAIN_RPC_URL        an RPC endpoint for the target chain
 *   ONCHAIN_CHAIN          base-sepolia (default) | base
 *   ORACLE_ADDRESS         who may publish scores — REQUIRED
 *
 * Run:  node scripts/deploy-registry.mjs
 *       node scripts/deploy-registry.mjs --confirm-mainnet     (for base)
 */
import { readFileSync } from 'node:fs'
import { createWalletClient, createPublicClient, http, isAddress, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'

const die = (msg) => {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}

const rpcUrl = process.env.ONCHAIN_RPC_URL
const pk = process.env.DEPLOYER_PRIVATE_KEY
const isMainnet = (process.env.ONCHAIN_CHAIN || 'base-sepolia') === 'base'
const chain = isMainnet ? base : baseSepolia

if (!rpcUrl) die('Set ONCHAIN_RPC_URL.')
if (!pk) die('Set DEPLOYER_PRIVATE_KEY.')
if (isMainnet && !process.argv.includes('--confirm-mainnet')) {
  die('ONCHAIN_CHAIN=base is REAL MONEY. Re-run with --confirm-mainnet if that is what you mean.')
}

const oracle = process.env.ORACLE_ADDRESS
if (!oracle || !isAddress(oracle)) {
  die('Set ORACLE_ADDRESS to a valid address. No default: the constructor takes it and setOracle is the only way back, so a wrong value here hands the registry to whoever holds it.')
}

// Compiled here rather than read from a committed artifact, because unlike
// LaborMarketV2 this contract has none. Same solc settings as the market so a
// Basescan verification uses one set of numbers for both.
const SOURCE = 'contracts/src/AgentCreditRegistry.sol'
const solc = (await import('solc')).default
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { [SOURCE]: { content: readFileSync(SOURCE, 'utf8') } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    }),
  ),
)
const errors = (out.errors || []).filter((e) => e.severity === 'error')
if (errors.length) die(errors.map((e) => e.formattedMessage).join('\n'))

const artifact = out.contracts[SOURCE].AgentCreditRegistry
const abi = artifact.abi
const bytecode = `0x${artifact.evm.bytecode.object}`

const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
const pub = createPublicClient({ chain, transport: http(rpcUrl) })

console.log(`\nChain     ${chain.name} (${chain.id})${isMainnet ? '  ⚠ REAL MONEY' : ''}`)
console.log(`Deployer  ${account.address}`)
console.log(`solc      ${solc.version()}`)
console.log(`Bytecode  ${keccak256(bytecode)}  (${bytecode.length / 2 - 1} bytes)`)
console.log(`Oracle    ${oracle}`)

if (oracle.toLowerCase() === account.address.toLowerCase()) {
  console.log(
    `\n⚠ The oracle is the DEPLOYER key. That key has now touched a deploy script and\n` +
      `  an RPC endpoint; the oracle key should be the one that has touched neither.\n` +
      `  setOracle can move it later, but only while you still hold it.`,
  )
}

const balance = await pub.getBalance({ address: account.address })
if (balance === 0n) die('Deployer has no ETH on this chain.')

console.log('\nDeploying…')
const hash = await wallet.deployContract({ abi, bytecode, args: [oracle] })
console.log(`  tx: ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (!receipt.contractAddress) die('No contract address in receipt — deploy failed.')

console.log(`\n✅ AgentCreditRegistry at ${receipt.contractAddress}`)
console.log(`\nSet in your platform env:`)
console.log(`  CREDIT_REGISTRY_ADDRESS=${receipt.contractAddress}`)
console.log(`\nThen deploy the market:`)
console.log(`  CREDIT_REGISTRY_ADDRESS=${receipt.contractAddress} node scripts/deploy-labor-v2.mjs${isMainnet ? ' --confirm-mainnet' : ''}`)
