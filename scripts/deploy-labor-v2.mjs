#!/usr/bin/env node
/**
 * Deploy LaborMarketV2.
 *
 * ## It deploys the COMMITTED artifact, and does not recompile
 *
 * `lib/onchain/labor-v2-artifact.ts` is checked in, and round 2 of the audit
 * verified it byte-identical to a fresh compile of the audited source. Any
 * deploy script that recompiles throws that away: the bytes that reach the
 * chain become whatever the local solc produced today, and "the deployed
 * contract is the audited contract" stops being checkable. So this reads the
 * artifact, prints its hash, and deploys exactly those bytes.
 *
 * ## Env
 *
 *   DEPLOYER_PRIVATE_KEY   funded key that pays gas (0x…64 hex)
 *   ONCHAIN_RPC_URL        an RPC endpoint for the target chain
 *   ONCHAIN_CHAIN          base-sepolia (default) | base
 *   USDC_ADDRESS           the escrow token — REQUIRED, no default, ever
 *   CREDIT_REGISTRY_ADDRESS  a deployed AgentCreditRegistry
 *   ARBITER_ADDRESS        who may call resolveDispute
 *   FEE_RECIPIENT          where the posting fee accrues (only if fee > 0)
 *
 * Config overrides, all optional — the defaults are the recommended FIRST
 * mainnet deployment and are deliberately conservative:
 *
 *   FEE_BPS=0              a fee makes squatting a grief the victim pays for
 *   BOND_BPS=0             a bond needs capital a new worker does not have
 *   REVIEW_WINDOW_S        default 1 day, not 7 — jobs here finish in minutes
 *   MAX_OPEN_WINDOW_S, DISPUTE_WINDOW_S, MIN/MAX_DELIVERY_WINDOW_S, MIN_BOUNTY
 *
 * Run:  node scripts/deploy-labor-v2.mjs
 *       node scripts/deploy-labor-v2.mjs --confirm-mainnet     (for base)
 */
import { readFileSync } from 'node:fs'
import { createWalletClient, createPublicClient, http, keccak256, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'

const { LABOR_MARKET_V2_ABI, LABOR_MARKET_V2_BYTECODE } = await import('../lib/onchain/labor-v2-artifact.ts')

const rpcUrl = process.env.ONCHAIN_RPC_URL
const pk = process.env.DEPLOYER_PRIVATE_KEY
const chainName = process.env.ONCHAIN_CHAIN || 'base-sepolia'
const isMainnet = chainName === 'base'
const chain = isMainnet ? base : baseSepolia

const die = (msg) => {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}

if (!rpcUrl) die('Set ONCHAIN_RPC_URL.')
if (!pk) die('Set DEPLOYER_PRIVATE_KEY.')

// Real money needs an explicit flag. Not a prompt — a prompt in a script is
// something you learn to press through.
if (isMainnet && !process.argv.includes('--confirm-mainnet')) {
  die('ONCHAIN_CHAIN=base is REAL MONEY. Re-run with --confirm-mainnet if that is what you mean.')
}

const addr = (name, { required = true } = {}) => {
  const v = process.env[name]
  if (!v) {
    if (required) die(`Set ${name}. There is deliberately no default — a plausible-looking wrong address is unrecoverable.`)
    return '0x0000000000000000000000000000000000000000'
  }
  if (!isAddress(v)) die(`${name} is not an address: ${v}`)
  return v
}
const num = (name, fallback) => {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) die(`${name} must be a non-negative number, got ${v}`)
  return n
}

const usdc = addr('USDC_ADDRESS')
const registry = addr('CREDIT_REGISTRY_ADDRESS')
const arbiter = addr('ARBITER_ADDRESS')
const feeBps = num('FEE_BPS', 0)
const feeRecipient = addr('FEE_RECIPIENT', { required: feeBps > 0 })

const DAY = 24 * 60 * 60
const cfg = {
  feeBps,
  feeRecipient,
  bondBps: num('BOND_BPS', 0),
  minDeliveryWindow: num('MIN_DELIVERY_WINDOW_S', 10 * 60),
  maxDeliveryWindow: num('MAX_DELIVERY_WINDOW_S', 30 * DAY),
  // One day, not the seven the constant used to hardcode. Seven days is very
  // long for a market whose jobs finish in minutes, and it is the exposure
  // window for both the accept-squat and the silence forfeit.
  reviewWindow: num('REVIEW_WINDOW_S', 1 * DAY),
  maxOpenWindow: num('MAX_OPEN_WINDOW_S', 60 * DAY),
  disputeWindow: num('DISPUTE_WINDOW_S', 14 * DAY),
  silenceForfeitBps: num('SILENCE_FORFEIT_BPS', 1000),
  minBounty: BigInt(process.env.MIN_BOUNTY ?? '1'),
}

const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
const pub = createPublicClient({ chain, transport: http(rpcUrl) })

// The constructor rejects a non-contract usdc/registry, but it does so AFTER
// you have paid deploy gas. Checking here turns a wasted deployment into a
// one-line error.
for (const [name, address] of [['USDC_ADDRESS', usdc], ['CREDIT_REGISTRY_ADDRESS', registry]]) {
  const code = await pub.getCode({ address })
  if (!code || code === '0x') die(`${name} (${address}) has no code on ${chain.name}. Wrong chain, or not deployed.`)
}

console.log(`\nChain     ${chain.name} (${chain.id})${isMainnet ? '  ⚠ REAL MONEY' : ''}`)
console.log(`Deployer  ${account.address}`)
console.log(`Bytecode  ${keccak256(LABOR_MARKET_V2_BYTECODE)}  (${LABOR_MARKET_V2_BYTECODE.length / 2 - 1} bytes)`)
console.log(`\nConfig — every value below is IMMUTABLE once this lands:`)
for (const [k, v] of Object.entries(cfg)) console.log(`  ${k.padEnd(20)} ${v}`)
console.log(`  ${'arbiter'.padEnd(20)} ${arbiter}`)
console.log(`  ${'usdc'.padEnd(20)} ${usdc}`)
console.log(`  ${'registry'.padEnd(20)} ${registry}`)

const balance = await pub.getBalance({ address: account.address })
if (balance === 0n) die('Deployer has no ETH on this chain.')

console.log('\nDeploying…')
const hash = await wallet.deployContract({
  abi: LABOR_MARKET_V2_ABI,
  bytecode: LABOR_MARKET_V2_BYTECODE,
  args: [usdc, registry, arbiter, cfg],
})
console.log(`  tx: ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (!receipt.contractAddress) die('No contract address in receipt — deploy failed.')

console.log(`\n✅ LaborMarketV2 at ${receipt.contractAddress}`)
console.log(`\nSet in your platform env:`)
console.log(`  LABOR_MARKET_ADDRESS=${receipt.contractAddress}`)
console.log(`\nVerify on Basescan with the COMMITTED source, solc 0.8.24, optimizer 200 runs, viaIR ON.`)
console.log(`A verification that does not reproduce ${keccak256(LABOR_MARKET_V2_BYTECODE)} is a different contract.`)
