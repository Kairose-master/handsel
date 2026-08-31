/**
 * On-chain half of the GIWA MiniVault engine. The pure math lives in
 * lib/mini-vault.ts; this module deploys/talks to contracts/MiniVault.sol
 * (same parameters, so every chain read can be cross-checked against the
 * unit-tested TS engine).
 *
 * The deployer/oracle is the platform oracle wallet — already funded for EAS
 * writes. The deployed address is stored in platform_secrets
 * ('minivault_address') so no env change or redeploy is needed to adopt it.
 */
import { createWalletClient, formatEther, parseEther, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { MINIVAULT_ABI, MINIVAULT_BYTECODE } from './minivault-artifact'
import { CHAIN } from './config'
import { chainTransport } from './transport'
import { oracleWallet, publicClient } from './clients'
import { getPlatformSecret, setPlatformSecret } from '@/lib/platform-secret'

const ADDRESS_KEY = 'minivault_address'
const WAD = 10n ** 18n

export async function miniVaultAddress(): Promise<Address | null> {
  const stored = (await getPlatformSecret(ADDRESS_KEY)) || process.env.MINIVAULT_ADDRESS || null
  return stored && /^0x[0-9a-fA-F]{40}$/.test(stored) ? (stored as Address) : null
}

/** Deploy MiniVault with an initial mock price (USD/ETH, human units) and
 *  persist the address. Idempotent-ish: refuses if one is already stored
 *  unless `force`. */
export async function deployMiniVault(initialPriceUsd: number, force = false): Promise<{ address: Address; txHash: Hex }> {
  const existing = await miniVaultAddress()
  if (existing && !force) throw new Error(`MiniVault already deployed at ${existing} (pass force to redeploy)`)

  const wallet = oracleWallet()
  const txHash = await wallet.deployContract({
    abi: MINIVAULT_ABI,
    bytecode: MINIVAULT_BYTECODE,
    args: [parseEther(String(initialPriceUsd))],
  })
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash })
  if (!receipt.contractAddress) throw new Error('deploy receipt has no contract address')
  await setPlatformSecret(ADDRESS_KEY, receipt.contractAddress)
  return { address: receipt.contractAddress, txHash }
}

/** Oracle Mock: push a new USD/ETH price (human units). */
export async function setMiniVaultPrice(priceUsd: number): Promise<Hex> {
  const address = await miniVaultAddress()
  if (!address) throw new Error('MiniVault not deployed')
  const wallet = oracleWallet()
  return wallet.writeContract({
    address,
    abi: MINIVAULT_ABI,
    functionName: 'setPrice',
    args: [parseEther(String(priceUsd))],
  })
}

export interface MiniVaultState {
  address: Address
  priceUsd: number
  totalSupplyGusd: number
}

export interface MiniVaultPosition {
  collateralEth: number
  debtGusd: number
  collateralValueUsd: number
  maxDebtUsd: number
  healthFactor: number | null // null = debt-free (∞)
  liquidatable: boolean
}

const toNum = (wei: bigint) => Number(formatEther(wei))

export async function readMiniVaultState(): Promise<MiniVaultState | null> {
  const address = await miniVaultAddress()
  if (!address) return null
  const client = publicClient()
  const [price, totalSupply] = await Promise.all([
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'price' }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'totalSupply' }),
  ])
  return { address, priceUsd: toNum(price as bigint), totalSupplyGusd: toNum(totalSupply as bigint) }
}

export async function readMiniVaultPosition(user: Address): Promise<MiniVaultPosition | null> {
  const address = await miniVaultAddress()
  if (!address) return null
  const client = publicClient()
  const [pos, value, maxDebt, hf, liq] = await Promise.all([
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'positions', args: [user] }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'collateralValueUsd', args: [user] }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'maxDebtUsd', args: [user] }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'healthFactor', args: [user] }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'isLiquidatable', args: [user] }),
  ])
  const [collateral, debt] = pos as [bigint, bigint]
  const hfWei = hf as bigint
  return {
    collateralEth: toNum(collateral),
    debtGusd: toNum(debt),
    collateralValueUsd: toNum(value as bigint),
    maxDebtUsd: toNum(maxDebt as bigint),
    healthFactor: debt === 0n ? null : Number(hfWei) / Number(WAD),
    liquidatable: liq as boolean,
  }
}

// ── two-party liquidation demo ──────────────────────────────────────────
// A REAL liquidation needs a second party: someone who holds gUSD, burns it
// against an unhealthy position, and walks away with bonus-priced ETH. We
// keep a dedicated demo-liquidator key server-side (platform_secrets), fund
// it from the oracle, and let it execute the actual liquidate() call.

const LIQUIDATOR_KEY = 'minivault_liquidator_pk'

async function liquidatorAccount() {
  let pk = await getPlatformSecret(LIQUIDATOR_KEY)
  if (!pk) {
    pk = generatePrivateKey()
    await setPlatformSecret(LIQUIDATOR_KEY, pk)
  }
  return privateKeyToAccount(pk as Hex)
}

function walletFor(account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account, chain: CHAIN, transport: chainTransport() })
}

/** Step 1 — prep: ensure the demo liquidator has gas ETH and gUSD to burn.
 *  Idempotent: skips whatever it already has. */
