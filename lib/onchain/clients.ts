import { createPublicClient, createWalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAIN, onchainEnv } from './config'
import { chainTransport } from './transport'

/** Read-only client for the configured chain (see config.CHAIN). */
export function publicClient() {
  return createPublicClient({ chain: CHAIN, transport: chainTransport() })
}

/** The oracle account — a plain EOA that publishes credit limits, writes
 *  EAS attestations, and (in EOA agent-account mode) tops up agent gas.
 *  Must be funded with the chain's native ETH. */
export function oracleAccount() {
  const pk = onchainEnv.oraclePrivateKey
  return privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`)
}

/** Wallet client that signs/sends as the oracle. */
export function oracleWallet() {
  return createWalletClient({
    account: oracleAccount(),
    chain: CHAIN,
    transport: chainTransport(),
  })
}
