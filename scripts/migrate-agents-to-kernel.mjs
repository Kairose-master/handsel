/**
 * Move agents from EOA mode to kernel (ERC-4337) mode without stranding money.
 *
 * The two modes derive DIFFERENT addresses for the same agent:
 *
 *   eoa     privateKeyToAccount(keccak256(ownerKey ++ toHex(agentId)))
 *   kernel  a counterfactual Kernel v3.1 address at index keccak256(agentId) % 2^48
 *
 * So setting ZERODEV_RPC does not migrate anything — it makes the app start
 * looking at a different address and stop looking at the one holding the money.
 * The funds are not lost (the owner key still derives the EOA), but nothing in
 * the product can reach them, which for a user is the same thing.
 *
 * This reads every agent from the database, derives both addresses, reports what
 * is at each, and on request sweeps EOA → that agent's own future kernel address.
 * Read-only unless --send is given.
 *
 * Usage:
 *   DATABASE_URL=… AGENT_OWNER_PRIVATE_KEY=… ONCHAIN_RPC_URL=… \
 *   ONCHAIN_CHAIN=base-sepolia USDC_ADDRESS=0x… \
 *   node scripts/migrate-agents-to-kernel.mjs                  # report only
 *   node scripts/migrate-agents-to-kernel.mjs --send           # → kernel addresses
 *   node scripts/migrate-agents-to-kernel.mjs --send --to 0xW  # → one wallet
 *
 * `--to` consolidates every agent's balance into a single address instead of its
 * own kernel account, and it is the better default when one key does several jobs.
 * On this deployment ONE key is the oracle, the arbiter, the fee recipient and the
 * agent owner, so everything derived from it shares one fate: rotate or lose it
 * and every agent EOA goes with it. Sweeping into a wallet whose key is held
 * independently — a hardware wallet, a separate MetaMask account — breaks that
 * coupling for the balance, which is the part that matters most. The cost is one
 * extra step: the kernel accounts then start empty and have to be funded
 * deliberately, which is arguably how it should have worked anyway.
 *
 * Run it BEFORE setting ZERODEV_RPC. Afterwards the app is in kernel mode and
 * `getAgentAccountAddress` no longer returns the address the money is at, so the
 * report below would be comparing the wrong pair.
 */
import pg from 'pg'
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  keccak256,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, sepolia } from 'viem/chains'
import { createKernelAccount } from '@zerodev/sdk'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'

const die = (m) => {
  console.error(`\n✖ ${m}\n`)
  process.exit(1)
}
const send = process.argv.includes('--send')
const toFlagIndex = process.argv.indexOf('--to')
const sweepTo = toFlagIndex === -1 ? null : process.argv[toFlagIndex + 1]
if (toFlagIndex !== -1 && !/^0x[0-9a-fA-F]{40}$/.test(sweepTo ?? '')) {
  die('--to needs a 20-byte address')
}

const CHAINS = { sepolia, 'base-sepolia': baseSepolia, base }
const chain = CHAINS[process.env.ONCHAIN_CHAIN ?? 'base-sepolia']
if (!chain) die(`ONCHAIN_CHAIN must be one of ${Object.keys(CHAINS).join(', ')}`)
const rpcUrl = process.env.ONCHAIN_RPC_URL || die('ONCHAIN_RPC_URL is required')
const ownerRaw = process.env.AGENT_OWNER_PRIVATE_KEY || die('AGENT_OWNER_PRIVATE_KEY is required')
const ownerKey = ownerRaw.startsWith('0x') ? ownerRaw : `0x${ownerRaw}`
const usdcAddress = process.env.USDC_ADDRESS || die('USDC_ADDRESS is required')
const databaseUrl = process.env.DATABASE_URL || die('DATABASE_URL is required')

// Identical to lib/onchain/account.ts. Any drift here produces a confidently
// wrong "future" address, which would send money somewhere nothing looks.
const entryPoint = getEntryPoint('0.7')
const kernelVersion = KERNEL_V3_1
const accountIndex = (agentId) => BigInt(keccak256(toHex(agentId))) % 2n ** 48n
const eoaFor = (agentId) => privateKeyToAccount(keccak256(concat([ownerKey, toHex(agentId)])))

const pub = createPublicClient({ chain, transport: http(rpcUrl) })
const ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]
const decimals = await pub.readContract({ address: usdcAddress, abi: ERC20, functionName: 'decimals' })
const usd = (v) => `${Number(formatUnits(v, decimals)).toFixed(3)}`

async function kernelAddressFor(agentId) {
  const ecdsaValidator = await signerToEcdsaValidator(pub, {
    signer: privateKeyToAccount(ownerKey),
    entryPoint,
    kernelVersion,
  })
  const account = await createKernelAccount(pub, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
    index: accountIndex(agentId),
  })
  return account.address
}

const pool = new pg.Pool({ connectionString: databaseUrl })
const { rows } = await pool.query(
  'SELECT id, name, "smartAccountAddress" FROM "agent" ORDER BY "createdAt" NULLS LAST, id',
)
await pool.end()
if (rows.length === 0) die('no agents in the database')

console.log(`chain ${chain.name} (${chain.id})   ${rows.length} agent(s)   mode ${send ? 'SWEEP' : 'report only'}\n`)

