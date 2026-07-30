#!/usr/bin/env node
/**
 * The addresses that get welded into the contract, checked while they can still
 * be changed.
 *
 * `arbiter`, `feeRecipient`, `feeBps` and `flatFee` are all `immutable` in
 * LaborMarketV2 — written by the constructor, no setters. A wrong one is not a
 * config mistake, it is a redeploy, and if the market has taken money by then it
 * is a redeploy plus a migration.
 *
 * Two of these are the kind of wrong that looks perfectly fine:
 *
 *   - `ARBITER_ADDRESS` set to a wallet nobody signs with. There is no
 *     ARBITER_PRIVATE_KEY anywhere in this codebase; `resolveDispute` is signed
 *     by `oracleWallet()` (lib/onchain/labor.ts). So an arbiter that is not the
 *     oracle address makes every dispute unresolvable — and nothing reveals it
 *     until the first dispute, because posting, accepting and settling all work.
 *
 *   - `FEE_RECIPIENT` set to a contract that cannot call `withdraw()`. Fees are
 *     credited to `withdrawable[feeRecipient]` and pulled, never pushed, so an
 *     address that cannot make a call is an address that cannot be paid. The
 *     money accrues correctly and forever.
 *
 * Takes ADDRESSES, which are public. Never a private key.
 *
 *   ORACLE_ADDRESS=0x… ARBITER_ADDRESS=0x… FEE_RECIPIENT=0x… \
 *   DEPLOYER_ADDRESS=0x… node scripts/preflight-addresses.mjs
 *
 * `--rpc <url>` to use something other than the public Base endpoint.
 */

import { createPublicClient, http, formatEther, formatUnits, getAddress, isAddress } from 'viem'
import { base } from 'viem/chains'

const rpcArg = process.argv.indexOf('--rpc')
const RPC = rpcArg > -1 ? process.argv[rpcArg + 1] : 'https://mainnet.base.org'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ZERO = '0x0000000000000000000000000000000000000000'
const client = createPublicClient({ chain: base, transport: http(RPC) })

const problems = []
const warnings = []
const fail = (m) => problems.push(m)
const warn = (m) => warnings.push(m)

/** Read one address from the environment, or record why it is unusable. */
function addr(name, { required = true } = {}) {
  const raw = process.env[name]
  if (!raw || !raw.trim()) {
    if (required) fail(`${name} is not set.`)
    return null
  }
  const v = raw.trim()
  if (!isAddress(v)) {
    fail(`${name} is not an address: ${v}`)
    return null
  }
  if (v.toLowerCase() === ZERO) {
    fail(`${name} is the zero address.`)
    return null
  }
  return getAddress(v)
}

const oracle = addr('ORACLE_ADDRESS')
const arbiter = addr('ARBITER_ADDRESS')
const feeRecipient = addr('FEE_RECIPIENT')
const deployer = addr('DEPLOYER_ADDRESS', { required: false })

console.log('Address preflight — reads only, nothing is deployed or sent.\n')
for (const [label, value] of [
  ['ORACLE_ADDRESS', oracle],
  ['ARBITER_ADDRESS', arbiter],
  ['FEE_RECIPIENT', feeRecipient],
  ['DEPLOYER_ADDRESS', deployer],
]) {
  console.log(`${label.padEnd(18)}: ${value ?? '(not set)'}`)
}
console.log('')

// ---------------------------------------------------------------------------
// The relationships between them, which is where the silent mistakes live
// ---------------------------------------------------------------------------

if (oracle && arbiter && oracle !== arbiter) {
  fail(
    `ARBITER_ADDRESS !== ORACLE_ADDRESS. There is no ARBITER_PRIVATE_KEY in this codebase — ` +
      `resolveDispute is signed by oracleWallet(), so an arbiter that is not the oracle can never rule. ` +
      `The contract would accept the deploy and every dispute would sit until expireDispute swept it.\n` +
      `      This is a real trade, not a free fix. deploy-labor-v2.mjs warns about the same two addresses ` +
      `being equal, and it is right: one leaked key then forges credit scores, rules on disputes, and can ` +
      `call setOracle. Both warnings are true. Separating them for real means adding an ARBITER_PRIVATE_KEY ` +
      `and a second wallet client in resolveDispute — a code change, not a config one. Until that exists, ` +
      `equal is the only combination where disputes resolve at all.`,
  )
}

