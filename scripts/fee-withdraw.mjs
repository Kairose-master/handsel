#!/usr/bin/env node
/**
 * Collect the protocol fee. The one balance the platform's own sweep does not
 * touch.
 *
 * LaborMarketV2 CREDITS, it does not transfer: every payout — worker earnings,
 * refunds, and the posting fee — is a number in `withdrawable(address)` until
 * that address calls `withdraw()`. `lib/withdraw-sweep.ts` collects those
 * balances automatically, but only for rows in `agent` with a smart account.
 * `FEE_RECIPIENT` is not an agent. It has no kernel account, the paymaster does
 * not cover it, and nothing in the running system has ever called `withdraw()`
 * on its behalf.
 *
 * That is deliberate — the fee key does not belong in a server environment — and
 * the cost of it is this script. Without something like it the fee accrues
 * correctly and forever, which is the exact failure
 * `scripts/preflight-addresses.mjs` warns about before deploy, seen from the
 * other side of the deploy.
 *
 * ## Two rules this script does not bend
 *
 * **1. Read-only unless you say otherwise.** Bare invocation reports and exits.
 * Moving money takes `--send`, and `--send` needs a key.
 *
 * **2. The contract is the authority on who the fee recipient is, not the
 * environment.** `feeRecipient` is `immutable` in LaborMarketV2, so the address
 * in your shell is a claim and the address in the contract is the fact. This
 * reads the contract and compares. A mismatch is reported and, in `--send` mode,
 * refused: signing with a key that is not the fee recipient does not fail
 * usefully, it succeeds at withdrawing that signer's own (probably zero)
 * balance.
 *
 * ## Env
 *
 *   LABOR_MARKET_ADDRESS   the deployed LaborMarketV2
 *   ONCHAIN_RPC_URL        an RPC endpoint for the target chain
 *   ONCHAIN_CHAIN          base-sepolia (default) | base
 *   FEE_RECIPIENT          optional; only to cross-check against the contract
 *   FEE_RECIPIENT_KEY      REQUIRED for --send. Never passed as an argument:
 *                          argv is visible to every process on the machine and
 *                          lands in shell history. Env only.
 *
 * ## Use
 *
 *   # what is there (safe, no key, no signing)
 *   LABOR_MARKET_ADDRESS=0x… ONCHAIN_RPC_URL=https://… ONCHAIN_CHAIN=base \
 *     node scripts/fee-withdraw.mjs
 *
 *   # collect it to the fee recipient itself
 *   … FEE_RECIPIENT_KEY=0x… node scripts/fee-withdraw.mjs --send --confirm-mainnet
 *
 *   # collect it straight to somewhere else (one transaction, not two)
 *   … node scripts/fee-withdraw.mjs --send --to 0xYourColdWallet --confirm-mainnet
 *
 * `--confirm-mainnet` is required when ONCHAIN_CHAIN=base, matching
 * scripts/deploy-labor-v2.mjs. Not a prompt — a prompt is something you learn to
 * press through.
 */

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'

const { LABOR_MARKET_V2_ABI } = await import('../lib/onchain/labor-v2-artifact.ts')

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}
const warn = (msg) => console.log(`  ! ${msg}`)

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const SEND = argv.includes('--send')
const toArg = argv.indexOf('--to')
const DEST = toArg > -1 ? argv[toArg + 1] : null

const rpcUrl = process.env.ONCHAIN_RPC_URL
const marketRaw = process.env.LABOR_MARKET_ADDRESS
const chainName = process.env.ONCHAIN_CHAIN || 'base-sepolia'
const key = process.env.FEE_RECIPIENT_KEY

if (chainName !== 'base' && chainName !== 'base-sepolia') {
  die(`ONCHAIN_CHAIN="${chainName}" is not a chain this script knows (base | base-sepolia).`)
}
const isMainnet = chainName === 'base'
const chain = isMainnet ? base : baseSepolia

// The four-variables-missing-at-once case is almost never four mistakes. It is
// `A=1 B=2` typed on a line with no command, which sets shell parameters that
// are never exported — so the next line's `node` sees none of them.
if (!rpcUrl && !marketRaw) {
  die(
    'Neither ONCHAIN_RPC_URL nor LABOR_MARKET_ADDRESS is set.\n' +
      '  If you typed them as `A=… B=…` on their own line, they were not exported.\n' +
      '  Either `export` them, or put them on the same line as this command.',
  )
}
if (!rpcUrl) die('Set ONCHAIN_RPC_URL.')
if (!marketRaw) die('Set LABOR_MARKET_ADDRESS.')
if (!isAddress(marketRaw.trim())) die(`LABOR_MARKET_ADDRESS is not an address: ${marketRaw}`)
const MARKET = getAddress(marketRaw.trim())

if (DEST !== null && !isAddress(String(DEST))) {
  die(`--to needs an address. Got: ${DEST ?? '(nothing — the flag was last on the line)'}`)
}
const TO = DEST ? getAddress(DEST) : null

if (SEND && isMainnet && !argv.includes('--confirm-mainnet')) {
  die('ONCHAIN_CHAIN=base is REAL MONEY. Re-run with --confirm-mainnet if that is what you mean.')
}

const client = createPublicClient({ chain, transport: http(rpcUrl) })
const market = { address: MARKET, abi: LABOR_MARKET_V2_ABI }

