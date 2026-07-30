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
 *   3. whether the paymaster will price a real operation, for a real
 *      counterfactual Kernel account built the way the app builds one
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
 * The sender is a Kernel v3.1 account derived from a key generated at run time
 * and never stored. It has never existed on chain, which is what makes the
 * answer meaningful: a project that prices an operation for an account it has
 * never seen is a project that will price one for a real agent.
 *
 * `--owner-key <key>` to derive a known kernel address instead, for a project
 * whose allowlist is already narrowed. `--rpc <url>` for a Base node other than
 * the public one.
 */

const RPC = process.env.ZERODEV_RPC
if (!RPC) {
  console.error('ZERODEV_RPC is required — the mainnet project URL, not the testnet one.')
  process.exit(1)
}

// Normally an ephemeral key is generated per run. `--owner-key` reuses one so a
// project whose allowlist is narrowed to known senders can be quoted against a
// kernel address it recognises. Not required, and not stored.
const argKey = process.argv.indexOf('--owner-key')
const SENDER_KEY = argKey > -1 ? process.argv[argKey + 1] : null

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
 * A REAL counterfactual Kernel account, built the way the app builds one.
 *
 * The first version of this script sent a nominal UserOperation from a made-up
 * address and got `AA20 account not deployed` from all three methods — which is
 * not a policy answer, a funding answer, or a chain answer. It is what happens
 * when a 4337 sender has no code and no `factory`/`factoryData` to deploy it:
 * validation fails before the paymaster is ever consulted, so the question the
 * script exists to ask never reached anybody.
 *
 * A counterfactual smart account carries its own deployment data, which is
 * exactly what makes it quotable while not existing. So build one — Kernel
 * v3.1 on EntryPoint 0.7, the same constants lib/onchain/account.ts uses — from
 * an ephemeral key generated here and never written down. It has never been
 * seen on chain, which is the point: if the project quotes for it, the project
 * quotes.
 */
const { createKernelAccount, createKernelAccountClient } = await import('@zerodev/sdk')
const { getEntryPoint, KERNEL_V3_1 } = await import('@zerodev/sdk/constants')
const { signerToEcdsaValidator } = await import('@zerodev/ecdsa-validator')
const { createPublicClient, http } = await import('viem')
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const { base } = await import('viem/chains')

const rpcArg = process.argv.indexOf('--rpc')
const publicRpc = rpcArg > -1 ? process.argv[rpcArg + 1] : 'https://mainnet.base.org'

let quoted = false
try {
  const pub = createPublicClient({ chain: base, transport: http(publicRpc) })
  const ep = getEntryPoint('0.7')

  // Ephemeral and in-memory only. Nothing signs with it but this simulation,
  // and it is gone when the process exits.
  const signer = privateKeyToAccount(SENDER_KEY ?? generatePrivateKey())
  const validator = await signerToEcdsaValidator(pub, { signer, entryPoint: ep, kernelVersion: KERNEL_V3_1 })
  const account = await createKernelAccount(pub, {
    entryPoint: ep,
    kernelVersion: KERNEL_V3_1,
    plugins: { sudo: validator },
  })
  console.log(`kernel account   : ${account.address} (counterfactual, never deployed)`)

  const { createZeroDevPaymasterClient } = await import('@zerodev/sdk')
  const paymasterClient = createZeroDevPaymasterClient({ chain: base, transport: http(RPC) })

  // Build the operation WITHOUT a paymaster, then ask the paymaster about it
  // explicitly.
  //
  // Going through the client's own middleware returned a gas estimate with no
  // paymaster fields and a maxFeePerGas of zero — an answer that reads like a
  // refusal and is not one, because the middleware simply had not run. The
  // paymaster's own method cannot be ambiguous that way: it either returns
  // sponsorship data or it says why not.
  const kernelClient = createKernelAccountClient({
    account,
    chain: base,
    bundlerTransport: http(RPC),
    client: pub,
  })
  const op = await kernelClient.prepareUserOperation({
    calls: [{ to: account.address, value: 0n, data: '0x' }],
  })

  // Fees come from the chain when the bundler did not supply them. A paymaster
  // prices gas, so quoting against zero would price nothing.
  let { maxFeePerGas, maxPriorityFeePerGas } = op
  if (!maxFeePerGas || maxFeePerGas === 0n) {
    const fees = await pub.estimateFeesPerGas()
    maxFeePerGas = fees.maxFeePerGas
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas
  }

  const total =
    BigInt(op.callGasLimit ?? 0n) + BigInt(op.verificationGasLimit ?? 0n) + BigInt(op.preVerificationGas ?? 0n)
  console.log(`gas estimated    : ${total} (incl. first-time account deployment)`)
  console.log(`maxFeePerGas     : ${Number(maxFeePerGas) / 1e9} gwei`)
  console.log(`cost if unpaid   : ${(Number(total * maxFeePerGas) / 1e18).toFixed(9)} ETH`)

  const sponsorship = await paymasterClient.getPaymasterData({
    ...op,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: base.id,
    entryPointAddress: ep.address,
    context: {},
  })
  const pm = sponsorship?.paymaster ?? sponsorship?.paymasterAndData
  console.log(`\npaymaster        : ${pm ? String(pm) : '(none returned)'}`)
  if (sponsorship?.paymasterData) {
    console.log(`paymasterData    : ${String(sponsorship.paymasterData).slice(0, 26)}… (${(String(sponsorship.paymasterData).length - 2) / 2} bytes)`)
  }
  quoted = Boolean(pm)
} catch (error) {
  console.log(`\nquote refused    : ${redact(error.shortMessage ?? error.message ?? String(error))}`)
  const detail = redact(String(error.details ?? error.cause?.message ?? ''))
  if (detail && detail !== 'undefined') console.log(`detail           : ${detail}`)
}

console.log('')
if (quoted) {
  console.log('PASS — the project quotes sponsorship on this chain. The remaining unknown is')
  console.log('whether the balance covers real operations, which only spending some answers.')
} else {
  console.log('The paymaster did not quote. Read the errors above rather than assuming a cause —')
  console.log('they distinguish the cases that look alike:')
  console.log('')
  console.log('  "not allowed" / "policy" / "sender"  → the allowlist is doing its job, against a')
  console.log('                                          kernel address it has never seen. Re-run with')
  console.log('                                          --owner-key <key> to quote a known one.')
  console.log('  "AA20 account not deployed"          → a bug in THIS script, not your config: the')
  console.log('                                          sender carried no factory data.')
  console.log('  "(none returned)" with no error      → the paymaster answered and declined to')
  console.log('                                          sponsor. Check the project policy: a')
  console.log('                                          per-UserOp ceiling below the quoted cost')
  console.log('                                          above declines exactly like this.')
  console.log('  "insufficient" / "balance" / "funds" → the grant is not spendable on this chain.')
  console.log('  "unsupported method"                 → paymaster not enabled on the project.')
  console.log('  "chain"                              → the project is not configured for this chain.')
  process.exitCode = 1
}
