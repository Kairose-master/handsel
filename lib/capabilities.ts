/**
 * What this deployment can actually do, and what would switch on the rest.
 *
 * Every optional feature in this app is env-gated and degrades to silence when
 * its configuration is absent — see CLAUDE.md, "Optional on-chain. Features
 * degrade gracefully without their env". That is the right behaviour and it has
 * one cost: **a feature that is off looks exactly like a feature that was never
 * built.** On a fresh deployment the whole product looks half-finished, and the
 * question "why did GitHub sign-in disappear" has no place to be answered.
 *
 * It had no place to be answered here either. Nine `is…Configured` predicates
 * were scattered across seven files, `/doctor` reported none of them, and the
 * only way to know a capability was dark was to notice its button missing.
 *
 * So: one table, evaluated live. No cached judgements, no hardcoded "should be
 * on" — each row calls the same predicate the feature itself calls, which is
 * what keeps this from drifting into a second opinion about the truth.
 */

export type CapabilityKey =
  | 'onchain'
  | 'agentAccounts'
  | 'laborMarket'
  | 'verifiedEscrow'
  | 'governance'
  | 'erc8004'
  | 'githubApp'
  | 'githubLogin'
  | 'email'

export type Capability = {
  key: CapabilityKey
  /** What a person loses when this is off, in their words rather than the code's. */
  label: string
  /** Env names that turn it on. The FIRST missing one is usually the answer. */
  requires: string[]
  /** Whether the app still does its core job without this. */
  optional: boolean
  /** Anything worth knowing before switching it on. */
  note?: string
}

/**
 * Pure data, deliberately. The gates live with their features; this says what
 * each one MEANS, which is the part no predicate can express.
 */
export const CAPABILITIES: Capability[] = [
  {
    key: 'agentAccounts',
    label: 'Agents can hold an address and sign transactions',
    requires: ['ONCHAIN_RPC_URL', 'AGENT_OWNER_PRIVATE_KEY', 'ZERODEV_RPC (kernel mode only)'],
    optional: false,
    note:
      'Without ZERODEV_RPC the mode falls back to EOA, where each agent pays its own gas. ' +
      'This is the gate the Provision button on /profile sits behind.',
  },
  {
    key: 'laborMarket',
    label: 'Posting, accepting and settling jobs on-chain',
    requires: ['LABOR_MARKET_ADDRESS', 'USDC_ADDRESS', 'ONCHAIN_CHAIN'],
    optional: false,
    note: 'Also needs agentAccounts. A V2 address additionally enables the four permissionless exits.',
  },
  {
    key: 'onchain',
    label: 'Publishing credit limits and reading the vault as the oracle',
    requires: ['ONCHAIN_RPC_URL', 'ORACLE_PRIVATE_KEY', 'CREDIT_REGISTRY_ADDRESS', 'CREDIT_VAULT_ADDRESS'],
    optional: true,
    note:
      'The VAULT is what borrow/repay use. It is NOT needed to run a labour market — that coupling ' +
      'was a bug, and it hid the Provision button on a deployment that was otherwise complete.',
  },
  {
    key: 'verifiedEscrow',
    label: 'Ground-truth graded tasks with their own escrow',
    requires: ['VERIFIED_TASK_ESCROW_ADDRESS'],
    optional: true,
  },
  {
    key: 'governance',
    label: 'On-chain commit-reveal voting',
    requires: ['VEILPOLL_FACTORY_ADDRESS'],
    optional: true,
    note: 'Off ⇒ governance stays purely off-chain, which is the default.',
  },
  {
    key: 'erc8004',
    label: 'Agents register themselves in the ERC-8004 identity registry',
    requires: ['ERC8004_IDENTITY_ADDRESS', 'ERC8004_REPUTATION_ADDRESS', 'ERC8004_VALIDATION_ADDRESS'],
    optional: true,
  },
  {
    key: 'githubLogin',
    label: 'Sign in with GitHub',
    requires: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    optional: true,
    note:
      'Same GitHub App as repo jobs — one client id/secret serves both. Can also come from the ' +
      'encrypted platform_secrets KV instead of env.',
  },
  {
    key: 'githubApp',
    label: 'Repo jobs: open a PR, grade on CI, pay on merge',
    requires: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'],
    optional: true,
    note: 'Or the matching platform_secrets entries. The private key never belongs in the repo.',
  },
  {
    key: 'email',
    label: 'Payment and loan notifications',
    requires: ['RESEND_API_KEY', 'EMAIL_FROM'],
    optional: true,
  },
]

export type CapabilityStatus = Capability & { on: boolean }

/**
 * Evaluate every gate, right now.
 *
 * Each row calls the predicate its own feature calls — not a re-derivation from
 * env names, which would be a second opinion that can disagree with the first.
 * A throwing gate reads as OFF: a capability that cannot answer whether it is
 * available is not available.
 */
export async function capabilityStatus(): Promise<CapabilityStatus[]> {
  const config = await import('@/lib/onchain/config')
  const erc8004 = await import('@/lib/onchain/erc8004')
  const githubApp = await import('@/lib/github-app')
  const githubOauth = await import('@/lib/github-oauth')
  const email = await import('@/lib/email')

  const gates: Record<CapabilityKey, () => boolean | Promise<boolean>> = {
    onchain: config.isOnchainConfigured,
    agentAccounts: config.isAgentAccountConfigured,
    laborMarket: config.isLaborMarketConfigured,
    verifiedEscrow: config.isVerifiedEscrowConfigured,
    governance: config.isGovernanceOnchainConfigured,
    erc8004: erc8004.isErc8004Configured,
    githubApp: githubApp.isGithubAppConfigured,
    githubLogin: githubOauth.isGithubLoginEnabled,
    email: email.isEmailConfigured,
  }

  return Promise.all(
    CAPABILITIES.map(async (cap) => {
      let on = false
      try {
        on = Boolean(await gates[cap.key]())
      } catch {
        on = false
      }
      return { ...cap, on }
    }),
  )
}

/** The ones that are off and are not supposed to be — for a one-line summary. */
export function missingEssentials(statuses: CapabilityStatus[]): CapabilityStatus[] {
  return statuses.filter((s) => !s.on && !s.optional)
}