console.log(`\nLaborMarketV2 ${MARKET}`)
console.log(`chain         ${chainName} (${chain.id})${isMainnet ? '  — REAL MONEY' : ''}`)

// ---------------------------------------------------------------------------
// Who the contract says the fee recipient is
// ---------------------------------------------------------------------------

let onchainFeeRecipient
try {
  onchainFeeRecipient = getAddress(await client.readContract({ ...market, functionName: 'feeRecipient' }))
} catch (error) {
  die(
    `Could not read feeRecipient() from ${MARKET} — ${String(error).split('\n')[0]}\n` +
      '  Either the address is not a LaborMarketV2, or it is on a different chain than ONCHAIN_CHAIN says.',
  )
}
console.log(`feeRecipient  ${onchainFeeRecipient}  (immutable, read from the contract)`)

const claimed = process.env.FEE_RECIPIENT?.trim()
if (claimed) {
  if (!isAddress(claimed)) warn(`FEE_RECIPIENT in your environment is not an address: ${claimed}`)
  else if (getAddress(claimed) !== onchainFeeRecipient) {
    warn(`FEE_RECIPIENT in your environment is ${getAddress(claimed)} — the contract disagrees. The contract wins.`)
  }
}

// ---------------------------------------------------------------------------
// What is actually there
// ---------------------------------------------------------------------------

const [rawWithdrawable, usdcAddress] = await Promise.all([
  client.readContract({ ...market, functionName: 'withdrawable', args: [onchainFeeRecipient] }),
  client.readContract({ ...market, functionName: 'usdc' }),
])
const withdrawableUsd = formatUnits(rawWithdrawable, 6)

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
]
let held = null
let symbol = 'USDC'
try {
  ;[held, symbol] = await Promise.all([
    client.readContract({ address: usdcAddress, abi: erc20, functionName: 'balanceOf', args: [onchainFeeRecipient] }),
    client.readContract({ address: usdcAddress, abi: erc20, functionName: 'symbol' }),
  ])
} catch {
  warn('Could not read the token balance — RPC problem, not a withdrawal problem.')
}

const gasBal = await client.getBalance({ address: onchainFeeRecipient }).catch(() => null)
const code = await client.getCode({ address: onchainFeeRecipient }).catch(() => null)

console.log('')
console.log(`withdrawable  ${withdrawableUsd} ${symbol}   ← credited by settlement, not yet collected`)
if (held !== null) console.log(`already held  ${formatUnits(held, 6)} ${symbol}   ← previously collected`)
console.log(`gas balance   ${gasBal === null ? '(unreadable)' : formatEther(gasBal)} ETH`)

if (code && code !== '0x') {
  warn(
    `The fee recipient is a CONTRACT (${(code.length - 2) / 2} bytes). Fees are pulled, not pushed — it has to be ` +
      'able to make the call itself. A private key cannot sign for it, so this script cannot collect them.',
  )
}
if (gasBal === 0n) {
  warn('0 ETH. Nothing here is paymaster-sponsored — the fee recipient pays its own gas. Send it a cent or two first.')
}
if (rawWithdrawable === 0n) {
  console.log('\nNothing to collect. Settlement has credited this address 0 since the last withdrawal.\n')
  process.exit(0)
}

if (!SEND) {
  console.log(
    `\nRead-only. To collect ${withdrawableUsd} ${symbol}:\n` +
      `  FEE_RECIPIENT_KEY=0x… node scripts/fee-withdraw.mjs --send${isMainnet ? ' --confirm-mainnet' : ''}` +
      `${TO ? ` --to ${TO}` : ''}\n`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

if (!key) die('--send needs FEE_RECIPIENT_KEY in the environment. Do not pass a key as an argument.')

let account
try {
  account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
} catch {
  die('FEE_RECIPIENT_KEY is not a valid private key (expected 0x + 64 hex).')
}

// The check that makes this script safe to run twice. withdraw() takes no
// arguments and moves msg.sender's balance — a wrong key does not revert, it
// quietly withdraws zero and reports success.
if (account.address !== onchainFeeRecipient) {
  die(
    `FEE_RECIPIENT_KEY signs for ${account.address}, but the contract's fee recipient is ${onchainFeeRecipient}.\n` +
      '  withdraw() moves the SIGNER\'s balance, so this would have "succeeded" and collected nothing.',
  )
}

const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
const fn = TO ? 'withdrawTo' : 'withdraw'
const args = TO ? [TO] : []

console.log(`\n→ ${fn}(${TO ?? ''}) as ${account.address}`)

// Simulate first: a revert here costs nothing, and it names the reason.
try {
  await client.simulateContract({ ...market, functionName: fn, args, account })
} catch (error) {
  die(`Simulation reverted — nothing was sent. ${String(error).split('\n')[0]}`)
}

const hash = await wallet.writeContract({ ...market, functionName: fn, args })
console.log(`  tx ${hash}`)
const receipt = await client.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') die(`Transaction reverted on-chain: ${hash}`)

const after = await client.readContract({ ...market, functionName: 'withdrawable', args: [onchainFeeRecipient] })
console.log(`\n✔ collected ${withdrawableUsd} ${symbol} → ${TO ?? onchainFeeRecipient}`)
console.log(`  withdrawable is now ${formatUnits(after, 6)} ${symbol}`)
console.log(`  gas used ${receipt.gasUsed}\n`)
