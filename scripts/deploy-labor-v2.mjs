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
 *   FEE_BPS=0              proportional fee, scales with the value at risk
 *   FLAT_FEE=0             flat fee in TOKEN UNITS — this is what covers gas
 *   BOND_BPS=0             proportional bond
 *   FLAT_BOND=0            flat bond in TOKEN UNITS — what makes accept cost something
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
const big = (name, fallback) => {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  try {
    const n = BigInt(v)
    if (n < 0n) throw new Error()
    return n
  } catch {
    die(`${name} must be a non-negative integer in TOKEN UNITS (USDC has 6 decimals, so $0.03 is 30000), got ${v}`)
  }
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
// A percentage cannot cover a fixed cost. Every job burns roughly the same
// sponsored gas whatever its bounty, so a bps-only fee is solvent on large jobs
// and a subsidy on small ones — and MAX_FEE_BPS caps the percentage at a
// fraction of a number that is already tiny, so it cannot simply be raised.
// Size this at the measured gas envelope for one job's full lifecycle.
const flatFee = big('FLAT_FEE', 0n)
const feeRecipient = addr('FEE_RECIPIENT', { required: feeBps > 0 || flatFee > 0n })

const DAY = 24 * 60 * 60
const cfg = {
  feeBps,
  feeRecipient,
  flatFee,
  bondBps: num('BOND_BPS', 0),
  // The same arithmetic on the worker side: 5% of a cent-scale bounty deters
  // nobody, so `acceptJob` stays free exactly where the market is thinnest.
  flatBond: big('FLAT_BOND', 0n),
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

// The three token-denominated numbers, checked here for the same reason the
// usdc/registry addresses are: the constructor rejects them, but only after you
// have paid deploy gas. The value this catches is `1e18` typed out of ETH habit
// for a six-decimal token — wrong by a factor of a trillion, and before
// MAX_TOKEN_PARAM existed it deployed clean and left the market dead.
const MAX_TOKEN_PARAM = 1_000_000_000n // 1,000 units at six decimals
for (const [name, value] of [
  ['FLAT_FEE', cfg.flatFee],
  ['FLAT_BOND', cfg.flatBond],
  ['MIN_BOUNTY', cfg.minBounty],
]) {
  if (value > MAX_TOKEN_PARAM) {
    die(
      `${name}=${value} exceeds MAX_TOKEN_PARAM (${MAX_TOKEN_PARAM}). ` +
        `These are TOKEN UNITS, not whole tokens: USDC has six decimals, so one dollar is 1000000. ` +
        `If you meant one dollar and wrote 1e18, that is the mistake this bound exists to catch.`,
    )
  }
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

// Which roles this deployment puts on one key, stated at deploy time.
//
// Sharing them is a legitimate choice and it costs NOTHING in gas — gas is
// charged per transaction, not per address, so three keys and one key pay the
// same fees. What sharing actually saves is the bother of funding three
// addresses and the dust left in each.
//
// What it costs is blast radius, and that is worth seeing on the screen at the
// moment it becomes permanent rather than reconstructing it from memory later:
//
//   registry oracle  setLimit() writes ANY agent's credit score and limit —
//                    the whole product claim is that a score is earned — and
//                    setOracle() can hand the registry to someone else
//                    PERMANENTLY. That one is not recoverable; it is a
//                    redeployment of the registry and every score in it.
//   market arbiter    resolveDispute(id, false) refunds any contested job.
//                    IMMUTABLE here: no setter, so this address cannot be
//                    rotated after the fact the way the oracle can.
//   deployer          nothing, once this transaction lands. LaborMarketV2 has
//                    no owner and the registry takes its oracle as a
//                    constructor argument, so merging THIS role in is free.
//
// The two that matter fail in opposite directions: a leaked oracle key can be
// rotated only if you notice before the attacker calls setOracle, and a leaked
// arbiter key cannot be rotated at all.
if (arbiter.toLowerCase() === account.address.toLowerCase()) {
  console.log('\n⚠ deployer and arbiter are the SAME address.')
  console.log('  Deployer authority ends with this transaction, so the risk here is the')
  console.log('  arbiter half: it is immutable and can never be rotated.')
}
if (process.env.ORACLE_ADDRESS && process.env.ORACLE_ADDRESS.toLowerCase() === arbiter.toLowerCase()) {
  console.log('\n⚠ arbiter and registry oracle are the SAME address.')
  console.log('  One leaked key then forges credit scores, refunds disputes, AND can call')
  console.log('  setOracle to lock you out of the registry permanently.')
}

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
