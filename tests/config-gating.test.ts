import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A feature must be gated on what IT needs, and nothing else.
 *
 * `isLaborMarketConfigured()` called `isAgentAccountConfigured()`, which called
 * `isOnchainConfigured()`, which requires `CREDIT_VAULT_ADDRESS`. So a labour
 * market that was deployed, funded and correct reported itself unconfigured
 * because an unrelated contract had not been deployed.
 *
 * The symptom was `GET /api/tasks` answering `503 unconfigured` with the market
 * address sitting in the env — and note that the 503 was the HONEST answer to a
 * wrong question. The three-valued feed did its job; the predicate underneath
 * was asking about the vault.
 *
 * The vault appears in `lib/onchain/credit.ts` and nowhere else. Borrow and
 * repay need it. Posting a job does not.
 *
 * These are source assertions because the predicates read `process.env` at
 * module load, so importing them under a fixed environment is the one thing a
 * unit test cannot do cleanly here.
 */

const config = readFileSync('lib/onchain/config.ts', 'utf8')

/** The body of a named exported function in config.ts. */
function body(fn: string): string {
  const start = config.indexOf(`export function ${fn}(`)
  if (start === -1) throw new Error(`${fn} not found in config.ts`)
  const open = config.indexOf('{', start)
  let depth = 0
  for (let i = open; i < config.length; i++) {
    if (config[i] === '{') depth++
    else if (config[i] === '}' && --depth === 0) return config.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces reading ${fn}`)
}

describe('agent accounts are gated on what an agent account needs', () => {
  it('extracts the function bodies — the parse is the test here', () => {
    expect(body('isAgentAccountConfigured')).toContain('agentOwnerPrivateKey')
    expect(body('isOnchainConfigured')).toContain('vaultAddress')
  })

  it('does not require the credit vault', () => {
    // The whole defect. An agent account signs transactions; the vault is a
    // lending contract it never calls.
    expect(body('isAgentAccountConfigured')).not.toContain('vaultAddress')
    expect(body('isAgentAccountConfigured')).not.toContain('isOnchainConfigured')
  })

  it('requires an RPC, the owner key, and a transport — and that is all', () => {
    const src = body('isAgentAccountConfigured')
    expect(src).toContain('rpcUrl')
    expect(src).toContain('agentOwnerPrivateKey')
    expect(src).toMatch(/agentAccountMode === 'eoa' \|\| Boolean\(onchainEnv\.zerodevRpc\)/)
    // Not the oracle key either: that publishes scores and resolves disputes,
    // which is a different job from an agent signing its own transaction.
    expect(src).not.toContain('oraclePrivateKey')
  })

  it('leaves isOnchainConfigured meaning what it says', () => {
    // Unchanged on purpose. Its callers are the credit paths that really do
    // need the registry AND the vault.
    const src = body('isOnchainConfigured')
    for (const need of ['rpcUrl', 'oraclePrivateKey', 'registryAddress', 'vaultAddress']) {
      expect(src).toContain(need)
    }
  })

  it('publishes a score without the vault — the third time this coupling bit', () => {
    // isOnchainConfigured has now been the wrong predicate three times:
    //   1. isAgentAccountConfigured    → agents could not transact
    //   2. profile/page.tsx card gate  → the Provision button vanished
    //   3. credit-engine mirrorOnchain → NO SCORE WAS EVER PUBLISHED
    //
    // The third is the product's own claim. Verified against a live deployment:
    // two provisioned agents, a registry reading creditScore = 0 for both, and
    // an empty LimitUpdated log — so nothing had been written rather than zero
    // having been written. Storage cannot distinguish those; the event can.
    const src = readFileSync('lib/credit-engine/index.ts', 'utf8')
    expect(src).toContain('isRegistryConfigured')
    expect(src).not.toMatch(/if \(!isOnchainConfigured\(\)\) return/)
  })

  it('keeps the vault predicate to the paths that read the vault', () => {
    // lib/onchain/credit.ts is the only file that touches vaultAddress, and its
    // borrow/repay functions are what isOnchainConfigured is FOR.
    expect(body('isRegistryConfigured')).not.toContain('vaultAddress')
    for (const need of ['rpcUrl', 'oraclePrivateKey', 'registryAddress']) {
      expect(body('isRegistryConfigured')).toContain(need)
    }
  })

  it('gates each feature on its own contract address', () => {
    expect(body('isLaborMarketConfigured')).toContain('laborMarketAddress')
    expect(body('isVerifiedEscrowConfigured')).toContain('verifiedEscrowAddress')
    expect(body('isGovernanceOnchainConfigured')).toContain('veilpollFactoryAddress')
  })
})
