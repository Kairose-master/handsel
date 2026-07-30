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

/**
 * The same three variables in the same order as lib/onchain/paymaster.ts.
 *
 * A preflight that resolves its target differently from the app is a preflight
 * that green-lights something the app will not do. The bundler and the paymaster
 * are separate here because they are separate services — they were only ever
 * coupled by sharing ZeroDev's URL.
 */
const BUNDLER = process.env.BUNDLER_RPC?.trim() || process.env.ZERODEV_RPC
if (!BUNDLER) {
  console.error('BUNDLER_RPC (or the legacy ZERODEV_RPC) is required — bundling is needed even when')
  console.error('another service is the paymaster, and CDP serves both from one url.')
  process.exit(1)
}
const PAYMASTER = process.env.PAYMASTER_DISABLED === 'true' ? null : (process.env.PAYMASTER_RPC?.trim() || BUNDLER)
const PAYMASTER_KIND =
  PAYMASTER === null
    ? 'none (PAYMASTER_DISABLED)'
    : process.env.PAYMASTER_RPC?.trim()
      ? 'erc7677'
      : process.env.ZERODEV_RPC
        ? 'zerodev'
        : 'erc7677'
// Kept for the redactor and the raw chain/entrypoint probes below.
const RPC = BUNDLER

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
const redact = (s) => {
  let out = String(s).replaceAll(BUNDLER, '<BUNDLER_RPC>')
  if (PAYMASTER && PAYMASTER !== BUNDLER) out = out.replaceAll(PAYMASTER, '<PAYMASTER_RPC>')
  return out
}

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
  const { createPaymasterClient } = await import('viem/account-abstraction')
  console.log(`paymaster        : ${PAYMASTER_KIND}`)
  const makePaymaster = () =>
    PAYMASTER === null
      ? undefined
      : PAYMASTER_KIND === 'erc7677'
        ? createPaymasterClient({ transport: http(PAYMASTER) })
        : createZeroDevPaymasterClient({ chain: base, transport: http(PAYMASTER) })

  /**
   * The same operation, prepared twice: once with a paymaster and once without.
   *
   * Four attempts to read sponsorship out of a single response failed, each in a
   * way that looked like an answer and was not — a made-up sender got `AA20`
   * from the EntryPoint, a paymaster-less client got `AA21 didn't pay prefund`
   * from the bundler, a paymaster-ful one returned no fields at all because the
   * middleware had not run, and calling the paymaster's RPC directly kept
   * failing on the shape of the request. Every time, some layer answered instead
   * of the one being asked.
   *
   * The difference between the runs was the evidence all along. This account
   * holds no ether, so an UNSPONSORED operation cannot pass validation: nobody
   * can pay the EntryPoint's prefund, which is exactly what `AA21` says. If the
   * same operation passes when a paymaster is attached, something covered that
   * prefund. That is not an inference about a field — it is the bundler
   * simulating the whole operation and accepting it.
   *
   * It is also a stronger test than reading `paymaster` off a response, because
   * a paymaster can return data and still be rejected downstream. This asks the
   * question end to end.
   */
  /**
   * The fees are forced to a real number, and that is the whole test.
   *
   * With `maxFeePerGas` left at zero the required prefund is also zero, so an
   * account holding nothing satisfies it and BOTH runs pass — which is what
   * happened, and it proved nothing in a way that looked like it had. The
   * discriminator only exists when the operation actually costs something.
   */
  const fees = await pub.estimateFeesPerGas()
  console.log(`maxFeePerGas     : ${Number(fees.maxFeePerGas) / 1e9} gwei (forced; a zero fee needs no prefund)`)

  const prepare = (paymaster) =>
    createKernelAccountClient({
      account,
      chain: base,
      bundlerTransport: http(RPC),
      client: pub,
      ...(paymaster && makePaymaster() ? { paymaster: makePaymaster() } : {}),
    }).prepareUserOperation({
      calls: [{ to: account.address, value: 0n, data: '0x' }],
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      // Supplied, so viem skips estimation and the paymaster is asked about an
      // operation with real limits.
      //
      // This is the last thing in the request that never changed. Funding the
      // deposit did not move the error; saving a policy did not move the error;
      // the chain, EntryPoint, gas price and request count were all verified
      // correct and the bytes came back identical every time. An error that does
      // not respond to its supposed causes is not measuring them — and the three
      // zeros below were the only constant left, because viem asks for the
      // paymaster stub BEFORE it estimates gas, so at that moment there is
      // nothing else to send.
      callGasLimit: 200_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 100_000n,
    })

  /**
   * Everything the error carries, not just its headline.
   *
   * viem's `shortMessage` for a rejected RPC call is "RPC Request failed." — a
   * true sentence containing none of the answer. The reason the paymaster gave
   * lives in `details`, or in the cause chain below it, and printing only the
   * headline turned a specific refusal into another blank.
   */
  const explain = (error) => {
    const parts = []
    const push = (v) => {
      const t = v == null ? '' : String(v).trim()
      if (t && t !== 'undefined' && !parts.includes(t)) parts.push(t)
    }
    push(error.shortMessage ?? error.message)
    push(error.details)
    if (Array.isArray(error.metaMessages)) error.metaMessages.forEach(push)
    let cause = error.cause
    for (let depth = 0; cause && depth < 5; depth++) {
      push(cause.shortMessage ?? cause.message)
      push(cause.details)
      cause = cause.cause
    }
    return redact(parts.join('\n                   '))
  }

  const attempt = async (paymaster) => {
    try {
      return { ok: true, op: await prepare(paymaster) }
    } catch (error) {
      return { ok: false, why: explain(error) }
    }
  }

  const [sponsored, unsponsored] = await Promise.all([attempt(true), attempt(false)])

  console.log(`\nwith paymaster   : ${sponsored.ok ? 'simulation PASSED' : `refused — ${sponsored.why}`}`)
  console.log(`without paymaster: ${unsponsored.ok ? 'simulation passed' : `refused — ${unsponsored.why}`}`)

  if (sponsored.ok) {
    const g =
      BigInt(sponsored.op.callGasLimit ?? 0n) +
      BigInt(sponsored.op.verificationGasLimit ?? 0n) +
      BigInt(sponsored.op.preVerificationGas ?? 0n)
    console.log(`gas accepted     : ${g} (incl. first-time account deployment)`)
    const pm = sponsored.op.paymaster ?? sponsored.op.paymasterAndData
    if (pm) console.log(`paymaster        : ${String(pm)}`)
  }

  const prefundRefused = !unsponsored.ok && /AA21|prefund/i.test(unsponsored.why)
  if (sponsored.ok && prefundRefused) {
    console.log('')
    console.log('An operation from an account holding no ether passed validation WITH the')
    console.log('paymaster and was refused for prefund WITHOUT it. Something paid. That is')
    console.log('sponsorship, demonstrated rather than reported.')
    quoted = true
  } else if (sponsored.ok && unsponsored.ok) {
    const bal = await pub.getBalance({ address: account.address })
    console.log('')
    console.log(`Both passed, and the account holds ${Number(bal) / 1e18} ETH.`)
    if (bal === 0n) {
      console.log('An account with nothing cannot pay a prefund, so this bundler is not enforcing')
      console.log('one at estimation time. The A/B cannot discriminate here — not a failure of the')
      console.log('project, a limit of this test. The sponsored run DID pass, which is the weaker')
      console.log('half of the same evidence; the remaining question is settled by the first real')
      console.log('operation, and the deploy that gets you there costs cents.')
    }
  }
  const pm = null
  void pm
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
  console.log('Sponsorship was NOT demonstrated. What the two runs mean together:')
  console.log('')
  console.log('  both refused, same reason           → the project or the URL, not the paymaster.')
  console.log('                                        A bad project id fails both identically.')
  console.log('  with-paymaster refused, "policy" /  → the allowlist is doing its job, against a')
  console.log('  "sender" / "not allowed"              kernel address it has never seen. Re-run')
  console.log('                                        with --owner-key <key> for a known one.')
  console.log('  with-paymaster refused, "AA21"      → read getDepositInfo(pm) on the EntryPoint,')
  console.log('                                        because AA21 means two different things:')
  console.log('')
  console.log('     deposit is 0   → nothing can be paid. A balance in a dashboard is an')
  console.log('                      accounting entry; the deposit is the money.')
  console.log('     deposit is > 0 → THE PAYMASTER WAS NOT ATTACHED. EntryPoint v0.7 charges')
  console.log('                      the ACCOUNT for prefund only when paymasterAndData is')
  console.log('                      empty, so with a paymaster attached this error cannot')
  console.log('                      occur. Getting it anyway means the provider declined and')
  console.log('                      expressed the decline as a downstream simulation failure.')
  console.log('                      That is a POLICY answer wearing a funding answer\'s clothes:')
  console.log('                      no active gas policy, or one this call does not match.')
  console.log('  "payment method not found"          → the plan\'s monthly figure is a LIMIT, not a')
  console.log('                                        credit. Nothing is sponsored until a payment')
  console.log('                                        method sits behind it. Everything else about')
  console.log('                                        the request was accepted to reach this — chain,')
  console.log('                                        EntryPoint, sender and allowlist all passed.')
  console.log('  with-paymaster refused, "balance" / → the grant is not spendable on this chain.')
  console.log('  "insufficient" / "funds"')
  console.log('  with-paymaster refused, cost-shaped → the per-UserOp ceiling is below what this')
  console.log('                                        operation costs. First-time deployment is')
  console.log('                                        the most expensive op an agent ever sends.')
  console.log('  both PASSED                         → inconclusive, not a failure. See above.')
  process.exitCode = 1
}
