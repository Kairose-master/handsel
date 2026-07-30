import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/**
 * The paymaster is not the bundler, and the code now says so.
 *
 * They arrived behind one URL — `ZERODEV_RPC` was both — and when sponsorship
 * stopped working, the apparent choice was to keep account abstraction or keep
 * sponsored gas. Those are not coupled: paymaster communication is ERC-7677,
 * viem ships a generic client, and a Kernel account does not care who signs the
 * sponsorship. What looked like a vendor lock was a shared string.
 *
 * Source assertions, because the resolution reads process.env at module load and
 * building a real client needs a network. What can be checked without an
 * environment is checked as code — and the thing most worth checking is that
 * the app and its preflight resolve the SAME variables in the SAME order.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

/**
 * Behaviour, not source order.
 *
 * The first version of this asserted the precedence with `indexOf` over the
 * file, and a mutation that let a stale URL override PAYMASTER_DISABLED passed
 * it — because `PAYMASTER_DISABLED` also appears in the import line, which is
 * before everything and always will be. A test that looks like it checks order
 * and checks nothing is worse than no test: it is the same shape as every defect
 * in this codebase's recent history, arriving in the file meant to prevent them.
 *
 * `resolvePaymaster` reads the env, so the env is what a test should vary.
 */
async function resolveWith(env: Record<string, string | undefined>) {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  try {
    return (await import('@/lib/onchain/paymaster')).resolvePaymaster()
  } finally {
    process.env = saved
    vi.resetModules()
  }
}

describe('choosing a paymaster', () => {
  it('lets PAYMASTER_DISABLED win over any URL still lying around', async () => {
    const choice = await resolveWith({
      PAYMASTER_DISABLED: 'true',
      PAYMASTER_RPC: 'https://example.invalid/pm',
      ZERODEV_RPC: 'https://example.invalid/zd',
    })
    expect(choice.kind).toBe('none')
  })

  it('prefers an explicitly configured endpoint over the bundler\'s', async () => {
    const choice = await resolveWith({
      PAYMASTER_DISABLED: undefined,
      PAYMASTER_RPC: 'https://example.invalid/pm',
      ZERODEV_RPC: 'https://example.invalid/zd',
    })
    expect(choice.kind).toBe('erc7677')
  })

  it('keeps ZERODEV_RPC working when nothing else is set', async () => {
    // The testnet deployment sponsors through it today. A refactor that makes
    // the new path mandatory breaks something that works.
    const choice = await resolveWith({
      PAYMASTER_DISABLED: undefined,
      PAYMASTER_RPC: undefined,
      ZERODEV_RPC: 'https://example.invalid/zd',
    })
    expect(choice.kind).toBe('zerodev')
  })

  it('says none, with a reason, when there is nothing to use', async () => {
    const choice = await resolveWith({
      PAYMASTER_DISABLED: undefined,
      PAYMASTER_RPC: undefined,
      ZERODEV_RPC: undefined,
    })
    expect(choice.kind).toBe('none')
    if (choice.kind === 'none') expect(choice.why).toMatch(/neither/)
  })

  it('treats whitespace as unset rather than as an endpoint', async () => {
    const choice = await resolveWith({
      PAYMASTER_DISABLED: undefined,
      PAYMASTER_RPC: '   ',
      ZERODEV_RPC: 'https://example.invalid/zd',
    })
    expect(choice.kind).toBe('zerodev')
  })

  it('labels the kind and never the URL', async () => {
    // paymasterLabel feeds a public endpoint; the URL carries an API key.
    const saved = { ...process.env }
    process.env.PAYMASTER_RPC = 'https://secret.example.invalid/key-abc123'
    delete process.env.PAYMASTER_DISABLED
    vi.resetModules()
    try {
      const label = (await import('@/lib/onchain/paymaster')).paymasterLabel()
      expect(label).toBe('erc7677')
      expect(label).not.toContain('key-abc123')
    } finally {
      process.env = saved
      vi.resetModules()
    }
  })

  it('uses the generic client for ERC-7677 and ZeroDev\'s for ZeroDev', () => {
    // It speaks ERC-7677 too, so unifying would look tidier — and would swap a
    // working path for a uniform one, which is how a testnet that worked this
    // morning stops working this afternoon.
    const src = code('lib/onchain/paymaster.ts')
    expect(src).toContain('createPaymasterClient')
    expect(src).toContain("from 'viem/account-abstraction'")
    expect(src).toContain('createZeroDevPaymasterClient')
  })
})

describe('the send path asks for it', () => {
  const src = code('lib/onchain/account.ts')

  it('builds the kernel client with whatever was resolved', () => {
    expect(src).toContain('paymasterClient()')
    // The bundler is a separate argument and must not have been swapped with it.
    expect(src).toContain('bundlerTransport: http(onchainEnv.bundlerRpc)')
  })

  it('no longer hardcodes one vendor at the call site', () => {
    expect(src).not.toContain('createZeroDevPaymasterClient')
  })
})

