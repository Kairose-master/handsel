/**
 * Read — and if asked, empty — an agent's EOA.
 *
 * Agent addresses are ordinary EOAs derived deterministically from the owner
 * key, so they can receive ANYTHING: ETH, USDC, a token nobody meant to send.
 * The app's only withdrawal path is `transferUsdc`, which means everything else
 * that lands there is invisible to the product and unreachable through it.
 *
 * Not lost, though — and that is the whole point of the derivation:
 *
 *     agentKey = keccak256(ownerKey ++ toHex(agentId))
 *
 * Whoever holds AGENT_OWNER_PRIVATE_KEY can reconstruct any agent's private key
 * and move anything out. This script is that, written down, so recovering a
 * mistaken deposit is a command rather than an afternoon.
 *
 * Contrast the MARKET contract, where the answer is the opposite: it has no
 * `receive`, no `fallback` and no `payable` function, so plain ETH sent to it
 * REVERTS — you cannot lose ether to it by accident. A stray ERC-20 sent there
 * is a different story: it lands in `escrowSolvency().surplus` and stays, on
 * purpose, because a function that moves tokens the contract does not owe is a
 * function that can move tokens it does.
 *
 * Usage — reads only, unless a --send flag is given:
 *
 *   AGENT_OWNER_PRIVATE_KEY=0x… ONCHAIN_RPC_URL=… ONCHAIN_CHAIN=base-sepolia \
 *   node scripts/recover-agent-funds.mjs <agentId>
 *
 *   … --send-eth  0xDEST   sweep ETH, minus the gas the sweep itself costs
 *   … --send-usdc 0xDEST   sweep the whole USDC balance
 */
import { createPublicClient, createWalletClient, http, keccak256, concat, toHex, formatEther, formatUnits, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, sepolia } from 'viem/chains'

const die = (m) => {
  console.error(`\n✖ ${m}\n`)
  process.exit(1)
}

const agentId = process.argv[2]
if (!agentId || agentId.startsWith('--')) die('Usage: node scripts/recover-agent-funds.mjs <agentId> [--send-eth 0x…] [--send-usdc 0x…]')

const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}
const sendEthTo = flag('--send-eth')
const sendUsdcTo = flag('--send-usdc')

const CHAINS = { sepolia, 'base-sepolia': baseSepolia, base }
const chainName = process.env.ONCHAIN_CHAIN ?? 'base-sepolia'
const chain = CHAINS[chainName]
if (!chain) die(`ONCHAIN_CHAIN="${chainName}" unknown. One of: ${Object.keys(CHAINS).join(', ')}`)

const rpcUrl = process.env.ONCHAIN_RPC_URL
const ownerRaw = process.env.AGENT_OWNER_PRIVATE_KEY
if (!rpcUrl) die('Set ONCHAIN_RPC_URL.')
if (!ownerRaw) die('Set AGENT_OWNER_PRIVATE_KEY — the key every agent address is derived from.')
const ownerKey = ownerRaw.startsWith('0x') ? ownerRaw : `0x${ownerRaw}`

// EXACTLY the derivation in lib/onchain/account.ts. If these ever drift, this
// script quietly reports the balances of an address nobody is using — which is
// worse than failing, because it reads as "your money is gone".
const agentKey = keccak256(concat([ownerKey, toHex(agentId)]))
const account = privateKeyToAccount(agentKey)

const pub = createPublicClient({ chain, transport: http(rpcUrl) })
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]

console.log(`\nChain    ${chain.name} (${chain.id})`)
console.log(`Agent    ${agentId}`)
console.log(`Address  ${account.address}`)

const eth = await pub.getBalance({ address: account.address })
console.log(`\nETH      ${formatEther(eth)}`)

const usdcAddress = process.env.USDC_ADDRESS ?? process.env.MOCK_USDC_ADDRESS
let usdc = 0n
if (usdcAddress) {
  usdc = await pub.readContract({ address: usdcAddress, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
  console.log(`USDC     ${formatUnits(usdc, 6)}  (${usdcAddress})`)
} else {
  console.log('USDC     — set USDC_ADDRESS to read it')
}

if (!sendEthTo && !sendUsdcTo) {
  console.log('\nRead-only. Pass --send-eth 0x… or --send-usdc 0x… to move funds.')
  process.exit(0)
}

if (chain.testnet !== true) {
  console.log(`\n⚠ ${chain.name} is REAL MONEY.`)
}

if (sendUsdcTo) {
  if (!usdcAddress) die('USDC_ADDRESS is not set, so there is no token to send.')
  if (usdc === 0n) die('USDC balance is zero — nothing to send.')
  console.log(`\nSending ${formatUnits(usdc, 6)} USDC → ${sendUsdcTo}`)
  const hash = await wallet.sendTransaction({
    to: usdcAddress,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [sendUsdcTo, usdc] }),
  })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`  tx: ${hash}`)
}

if (sendEthTo) {
  // Leave nothing behind, but the sweep has to pay for itself: send
  // balance − (gas × price), with headroom so a price tick between the estimate
  // and the send does not make the transaction unaffordable and revert.
  const remaining = await pub.getBalance({ address: account.address })
  const gasPrice = await pub.getGasPrice()
  const cost = 21_000n * gasPrice * 2n
  if (remaining <= cost) die(`ETH balance ${formatEther(remaining)} does not cover the ~${formatEther(cost)} this sweep costs.`)
  const value = remaining - cost
  console.log(`\nSending ${formatEther(value)} ETH → ${sendEthTo}  (leaving ~${formatEther(cost)} for gas)`)
  const hash = await wallet.sendTransaction({ to: sendEthTo, value })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`  tx: ${hash}`)
}

console.log('\nDone.')
