/**
 * Which paymaster sponsors, and the fact that it does not have to be ZeroDev's.
 *
 * The bundler and the paymaster are separate services that happened to arrive
 * behind one URL. `ZERODEV_RPC` is both, so when sponsorship stopped working the
 * apparent choice was to keep the account abstraction stack or lose gas
 * sponsorship — and those are not actually coupled. Paymaster communication is
 * ERC-7677 (`pm_getPaymasterStubData` / `pm_getPaymasterData`), viem ships a
 * generic client for it, and a Kernel account does not care who signs the
 * sponsorship.
 *
 * So the account stays Kernel v3.1, the bundler stays whatever `ZERODEV_RPC`
 * points at, and the paymaster becomes one env var. On Base the obvious
 * alternative is CDP's, which is on the same chain as the market.
 *
 * ## Order, and why it is this way round
 *
 * `PAYMASTER_DISABLED` wins over everything: it is the operator saying there is
 * no sponsorship, and a URL left in the environment must not quietly override
 * that. Then `PAYMASTER_RPC`, because configuring one explicitly is a deliberate
 * act. Then `ZERODEV_RPC`, which is where sponsorship lived before this file
 * existed and must keep working untouched for the testnet deployment.
 *
 * Nothing here validates the endpoint. `scripts/check-sponsorship.mjs` resolves
 * the same three variables in the same order and then asks it to sponsor
 * something, which is the only check that means anything — the lesson of a day
 * spent watching a paymaster that was configured, funded, and refusing.
 */

import { http } from 'viem'
import { createPaymasterClient } from 'viem/account-abstraction'
import { createZeroDevPaymasterClient } from '@zerodev/sdk'
import { CHAIN, onchainEnv } from './config'
import { PAYMASTER_DISABLED } from '@/lib/gas-budget'

export type PaymasterChoice =
  | { kind: 'none'; why: string }
  | { kind: 'erc7677'; url: string }
  | { kind: 'zerodev'; url: string }

/** Which paymaster this deployment would use, without building anything. */
export function resolvePaymaster(): PaymasterChoice {
  if (PAYMASTER_DISABLED) {
    return { kind: 'none', why: 'PAYMASTER_DISABLED=true — every account pays its own gas' }
  }
  const explicit = process.env.PAYMASTER_RPC?.trim()
  if (explicit) return { kind: 'erc7677', url: explicit }
  // Only ZeroDev's own URL falls back to ZeroDev's client. A BUNDLER_RPC set to
  // some other provider is a bundler; assuming it also sponsors would send
  // ZeroDev-shaped requests to whoever answers.
  if (process.env.ZERODEV_RPC) return { kind: 'zerodev', url: process.env.ZERODEV_RPC }
  return { kind: 'none', why: 'neither PAYMASTER_RPC nor ZERODEV_RPC is set' }
}

/**
 * The client to hand `createKernelAccountClient`, or null for unsponsored.
 *
 * ZeroDev's client is kept for its own endpoint rather than routed through the
 * generic one. It speaks ERC-7677 too, but it also carries the SDK's own
 * handling of that service, and swapping a working path for a more uniform one
 * is how a testnet that worked this morning stops working this afternoon.
 */
export function paymasterClient() {
  const choice = resolvePaymaster()
  if (choice.kind === 'none') return null
  if (choice.kind === 'zerodev') {
    return createZeroDevPaymasterClient({ chain: CHAIN, transport: http(choice.url) })
  }
  return createPaymasterClient({ transport: http(choice.url) })
}

/** Safe to publish: names the kind, never the URL, which carries an API key. */
export function paymasterLabel(): string {
  const choice = resolvePaymaster()
  return choice.kind === 'none' ? `none (${choice.why})` : choice.kind
}