export async function prepLiquidator(): Promise<{ liquidator: Address; ethBalance: number; gusdBalance: number; txs: Hex[] }> {
  const address = await miniVaultAddress()
  if (!address) throw new Error('MiniVault not deployed')
  const liq = await liquidatorAccount()
  const client = publicClient()
  const oracle = oracleWallet()
  const txs: Hex[] = []

  const ethBal = await client.getBalance({ address: liq.address })
  if (ethBal < parseEther('0.002')) {
    const tx = await oracle.sendTransaction({ to: liq.address, value: parseEther('0.004') })
    await client.waitForTransactionReceipt({ hash: tx })
    txs.push(tx)
  }

  const gusd = (await client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'balanceOf', args: [liq.address] })) as bigint
  if (gusd < parseEther('1')) {
    const tx = await oracle.writeContract({ address, abi: MINIVAULT_ABI, functionName: 'transfer', args: [liq.address, parseEther('1')] })
    await client.waitForTransactionReceipt({ hash: tx })
    txs.push(tx)
  }

  const [ethAfter, gusdAfter] = await Promise.all([
    client.getBalance({ address: liq.address }),
    client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'balanceOf', args: [liq.address] }) as Promise<bigint>,
  ])
  return { liquidator: liq.address, ethBalance: toNum(ethAfter), gusdBalance: toNum(gusdAfter), txs }
}

/** Step 2 — run: crash the mock price until the oracle's position is under
 *  water, let the SECOND account execute liquidate(), then restore the
 *  price. Returns the full before/after story. */
export async function runLiquidationDemo(crashPriceUsd: number, restorePriceUsd: number): Promise<{
  liquidator: Address
  target: Address
  crashTx: Hex
  liquidateTx: Hex
  restoreTx: Hex
  repaidGusd: number
  seizedEth: number
  seizedValueUsd: number
  before: MiniVaultPosition | null
  after: MiniVaultPosition | null
}> {
  const address = await miniVaultAddress()
  if (!address) throw new Error('MiniVault not deployed')
  const liq = await liquidatorAccount()
  const client = publicClient()
  const oracle = oracleWallet()
  const target = oracle.account.address

  const before = await readMiniVaultPosition(target)

  const crashTx = await oracle.writeContract({ address, abi: MINIVAULT_ABI, functionName: 'setPrice', args: [parseEther(String(crashPriceUsd))] })
  await client.waitForTransactionReceipt({ hash: crashTx })

  const liquidatable = (await client.readContract({ address, abi: MINIVAULT_ABI, functionName: 'isLiquidatable', args: [target] })) as boolean
  if (!liquidatable) throw new Error(`position still healthy at $${crashPriceUsd} — crash lower`)

  const ethBefore = await client.getBalance({ address: liq.address })
  const liqWallet = walletFor(liq)
  const liquidateTx = await liqWallet.writeContract({ address, abi: MINIVAULT_ABI, functionName: 'liquidate', args: [target, parseEther('1')] })
  const receipt = await client.waitForTransactionReceipt({ hash: liquidateTx })
  const ethAfterLiq = await client.getBalance({ address: liq.address })
  const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice

  const restoreTx = await oracle.writeContract({ address, abi: MINIVAULT_ABI, functionName: 'setPrice', args: [parseEther(String(restorePriceUsd))] })
  await client.waitForTransactionReceipt({ hash: restoreTx })

  const after = await readMiniVaultPosition(target)
  const seizedWei = ethAfterLiq - ethBefore + gasPaid // net ETH in + gas it burned
  return {
    liquidator: liq.address,
    target,
    crashTx,
    liquidateTx,
    restoreTx,
    repaidGusd: 1,
    seizedEth: toNum(seizedWei),
    seizedValueUsd: toNum(seizedWei) * crashPriceUsd,
    before,
    after,
  }
}

/** Live walkthrough as the oracle account: deposit a sliver of ETH and mint
 *  half of the allowed debt — enough to light up every gauge on-chain. */
export async function demoDepositAndMint(depositEth: number): Promise<{ depositTx: Hex; mintTx: Hex; minted: number }> {
  const address = await miniVaultAddress()
  if (!address) throw new Error('MiniVault not deployed')
  const wallet = oracleWallet()
  const client = publicClient()

  const depositTx = await wallet.writeContract({
    address,
    abi: MINIVAULT_ABI,
    functionName: 'deposit',
    value: parseEther(String(depositEth)),
  })
  await client.waitForTransactionReceipt({ hash: depositTx })

  const maxDebt = (await client.readContract({
    address,
    abi: MINIVAULT_ABI,
    functionName: 'maxDebtUsd',
    args: [wallet.account.address],
  })) as bigint
  const pos = (await client.readContract({
    address,
    abi: MINIVAULT_ABI,
    functionName: 'positions',
    args: [wallet.account.address],
  })) as [bigint, bigint]
  const headroom = maxDebt - pos[1]
  const mintAmount = headroom / 2n
  if (mintAmount <= 0n) throw new Error('no mint headroom')

  const mintTx = await wallet.writeContract({
    address,
    abi: MINIVAULT_ABI,
    functionName: 'mint',
    args: [mintAmount],
  })
  await client.waitForTransactionReceipt({ hash: mintTx })
  return { depositTx, mintTx, minted: toNum(mintAmount) }
}