describe('the preflight resolves what the app resolves', () => {
  /**
   * A check that picks its target differently from the app green-lights
   * something the app will not do. This is the whole reason the preflight
   * exists, so it is the one property worth pinning across two files.
   */
  const script = readFileSync('scripts/check-sponsorship.mjs', 'utf8')

  it('reads the same three variables', () => {
    for (const name of ['PAYMASTER_DISABLED', 'PAYMASTER_RPC', 'ZERODEV_RPC', 'BUNDLER_RPC']) {
      expect(script).toContain(name)
    }
  })

  it('applies them in the same order', () => {
    const off = script.indexOf("process.env.PAYMASTER_DISABLED === 'true'")
    const explicit = script.indexOf('process.env.PAYMASTER_RPC?.trim()')
    expect(off).toBeGreaterThan(-1)
    expect(off).toBeLessThan(explicit)
  })

  it('redacts both URLs, not just the one it started with', () => {
    // The generic endpoint carries a key as surely as ZeroDev's does, and the
    // script prints request bodies.
    expect(script).toContain("replaceAll(BUNDLER, '<BUNDLER_RPC>')")
    expect(script).toContain("replaceAll(PAYMASTER, '<PAYMASTER_RPC>')")
  })

  it('still needs a bundler even when the paymaster is elsewhere', () => {
    // Sponsorship can move; bundling cannot. Without a bundler there is no
    // ERC-4337 at all, sponsored or not.
    expect(script).toMatch(/BUNDLER_RPC \(or the legacy ZERODEV_RPC\) is required/)
  })
})

describe('it is visible from outside', () => {
  it('reports which paymaster, not merely that one exists', () => {
    // "sponsored: true" was one answer to a question that had three, and on the
    // day sponsorship broke nothing said which service was being asked.
    const route = code('app/api/capabilities/route.ts')
    expect(route).toContain('paymasterLabel')
    expect(route).not.toMatch(/PAYMASTER_RPC|zerodevRpc\s*\}/)
  })
})

describe('the bundler is a role, not a vendor', () => {
  /**
   * `ZERODEV_RPC` named a vendor for a role, which cost nothing while that
   * vendor supplied both roles. It cost something the moment the paymaster
   * moved: CDP serves bundling and sponsorship from ONE url, so pointing at it
   * meant setting a variable named for a competitor — or not being able to
   * leave. The name was the lock-in, not the code.
   */
  it('prefers BUNDLER_RPC and keeps ZERODEV_RPC working', async () => {
    const saved = { ...process.env }
    try {
      process.env.BUNDLER_RPC = 'https://cdp.example.invalid/rpc'
      process.env.ZERODEV_RPC = 'https://zd.example.invalid'
      vi.resetModules()
      let cfg = await import('@/lib/onchain/config')
      expect(cfg.onchainEnv.bundlerRpc).toBe('https://cdp.example.invalid/rpc')

      delete process.env.BUNDLER_RPC
      vi.resetModules()
      cfg = await import('@/lib/onchain/config')
      expect(cfg.onchainEnv.bundlerRpc).toBe('https://zd.example.invalid')
    } finally {
      process.env = saved
      vi.resetModules()
    }
  })

  it('does not treat a foreign bundler as a ZeroDev paymaster', async () => {
    // The trap in decoupling these: BUNDLER_RPC set to CDP with no PAYMASTER_RPC
    // must resolve to no paymaster, not to ZeroDev's client aimed at CDP. That
    // would send one provider's request shape to another and read the confusion
    // as a refusal — which is the whole afternoon this change came out of.
    const choice = await resolveWith({
      PAYMASTER_DISABLED: undefined,
      PAYMASTER_RPC: undefined,
      ZERODEV_RPC: undefined,
      BUNDLER_RPC: 'https://cdp.example.invalid/rpc',
    })
    expect(choice.kind).toBe('none')
  })

  it('sends the kernel client to the bundler, not to the paymaster', () => {
    const src = code('lib/onchain/account.ts')
    expect(src).toContain('bundlerTransport: http(onchainEnv.bundlerRpc)')
  })
})

describe('the bundler dialect, which the URL did not carry', () => {
  /**
   * Every URL had been made vendor-neutral and the first real mainnet posting
   * still failed with `request denied` — because `createKernelAccountClient`
   * estimates fees by calling `zd_getUserOperationGasPrice`, a ZeroDev
   * extension rather than ERC-4337. The endpoint moved; the dialect stayed.
   *
   * That is the same shape as the rest of this file: something vendor-specific
   * hiding inside something that looked generic, and reported by the far side
   * as a denial rather than as a wrong question.
   */
  async function dialectWith(env: Record<string, string | undefined>) {
    const saved = { ...process.env }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.resetModules()
    try {
      return (await import('@/lib/onchain/paymaster')).bundlerDialect()
    } finally {
      process.env = saved
      vi.resetModules()
    }
  }

  it('keeps ZeroDev on its own estimator', async () => {
    // The testnet runs on this. A uniform replacement would be tidier and would
    // change the path that currently works.
    expect(await dialectWith({ BUNDLER_RPC: undefined, ZERODEV_RPC: 'https://zd.example.invalid' })).toBe('zerodev')
    expect(
      await dialectWith({ BUNDLER_RPC: 'https://zd.example.invalid', ZERODEV_RPC: 'https://zd.example.invalid' }),
    ).toBe('zerodev')
  })

  it('switches to chain fees for any other bundler', async () => {
    expect(
      await dialectWith({ BUNDLER_RPC: 'https://api.developer.coinbase.com/rpc/v1/base/k', ZERODEV_RPC: undefined }),
    ).toBe('standard')
  })

  it('is wired into the client, not merely decided', () => {
    const src = code('lib/onchain/account.ts')
    expect(src).toContain("bundlerDialect() === 'standard'")
    expect(src).toContain('estimateFeesPerGas')
  })
})
