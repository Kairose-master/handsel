import { CAPABILITIES, capabilityStatus, missingEssentials } from '@/lib/capabilities'

export const dynamic = 'force-dynamic'

/**
 * GET /api/capabilities — what this deployment can do, and what would switch on
 * the rest.
 *
 * Public and unauthenticated, deliberately. It reports env var NAMES and
 * on/off, never a value: which capabilities a deployment has is already visible
 * from the outside (the buttons are there or they are not), and making it
 * answerable in one request is what stops "why did GitHub sign-in disappear"
 * from needing a code reading.
 *
 * Every feature here is env-gated and degrades to silence when unconfigured,
 * which is correct and has one cost: a feature that is OFF looks exactly like a
 * feature that was never BUILT. On a fresh deployment that makes the whole
 * product look half-finished. This is the answer to that.
 */
export async function GET() {
  const statuses = await capabilityStatus()
  const missing = missingEssentials(statuses)
  const { agentAccountMode, onchainEnv, CHAIN } = await import('@/lib/onchain/config')
  return Response.json({
    type: 'HandselCapabilities',
    /**
     * HOW agents transact, not just whether they can.
     *
     * `agentAccounts: on` was true while posting a job and accepting a job were
     * both impossible, because those two writes went to the kernel directly and
     * this deployment is EOA. The capability was reporting the right answer to a
     * question one layer above the one that mattered — and the mode itself
     * appeared in no page, no endpoint and no log, so the only way to learn it
     * was to read config.ts and guess at the env.
     *
     * A boolean per feature cannot express this. The transport is a property of
     * the deployment, so it belongs here, next to them.
     */
    runtime: {
      agentAccountMode,
      chain: CHAIN.name,
      chainId: CHAIN.id,
      // Presence only, never the URL — it carries an API key.
      bundlerConfigured: Boolean(onchainEnv.zerodevRpc),
      /**
       * WHICH paymaster, because "sponsored" stopped being one answer.
       *
       * The bundler and the paymaster are separate services that shared a URL,
       * and the day sponsorship broke, nothing anywhere said which one was
       * being asked. `zerodev`, `erc7677` (an endpoint like CDP's) or `none`.
       * The kind only — the URL is a credential.
       */
      paymaster: await (async () => {
        try {
          return (await import('@/lib/onchain/paymaster')).paymasterLabel()
        } catch {
          return null
        }
      })(),
      marketIsV2: await (async () => {
        try {
          return await (await import('@/lib/onchain/labor-v2')).isV2Market()
        } catch {
          return null
        }
      })(),
      /**
       * Whether this deployment is on a chain where losing funds means losing
       * funds, and what would refuse if it is.
       *
       * Public because it is the difference between checking readiness with one
       * curl before flipping the chain, and finding out from a refused posting.
       * Blocker CODES and their details only — no addresses, no keys. Every detail
       * string in mainnet-guard.ts names env variables, never values.
       */
      realMoney: await (async () => {
        try {
          const s = await (await import('@/lib/onchain/real-money')).realMoneyStatus()
          return {
            isRealMoney: s.isRealMoney,
            blockers: s.blockers.map((b) => b.code),
            unevaluated: s.unevaluated,
            details: s.blockers.map((b) => b.detail),
          }
        } catch {
          return null
        }
      })(),
    },
    // Counted rather than asserted: "8 of 9" is a live figure, and a reader who
    // sees it drop after a deploy learns something a boolean would hide.
    on: statuses.filter((s) => s.on).length,
    total: CAPABILITIES.length,
    blocking: missing.map((m) => m.key),
    capabilities: statuses.map((s) => ({
      key: s.key,
      label: s.label,
      on: s.on,
      optional: s.optional,
      // NAMES only. A value here would be a credential in a public response.
      requires: s.requires,
      mode: s.mode,
      note: s.note,
    })),
  })
}
