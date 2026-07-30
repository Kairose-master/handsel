#!/usr/bin/env node
/**
 * Does this ZeroDev project actually sponsor on this chain?
 *
 * The runbook used to answer that at step 8, with a real job and real USDC, and
 * that is very late to learn the paymaster is unfunded or the project is pointed
 * at the wrong chain. Every question below can be asked before a single contract
 * is deployed:
 *
 *   1. which chain the bundler thinks it is on   (eth_chainId)
 *   2. which EntryPoint it will accept           (eth_supportedEntryPoints)
 *   3. whether the paymaster will quote a real   (pm_getPaymasterStubData, then
 *      sponsorship for an operation               pm_getPaymasterData)
 *
 * Step 3 is the one that matters. Reading the paymaster's EntryPoint deposit on
 * chain is NOT the same test — it read 0 for this deployment's paymaster while
 * the account balance was $10, because a provider may fund the deposit only as
 * it routes operations. A deposit of zero and a paymaster that is genuinely dry
 * look identical from chain state. Asking the paymaster to quote is the question
 * whose answer differs.
 *
 * Sends nothing, signs nothing, spends nothing. A quote is not an operation.
 *
 *   ZERODEV_RPC=https://rpc.zerodev.app/api/v3/<project>/chain/8453 \
 *   node scripts/check-sponsorship.mjs
 *
 * Optionally `--sender 0x…` to quote for a specific account; the default is a
 * throwaway address, which is enough to tell a configured paymaster from an
 * unconfigured one but will be rejected by a project whose allowlist is already
 * narrowed to the market contracts. That rejection is a PASS for the allowlist
 * and is reported as such.
 */

const RPC = process.env.ZERODEV_RPC
if (!RPC) {
  console.error('ZERODEV_RPC is required — the mainnet project URL, not the testnet one.')
  process.exit(1)
}

const argSender = process.argv.indexOf('--sender')
const SENDER =
  argSender > -1 ? process.argv[argSender + 1] : '0x1111111111111111111111111111111111111111'

const ENTRYPOINT_07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const ENTRYPOINT_06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'

let id = 0
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const body = await res.json().catch(() => ({ error: { message: `non-JSON response, HTTP ${res.status}` } }))
  if (body.error) throw Object.assign(new Error(body.error.message ?? 'rpc error'), { data: body.error })
  return body.result
}

// Never print the URL — it carries the project id, which is the credential.
const redact = (s) => String(s).replaceAll(RPC, '<ZERODEV_RPC>')

console.log('Sponsorship preflight — nothing is sent, signed or spent.\n')

let chainId = null
try {
  chainId = Number(await rpc('eth_chainId', []))
  const known = { 8453: 'Base mainnet', 84532: 'Base Sepolia', 11155111: 'Ethereum Sepolia' }
  console.log(`chain            : ${chainId} ${known[chainId] ? `(${known[chainId]})` : '(unrecognised)'}`)
  if (chainId === 84532) {
    console.log('                   ⚠ this is the TESTNET project. A mainnet deployment pointed here')
    console.log('                     sponsors nothing and fails at the first write.')
  }
} catch (error) {
  console.log(`chain            : unreadable — ${redact(error.message)}`)
}

let entryPoint = ENTRYPOINT_07
try {
  const eps = await rpc('eth_supportedEntryPoints', [])
  const list = (eps ?? []).map((e) => String(e))
  const has07 = list.some((e) => e.toLowerCase() === ENTRYPOINT_07.toLowerCase())
  const has06 = list.some((e) => e.toLowerCase() === ENTRYPOINT_06.toLowerCase())
  console.log(`entry points     : ${list.length ? list.join(', ') : '(none reported)'}`)
  if (!has07) {
    entryPoint = has06 ? ENTRYPOINT_06 : entryPoint
    console.log('                   ⚠ v0.7 not offered. Kernel v3.1 accounts are v0.7 — a project')
    console.log('                     configured for v0.6 will reject every operation this app builds.')
  }
} catch (error) {
  console.log(`entry points     : unreadable — ${redact(error.message)}`)
}

/**
 * A syntactically complete but unsigned v0.7 UserOperation.
 *
 * The paymaster is being asked to price an operation, not to run one. Gas fields
 * are nominal; a provider that quotes at all will quote against these, and one
 * that refuses tells us why in its error, which is the actual output of this
 * script.
 */
const userOp = {
  sender: SENDER,
  nonce: '0x0',
  callData: '0x',
  callGasLimit: '0x30d40',
  verificationGasLimit: '0x30d40',
  preVerificationGas: '0xc350',
  maxFeePerGas: '0x5f5e100',
  maxPriorityFeePerGas: '0x5f5e100',
  signature: '0x' + 'ff'.repeat(65),
}

console.log('')
let quoted = false
for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData', 'zd_sponsorUserOperation']) {
  const params =
    method === 'zd_sponsorUserOperation'
      ? [{ userOp, entryPointAddress: entryPoint, chainId }]
      : [userOp, entryPoint, chainId ? `0x${chainId.toString(16)}` : '0x2105', {}]
  try {
    const result = await rpc(method, params)
    const keys = result && typeof result === 'object' ? Object.keys(result) : []
    const pm = result?.paymaster ?? result?.paymasterAndData
    console.log(`${method.padEnd(24)}: QUOTED${pm ? ` → paymaster ${String(pm).slice(0, 12)}…` : ''}`)
    if (keys.length) console.log(`${' '.repeat(26)}fields: ${keys.join(', ')}`)
    quoted = true
    break
  } catch (error) {
    console.log(`${method.padEnd(24)}: ${redact(error.message)}`)
  }
}

console.log('')
if (quoted) {
  console.log('PASS — the project quotes sponsorship on this chain. The remaining unknown is')
  console.log('whether the balance covers real operations, which only spending some answers.')
} else {
  console.log('The paymaster did not quote. Read the errors above rather than assuming a cause —')
  console.log('they distinguish the cases that look alike:')
  console.log('')
  console.log('  "not allowed" / "policy" / "sender"  → the allowlist is doing its job. Expected')
  console.log('                                          with the default throwaway sender; re-run')
  console.log('                                          with --sender <a provisioned kernel address>.')
  console.log('  "insufficient" / "balance" / "funds" → the grant is not spendable on this chain.')
  console.log('  "unsupported method"                 → paymaster not enabled on the project.')
  console.log('  "chain"                              → the project is not configured for this chain.')
  process.exitCode = 1
}
