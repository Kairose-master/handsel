import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The hole this closes, stated as the bug it was.
 *
 * `isRealMoney()` classified a deployment by `CHAIN.id`, which is built from
 * `ONCHAIN_CHAIN` — an EVM chain name. The allowlist is TESTNETS, so anything
 * unrecognised counts as real money, which is the right asymmetry for EVM and
 * the wrong answer entirely for a deployment whose money lives on Solana: it
 * would have worn the mainnet badge, printed the mainnet disclosure, and armed
 * `assertRealMoneyReady` over devnet tokens worth nothing.
 *
 * These are env-driven and pure, so they run without a chain, which is the
 * point — `docs/solana-port.md` says devnet is a decision, and this is the
 * test that makes the decision enforceable rather than aspirational.
 */

const PROGRAM = '2p6KBeJX8TbdcQC8pcWmLxhyCASMwg7HtLbtptUo7yZg'
const KEYS = ['SOLANA_CLUSTER', 'SOLANA_PROGRAM_ID', 'SOLANA_RPC_URL'] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  vi.resetModules()
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
})

/**
 * Re-import after mutating env — the config module snapshots at load.
 *
 * Clears every key first, so each call describes the WHOLE environment rather
 * than a patch on whatever the previous call left behind. Without that, a loop
 * over "half-set" cases silently tests fully-set ones after the first
 * iteration, and passes.
 */
async function load(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  return {
    kind: await import('@/lib/onchain/chain-kind'),
    solana: await import('@/lib/onchain/solana/config'),
  }
}

describe('chainKind', () => {
  it('is evm when no Solana env is set — every existing deployment is untouched', async () => {
    const { kind } = await load({})
    expect(kind.chainKind()).toBe('evm')
  })

  it('is solana only when the cluster AND a valid program address are present', async () => {
    const { kind } = await load({ SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: PROGRAM })
    expect(kind.chainKind()).toBe('solana')
  })

  it('a half-set environment is NOT a Solana deployment', async () => {
    // A cluster with a typo'd program id must read as unconfigured, not as a
    // Solana market that fails every call — the second one degrades into an
    // empty board, which is indistinguishable from an empty market.
    for (const env of [
      { SOLANA_CLUSTER: 'devnet' },
      { SOLANA_PROGRAM_ID: PROGRAM },
      { SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: 'not-a-real-address' },
      { SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: 'TooShort' },
    ]) {
      const { kind } = await load(env)
      expect(kind.chainKind(), JSON.stringify(env)).toBe('evm')
    }
  })

  it('an unknown cluster with no RPC override is not configured', async () => {
    // There is no default endpoint to guess for it, and guessing one would
    // point the board at a cluster nobody chose.
    const { kind } = await load({ SOLANA_CLUSTER: 'moonbase', SOLANA_PROGRAM_ID: PROGRAM })
    expect(kind.chainKind()).toBe('evm')

    const withRpc = await load({
      SOLANA_CLUSTER: 'moonbase',
      SOLANA_PROGRAM_ID: PROGRAM,
      SOLANA_RPC_URL: 'https://rpc.example.test',
    })
    expect(withRpc.kind.chainKind()).toBe('solana')
  })
})

describe('real money follows the runtime the money is actually on', () => {
  it('devnet is not real money, whatever the EVM side would have said', async () => {
    const { kind } = await load({ SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: PROGRAM })
    // `true` is what the EVM classifier returns for an unrecognised chain id —
    // the exact input that made this a bug.
    expect(kind.realMoneyForKind(true)).toBe(false)
  })

  it('testnet and localnet likewise', async () => {
    for (const cluster of ['testnet', 'localnet']) {
      const { kind } = await load({ SOLANA_CLUSTER: cluster, SOLANA_PROGRAM_ID: PROGRAM })
      expect(kind.realMoneyForKind(true), cluster).toBe(false)
    }
  })

  it('mainnet-beta IS real money — this is a switch, not a permanent exemption', async () => {
    const { kind } = await load({ SOLANA_CLUSTER: 'mainnet-beta', SOLANA_PROGRAM_ID: PROGRAM })
    expect(kind.realMoneyForKind(false)).toBe(true)
  })

  it('an unrecognised cluster counts as real money', async () => {
    // Same asymmetry the EVM allowlist uses: being wrong this way costs two
    // minutes of confusion, the other way costs somebody's funds.
    const { kind } = await load({
      SOLANA_CLUSTER: 'some-new-cluster',
      SOLANA_PROGRAM_ID: PROGRAM,
      SOLANA_RPC_URL: 'https://rpc.example.test',
    })
    expect(kind.realMoneyForKind(false)).toBe(true)
  })

  it('passes the EVM answer straight through when this is an EVM deployment', async () => {
    const { kind } = await load({})
    expect(kind.realMoneyForKind(true)).toBe(true)
    expect(kind.realMoneyForKind(false)).toBe(false)
  })
})

describe('labels are derived, never hardcoded', () => {
  it('a Solana deployment does not display the name of an EVM chain', async () => {
    const { kind } = await load({ SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: PROGRAM })
    expect(kind.chainDisplayName('Sepolia')).toBe('Solana devnet')
  })

  it('an EVM deployment keeps its chain name, and null stays null', async () => {
    const { kind } = await load({})
    expect(kind.chainDisplayName('Base')).toBe('Base')
    expect(kind.chainDisplayName(null)).toBeNull()
  })
})

describe('explorer links point at the configured cluster', () => {
  it('carries the cluster for devnet', async () => {
    const { solana } = await load({ SOLANA_CLUSTER: 'devnet', SOLANA_PROGRAM_ID: PROGRAM })
    expect(solana.solanaExplorerUrl(PROGRAM)).toBe(
      `https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`,
    )
  })

  it('omits it for mainnet-beta, which is the explorer default', async () => {
    const { solana } = await load({ SOLANA_CLUSTER: 'mainnet-beta', SOLANA_PROGRAM_ID: PROGRAM })
    expect(solana.solanaExplorerUrl(PROGRAM)).toBe(`https://explorer.solana.com/address/${PROGRAM}`)
  })
})