if (oracle && feeRecipient && oracle === feeRecipient) {
  fail(
    `FEE_RECIPIENT === ORACLE_ADDRESS. The oracle key lives in the server's environment so it can sign ` +
      `resolveDispute; making it the fee recipient means the revenue cannot outlive a key rotation, and ` +
      `anyone who reads that env reads the takings. Use a wallet the server does not hold.`,
  )
}

if (deployer && feeRecipient && deployer === feeRecipient) {
  warn(
    `FEE_RECIPIENT === DEPLOYER_ADDRESS. Not broken, but the deploy key is handled loosely by nature ` +
      `(it is pasted into a shell) and this one owns the fee stream permanently.`,
  )
}

// ---------------------------------------------------------------------------
// What each address can actually do
// ---------------------------------------------------------------------------

async function codeAt(a) {
  try {
    const c = await client.getCode({ address: a })
    return c && c !== '0x' ? (c.length - 2) / 2 : 0
  } catch {
    return null
  }
}

async function balance(a) {
  try {
    return await client.getBalance({ address: a })
  } catch {
    return null
  }
}

if (feeRecipient) {
  const size = await codeAt(feeRecipient)
  if (size === null) warn('FEE_RECIPIENT: could not read code — RPC problem, not an address problem.')
  else if (size > 0) {
    warn(
      `FEE_RECIPIENT is a CONTRACT (${size} bytes). Fees are pulled, not pushed: this address must be able ` +
        `to call withdraw() or withdrawTo(). A smart-account wallet can; a contract with no such path leaves ` +
        `the fees accruing forever with no way to move them.`,
    )
  } else {
    const bal = await balance(feeRecipient)
    if (bal !== null && bal === 0n) {
      warn(
        `FEE_RECIPIENT holds 0 ETH. It is not an agent kernel account, so the paymaster does not cover it — ` +
          `it needs a cent or two to call withdraw(). Not a deploy blocker.`,
      )
    }
  }
}

for (const [label, a, need] of [
  ['DEPLOYER_ADDRESS', deployer, 0.0005],
  ['ORACLE_ADDRESS', oracle, 0.0002],
]) {
  if (!a) continue
  const bal = await balance(a)
  if (bal === null) {
    warn(`${label}: balance unreadable.`)
    continue
  }
  const eth = Number(formatEther(bal))
  const line = `${label.padEnd(18)}: ${eth} ETH`
  if (eth < need) {
    console.log(`${line}  ← below the ${need} ETH this step wants`)
    if (label === 'DEPLOYER_ADDRESS') {
      fail(`DEPLOYER_ADDRESS cannot pay for two contract deploys. Fund it before running the deploy scripts.`)
    } else {
      warn(`${label} has no gas for resolveDispute. Not a deploy blocker; it is a first-dispute blocker.`)
    }
  } else {
    console.log(`${line}  ✓`)
  }
}

// ---------------------------------------------------------------------------
// The token, because six decimals is compiled in
// ---------------------------------------------------------------------------

try {
  const erc20 = [
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  ]
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20, functionName: 'symbol' }),
    client.readContract({ address: USDC, abi: erc20, functionName: 'decimals' }),
  ])
  console.log(`\nUSDC ${USDC}\n  symbol ${symbol}, decimals ${decimals}`)
  if (Number(decimals) !== 6) {
    fail(`USDC reports ${decimals} decimals. Every bounty, cap and fee in this contract is scaled by a compile-time 6.`)
  }
  if (feeRecipient) {
    const bal = await client.readContract({
      address: USDC,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [feeRecipient],
    })
    console.log(`  FEE_RECIPIENT holds ${formatUnits(bal, 6)} USDC today`)
  }
} catch (error) {
  warn(`USDC read failed — ${String(error).split('\n')[0]}`)
}

// ---------------------------------------------------------------------------

console.log('')
for (const w of warnings) console.log(`WARN  ${w}\n`)
for (const p of problems) console.log(`STOP  ${p}\n`)

if (problems.length) {
  console.log(`${problems.length} blocking problem(s). These are immutable once deployed — fix them now, not after.`)
  process.exitCode = 1
} else {
  console.log('No blocking problems. These addresses are safe to pass to the deploy scripts.')
  if (warnings.length) console.log(`${warnings.length} warning(s) above are worth reading first.`)
}
