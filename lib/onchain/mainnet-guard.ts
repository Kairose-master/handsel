/**
 * The prerequisites for real money, as code rather than as a checklist.
 *
 * `docs/v2-plan.md` names what has to be true before this system touches a
 * chain where losing funds means losing funds. A document nobody re-reads on
 * deploy day is a document that gets skipped, so the same conditions live here
 * as a function the money paths call.
 *
 * Two design choices worth stating:
 *
 * **It refuses rather than warns.** A warning on a money path is a warning
 * that gets scrolled past. Every blocker below stops the operation.
 *
 * **It fails toward "this is real money".** An unrecognised chain counts as
 * real (see IS_REAL_MONEY), and a missing acknowledgement counts as
 * unacknowledged. Being wrong in that direction costs an operator two minutes
 * of confusion; being wrong the other way costs somebody's funds.
 *
 * Pure and unit-tested: it takes the config as an argument rather than reading
 * the environment, so the interesting cases can be exercised without a chain.
 */

export type BlockerCode =
  | 'escrow-token-unset'
  | 'paymaster-unmetered'
  | 'faucet-enabled'
  | 'labor-market-unset'
  | 'mint-not-available'
  | 'token-decimals-mismatch'

export type Blocker = { code: BlockerCode; detail: string }

export type RealMoneyConfig = {
  isRealMoney: boolean
  escrowTokenAddress: string
  laborMarketAddress: string
  paymasterMeteredAck: boolean
  faucetEnabled: boolean
}

/**
 * Everything standing between this configuration and being allowed to move
 * real money. Empty means nothing is.
 *
 * On a testnet this is always empty: the whole point of a testnet is that
 * these mistakes are free there, and gating test deployments behind mainnet
 * ceremony would only teach people to set the acknowledgements reflexively.
 */
export function realMoneyBlockers(config: RealMoneyConfig): Blocker[] {
  if (!config.isRealMoney) return []

  const blockers: Blocker[] = []

  if (!config.escrowTokenAddress) {
    blockers.push({
      code: 'escrow-token-unset',
      detail:
        'USDC_ADDRESS is not set. There is no default on purpose: a wrong token address on a mainnet is unrecoverable, ' +
        'so this must be pasted in deliberately after checking it against the issuer.',
    })
  }

  if (!config.laborMarketAddress) {
    blockers.push({
      code: 'labor-market-unset',
      detail: 'LABOR_MARKET_ADDRESS is not set, so there is no escrow contract to settle against.',
    })
  }

  if (!config.paymasterMeteredAck) {
    blockers.push({
      code: 'paymaster-unmetered',
      detail:
        'PAYMASTER_METERED is not "true". Sponsored gas on a real chain is the operator\'s money, spendable by anyone ' +
        'who can cause a UserOperation — and causing one is free. Set a spending policy on the ZeroDev project first, ' +
        'then set this to acknowledge it. Nothing here can verify the policy for you.',
    })
  }

  if (config.faucetEnabled) {
    blockers.push({
      code: 'faucet-enabled',
      detail:
        'The job faucet posts practice work. Running it where the bounties are real spends real money on jobs nobody ' +
        'asked for, and fills the board with exactly the demand that should not be counted.',
    })
  }

  return blockers
}

/**
 * Does the configured token scale the way every amount in this system assumes?
 *
 * `USDC_DECIMALS` is a compile-time constant and every bounty, cap, fee and
 * balance is scaled by it. Point the app at a token with different decimals and
 * nothing errors — a $5 bounty simply escrows $5,000,000 or $0.000005, and the
 * first symptom is a settlement. USDC is 6 everywhere it matters, so this
 * should never fire; that is exactly why it has to be checked rather than
 * assumed.
 *
 * Pass the value read from the token's `decimals()`. Null means the read
 * failed, which is not treated as a mismatch — an RPC blip must not stop a
 * working market (the same "unknown is not empty" rule as lib/onchain/labor-read.ts).
 */
export function decimalsBlocker(onChainDecimals: number | null, expected: number): Blocker | null {
  if (onChainDecimals === null) return null
  if (onChainDecimals === expected) return null
  return {
    code: 'token-decimals-mismatch',
    detail:
      `The configured escrow token reports ${onChainDecimals} decimals but every amount in this system is scaled by ` +
      `${expected}. Nothing would error — bounties would simply be wrong by a factor of 10^${Math.abs(onChainDecimals - expected)}, ` +
      'and the first symptom would be a settlement. Check that the address is the token you meant.',
  }
}

/** One-line summary for a log or a diagnostics page. */
export function formatBlockers(blockers: readonly Blocker[]): string {
  if (blockers.length === 0) return 'no blockers'
  return blockers.map((b) => b.code).join(', ')
}

/**
 * Whether test-token minting is available. Real chains have no faucet for
 * their own currency — the call would revert, but only after a sponsored
 * UserOperation has already been paid for, so it is refused before it is sent.
 */
export function mintBlocker(isRealMoney: boolean): Blocker | null {
  if (!isRealMoney) return null
  return {
    code: 'mint-not-available',
    detail:
      'Minting the escrow token is a testnet convenience. On a real chain the token is issued by someone else and has ' +
      'to be bought or bridged; sending the transaction anyway would revert after the gas had already been spent.',
  }
}