let totalUsdc = 0n
const plan = []
for (const row of rows) {
  const eoa = eoaFor(row.id)
  const kernel = await kernelAddressFor(row.id)
  const [eUsdc, eEth, kUsdc] = await Promise.all([
    pub.readContract({ address: usdcAddress, abi: ERC20, functionName: 'balanceOf', args: [eoa.address] }),
    pub.getBalance({ address: eoa.address }),
    pub.readContract({ address: usdcAddress, abi: ERC20, functionName: 'balanceOf', args: [kernel] }),
  ])
  totalUsdc += eUsdc
  // The stored address tells you which mode the row was provisioned in, which is
  // the difference between "needs re-provisioning" and "already done".
  const storedIs =
    row.smartAccountAddress?.toLowerCase() === eoa.address.toLowerCase()
      ? 'eoa'
      : row.smartAccountAddress?.toLowerCase() === kernel.toLowerCase()
        ? 'kernel'
        : row.smartAccountAddress
          ? 'NEITHER'
          : 'unset'
  console.log(`${row.name ?? row.id}  (${row.id})`)
  console.log(`  eoa     ${eoa.address}  ${usd(eUsdc)} USDC  ${Number(formatEther(eEth)).toFixed(6)} ETH`)
  console.log(`  kernel  ${kernel}  ${usd(kUsdc)} USDC`)
  console.log(`  stored  ${row.smartAccountAddress ?? '(none)'}  → ${storedIs}`)
  if (storedIs === 'NEITHER') {
    console.log('  ⚠ stored address matches neither derivation — a different owner key made it.')
  }
  plan.push({ row, eoa, kernel, eUsdc, eEth })
}

console.log(`\ntotal USDC sitting on agent EOAs: ${usd(totalUsdc)}`)

// The likeliest failure mode, stated instead of left to be inferred. A wrong
// owner key derives a whole set of addresses that have never existed, every
// balance reads 0, and nothing about that looks like "wrong key" — it looks like
// the money is gone.
const neither = plan.filter(
  (p) => p.row.smartAccountAddress && p.row.smartAccountAddress.toLowerCase() !== p.eoa.address.toLowerCase() && p.row.smartAccountAddress.toLowerCase() !== p.kernel.toLowerCase(),
)
if (neither.length === plan.length && plan.length > 0) {
  console.log(`
⚠ EVERY agent's stored address matches neither derivation. That means this
  AGENT_OWNER_PRIVATE_KEY is not the key those agents were provisioned with — the
  addresses above are empty because they have never existed, not because the money
  moved. Do not sweep; find the right key first. In a one-key deployment it is the
  same value as ORACLE_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY.`)
  process.exit(1)
}

if (!send) {
  console.log(`
Nothing was moved. Two ways to sweep:

  --send              each agent's USDC → its own future kernel account
  --send --to 0xWALLET   everything → one address you control

Prefer --to when a single key does several jobs, as it does here: one key is the
oracle, the arbiter, the fee recipient and the agent owner, so every agent EOA
shares that key's fate. Consolidating into an independently-held wallet breaks the
coupling for the balance. The kernel accounts then start empty and get funded
deliberately.

Either way, afterwards: set ZERODEV_RPC, redeploy, and press Provision on each
agent so the stored address becomes the kernel one.

ETH is deliberately NOT swept. In kernel mode the paymaster pays gas so an agent
EOA needs none, and leaving a little keeps the EOA able to move anything that
lands on it later — including a sweep like this one.`)
  process.exit(0)
}

for (const { row, eoa, kernel, eUsdc, eEth } of plan) {
  if (eUsdc === 0n) {
    console.log(`\n${row.name ?? row.id}: nothing to sweep`)
    continue
  }
  const dest = sweepTo ?? kernel
  // The agent pays for its own sweep, so it needs gas. Saying so beats a bare
  // "insufficient funds for gas" from the RPC, and it is checkable up front.
  if (eEth === 0n) {
    console.log(`\n${row.name ?? row.id}: holds ${usd(eUsdc)} USDC but 0 ETH — cannot pay for the sweep.`)
    console.log(`  Send a little ETH to ${eoa.address} and re-run.`)
    continue
  }
  const wallet = createWalletClient({ account: eoa, chain, transport: http(rpcUrl) })
  console.log(`\n${row.name ?? row.id}: sending ${usd(eUsdc)} USDC → ${dest}${sweepTo ? ' (--to)' : ' (its kernel account)'}`)
  const hash = await wallet.sendTransaction({
    to: usdcAddress,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [dest, eUsdc] }),
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`  ${receipt.status === 'success' ? '✅' : '❌'} ${hash}`)
}

console.log(`
Swept. Next:
  1. Set ZERODEV_RPC in Vercel, redeploy.
  2. Confirm /api/capabilities reports runtime.agentAccountMode "kernel" and
     bundlerConfigured true.
  3. Press Provision on each agent — provisionSmartAccount overwrites the stored
     address unconditionally, so this is what points the app at the kernel account.
  4. Re-run this script (no --send) — every agent should read stored → kernel.${
    sweepTo
      ? `
  5. Fund the kernel accounts. The balances went to ${sweepTo}, so the agents are
     empty: a requester with no USDC cannot escrow a bounty and a worker with none
     cannot post a bond. The addresses to send to are the "kernel" lines above.`
      : ''
  }`)
