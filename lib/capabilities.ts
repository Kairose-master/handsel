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
  | 'creditRegistry'
  | 'agentAccounts'
  | 'laborMarket'
  | 'verifiedEscrow'
  | 'governance'
  | 'erc8004'
  | 'githubApp'
  | 'githubLogin'
  | 'email'
  | 'secretsAtRest'
  | 'platformLlm'
  | 'solanaMarket'
  | 'solanaWrite'

/**
 * How a capability behaves when its configuration is absent.
 *
 * `gated`  — a predicate hides it. The button is simply not there. Confusing,
 *            but quiet and safe.
 * `throws` — nothing hides it. The button renders, the user clicks it, and the
 *            server throws mid-action. In production Next.js swallows the
 *            message and shows a digest, so the operator sees
 *            "An error occurred in the Server Components render" and has no
 *            way to learn which env var was missing.
 *
 * The second is worse, and the first version of this table missed all of them —
 * it scanned for `is…Configured` predicates, and a throw is not a predicate.
 * `API_KEY_ENCRYPTION_SECRET` was unset on a live deployment, the inventory
 * answered "nothing is blocking", and the Generate button 500'd.
 */
export type CapabilityMode = 'gated' | 'throws'

export type Capability = {
  key: CapabilityKey
  /** What a person loses when this is off, in their words rather than the code's. */
  label: string
  /** Env names that turn it on. The FIRST missing one is usually the answer. */
  requires: string[]
  /** Whether the app still does its core job without this. */
  optional: boolean
  /** What absence looks like to a user. See CapabilityMode. */
  mode: CapabilityMode
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
    mode: 'gated',
    note:
      'Without ZERODEV_RPC the mode falls back to EOA, where each agent pays its own gas. ' +
      'This is the gate the Provision button on /profile sits behind.',
  },
  {
    key: 'laborMarket',
    label: 'Posting, accepting and settling jobs on-chain',
    requires: ['LABOR_MARKET_ADDRESS', 'USDC_ADDRESS', 'ONCHAIN_CHAIN'],
    optional: false,
    mode: 'gated',
    note: 'Also needs agentAccounts. A V2 address additionally enables the four permissionless exits.',
  },
  {
    key: 'solanaMarket',
    label: 'Reading the job board from a Solana cluster',
    requires: ['SOLANA_CLUSTER', 'SOLANA_PROGRAM_ID', 'SOLANA_RPC_URL (only for a cluster with no public endpoint)'],
    optional: true,
    mode: 'gated',
    note:
      'A deployment is EVM or Solana, never both — setting these switches chainKind() and with it every ' +
      'environment label and the isRealMoney() verdict. Devnet only by decision (docs/solana-port.md); ' +
      'SOLANA_CLUSTER=mainnet-beta would flip this deployment to real money, which is the switch working, ' +
      'not a loophole. A half-set pair reads as OFF: a cluster with a typo\'d program id must not present ' +
      'as a market that fails every call.',
  },
  {
    key: 'solanaWrite',
    label: 'Signing and sending Solana instructions from the platform',
    requires: ['SOLANA_CLUSTER', 'SOLANA_PROGRAM_ID', 'SOLANA_OPERATOR_KEYPAIR'],
    optional: true,
    mode: 'gated',
    note:
      'The week-3 write path (docs/solana-port.md): the deployment that serves /solana can run the ' +
      'money loop itself via POST /api/admin/solana-loop. Devnet-only in code — write.ts refuses any ' +
      'real-money cluster regardless of what the env says.',
  },
  {
    key: 'creditRegistry',
    label: 'Publishing an agent credit score on-chain',
    requires: ['ONCHAIN_RPC_URL', 'ORACLE_PRIVATE_KEY', 'CREDIT_REGISTRY_ADDRESS'],
    optional: false,
    mode: 'gated',
    note:
      'The product claim itself: a score earned from behaviour, readable on-chain. It was gated on ' +
      'CREDIT_VAULT_ADDRESS for a while, so a deployment with a live registry published nothing and ' +
      'the registry read all zeros — indistinguishable from a published zero except in the event log.',
  },
  {
    key: 'onchain',
    label: 'Publishing credit limits and reading the vault as the oracle',
    requires: ['ONCHAIN_RPC_URL', 'ORACLE_PRIVATE_KEY', 'CREDIT_REGISTRY_ADDRESS', 'CREDIT_VAULT_ADDRESS'],
    optional: true,
    mode: 'gated',
    note:
      'The VAULT is what borrow/repay use. It is NOT needed to run a labour market — that coupling ' +
      'was a bug, and it hid the Provision button on a deployment that was otherwise complete.',
  },
  {
    key: 'verifiedEscrow',
    label: 'Ground-truth graded tasks with their own escrow',
    requires: ['VERIFIED_TASK_ESCROW_ADDRESS'],
    optional: true,
    mode: 'gated',
  },
  {
    key: 'governance',
    label: 'On-chain commit-reveal voting',
    requires: ['VEILPOLL_FACTORY_ADDRESS'],
    optional: true,
    mode: 'gated',
    note: 'Off ⇒ governance stays purely off-chain, which is the default.',
  },
  {
    key: 'erc8004',
    label: 'Agents register themselves in the ERC-8004 identity registry',
    requires: ['ERC8004_IDENTITY_ADDRESS', 'ERC8004_REPUTATION_ADDRESS', 'ERC8004_VALIDATION_ADDRESS'],
    optional: true,
    mode: 'gated',
  },
  {
    key: 'githubLogin',
    label: 'Sign in with GitHub',
    requires: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    optional: true,
    mode: 'gated',
    note:
      'Same GitHub App as repo jobs — one client id/secret serves both. Can also come from the ' +
      'encrypted platform_secrets KV instead of env.',
  },
  {
    key: 'githubApp',
    label: 'Repo jobs: open a PR, grade on CI, pay on merge',
    requires: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'],
    optional: true,
    mode: 'gated',
    note: 'Or the matching platform_secrets entries. The private key never belongs in the repo.',
  },
  {
    key: 'email',
    label: 'Payment and loan notifications',
    requires: ['RESEND_API_KEY', 'EMAIL_FROM'],
    optional: true,
    mode: 'gated',
  },
  {
    key: 'secretsAtRest',
    label: 'Issuing a worker key, storing a BYOK API key, any platform secret',
    requires: ['API_KEY_ENCRYPTION_SECRET'],
    optional: false,
    mode: 'throws',
    note:
      'NOT gated — nothing hides the buttons. Generate a worker key without it and the action ' +
      'throws inside lib/crypto.ts, which production Next.js reports as "An error occurred in the ' +
      'Server Components render" with the reason omitted. Set it ONCE and never change it: it is ' +
      'the key that decrypts worker keys, BYOK keys and platform_secrets, and there is no rotation ' +
      'path. A different value per deployment, since each has its own database.',
  },
  {
    key: 'platformLlm',
    label: 'Planning, grading and delegation on the platform key',
    requires: ['ANTHROPIC_API_KEY'],
    optional: true,
    mode: 'throws',
    note:
      'Optional only because REQUIRE_USER_API_KEY=true makes every user bring their own. With ' +
      'neither, the throw happens when a job is graded — late, and on a path that was already ' +
      'holding escrow.',
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
  const solana = await import('@/lib/onchain/solana/config')
  const solanaWrite = await import('@/lib/onchain/solana/write')

  const gates: Record<CapabilityKey, () => boolean | Promise<boolean>> = {
    onchain: config.isOnchainConfigured,
    creditRegistry: config.isRegistryConfigured,
    agentAccounts: config.isAgentAccountConfigured,
    laborMarket: config.isLaborMarketConfigured,
    verifiedEscrow: config.isVerifiedEscrowConfigured,
    governance: config.isGovernanceOnchainConfigured,
    erc8004: erc8004.isErc8004Configured,
    githubApp: githubApp.isGithubAppConfigured,
    githubLogin: githubOauth.isGithubLoginEnabled,
    email: email.isEmailConfigured,
    solanaMarket: solana.isSolanaConfigured,
    solanaWrite: solanaWrite.isSolanaWriteConfigured,
    // The two with no predicate to call. There is nothing to ask because
    // nothing asks — the code reaches for the variable and throws if it is not
    // there. So this checks presence directly, and the length floor mirrors the
    // one lib/crypto.ts enforces, since a short secret throws exactly as a
    // missing one does.
    secretsAtRest: () => (process.env.API_KEY_ENCRYPTION_SECRET ?? '').length >= 16,
    platformLlm: () =>
      Boolean(process.env.ANTHROPIC_API_KEY) || process.env.REQUIRE_USER_API_KEY === 'true',
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
