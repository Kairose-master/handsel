#!/usr/bin/env node
/**
 * Deploy ProofAnchor from the COMMITTED artifact (lib/onchain/proof-anchor-artifact.ts)
 * and print the address to set as PROOF_ANCHOR_ADDRESS.
 *
 * The anchorer is the attestation oracle — the same key that signs work
 * proofs (ORACLE_PRIVATE_KEY) — because the ops step that anchors runs as it.
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY   funded key that pays the deploy gas
 *   ORACLE_PRIVATE_KEY     the attestation oracle; its ADDRESS becomes the anchorer
 *   ONCHAIN_RPC_URL        RPC endpoint
 *   ONCHAIN_CHAIN          'base-sepolia' (default) | 'base'
 *
 * Run:  node scripts/deploy-proof-anchor.mjs
 * Then: set PROOF_ANCHOR_ADDRESS in the platform env. Anchoring is OFF until
 *       that variable is set; the `proofAnchors` ops step reads 'idle'.
 */
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { PROOF_ANCHOR_ABI, PROOF_ANCHOR_BYTECODE } from '../lib/onchain/proof-anchor-artifact.ts'

const pk = process.env.DEPLOYER_PRIVATE_KEY
const oraclePk = process.env.ORACLE_PRIVATE_KEY
const rpc = process.env.ONCHAIN_RPC_URL
if (!pk || !oraclePk || !rpc) {
  console.error('Set DEPLOYER_PRIVATE_KEY, ORACLE_PRIVATE_KEY and ONCHAIN_RPC_URL')
  process.exit(1)
}
const chain = (process.env.ONCHAIN_CHAIN ?? 'base-sepolia') === 'base' ? base : baseSepolia
if (chain.id === base.id && process.env.I_UNDERSTAND_THIS_IS_MAINNET !== 'yes') {
  console.error('Refusing a mainnet deploy without I_UNDERSTAND_THIS_IS_MAINNET=yes')
  process.exit(1)
}
const norm = (k) => (k.startsWith('0x') ? k : `0x${k}`)
const deployer = privateKeyToAccount(norm(pk))
const anchorer = privateKeyToAccount(norm(oraclePk)).address
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) })
const client = createPublicClient({ chain, transport: http(rpc) })

console.log(`Deploying ProofAnchor to ${chain.name} from ${deployer.address}; anchorer = ${anchorer}`)
const hash = await wallet.deployContract({ abi: PROOF_ANCHOR_ABI, bytecode: PROOF_ANCHOR_BYTECODE, args: [anchorer] })
const receipt = await client.waitForTransactionReceipt({ hash })
console.log(`\nPROOF_ANCHOR_ADDRESS=${receipt.contractAddress}`)
console.log(`tx ${hash}\nVerify on Basescan with contracts/ProofAnchor.sol, solc 0.8.24, optimizer 200 runs, constructor arg ${anchorer}.`)
