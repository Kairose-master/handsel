/**
 * A real EVM, in-process, for testing LaborMarketV2's state machine.
 *
 * Foundry could not be installed here (the GitHub API is 403 behind this
 * environment's proxy), so the harness drives @ethereumjs/vm directly and
 * encodes calldata with viem. The execution is genuine EVM execution — the
 * same bytecode that gets deployed — which is the property that matters. What
 * it is not is a fork of a live chain, so nothing here proves anything about
 * how the real USDC contract behaves.
 *
 * Block timestamp is settable per call, because every interesting case in this
 * contract is about a deadline.
 */
import { readFileSync } from 'node:fs'
import { Chain as EjsChain, Common, Hardfork } from '@ethereumjs/common'
import { VM } from '@ethereumjs/vm'
import { Address as EjsAddress, hexToBytes, bytesToHex } from '@ethereumjs/util'
import {
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  toFunctionSelector,
  type Abi,
  type Hex,
} from 'viem'

type Artifact = { abi: Abi; bytecode: Hex }
const fixture = JSON.parse(readFileSync('tests/fixtures/evm-artifacts.json', 'utf8')) as {
  solc: string
  contracts: Record<string, Artifact>
}

export const artifacts = fixture.contracts

/** Deterministic test accounts. Names, not hex, at the call sites. */
export const ACCOUNTS = {
  requester: '0x1111111111111111111111111111111111111111',
  worker: '0x2222222222222222222222222222222222222222',
  otherWorker: '0x3333333333333333333333333333333333333333',
  arbiter: '0x4444444444444444444444444444444444444444',
  lender: '0x5555555555555555555555555555555555555555',
  stranger: '0x6666666666666666666666666666666666666666',
} as const

export type Account = keyof typeof ACCOUNTS

export class Chain {
  private vm!: VM
  private nextAddress = 0x100
  /** Seconds. Advanced explicitly by tests; never wall-clock. */
  timestamp = 1_800_000_000

  static async create(): Promise<Chain> {
    const chain = new Chain()
    const common = new Common({ chain: EjsChain.Mainnet, hardfork: Hardfork.Shanghai })
    chain.vm = await VM.create({ common })
    return chain
  }

  advance(seconds: number) {
    this.timestamp += seconds
  }

  private alloc(): `0x${string}` {
    const n = this.nextAddress++
    return ('0x' + n.toString(16).padStart(40, '0')) as `0x${string}`
  }

  /** Deploy a compiled contract; returns its address. */
  async deploy(name: string, args: readonly unknown[] = []): Promise<`0x${string}`> {
    const artifact = artifacts[name]
    if (!artifact) throw new Error(`no artifact for ${name}`)
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: args as never })
    // Let the EVM perform a real CREATE rather than writing code into an
    // account by hand: the constructor runs, and a constructor that reverts
    // fails the test instead of leaving a silently empty contract behind.
    const result = await this.vm.evm.runCall({
      caller: new EjsAddress(hexToBytes(ACCOUNTS.requester)),
      to: undefined,
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      block: { header: { timestamp: BigInt(this.timestamp), number: 1n } } as never,
    })
    if (result.execResult.exceptionError) {
      throw new Error(`deploy ${name} reverted: ${result.execResult.exceptionError.error}`)
    }
    const created = result.createdAddress
    if (!created) throw new Error(`deploy ${name} produced no address`)
    return bytesToHex(created.bytes) as `0x${string}`
  }

  /** Send a transaction. Throws with the decoded revert reason on failure. */
  async send(
    from: Account,
    to: `0x${string}`,
    name: string,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<void> {
    const out = await this.call(from, to, name, fn, args)
    void out
  }

  /** Call and return the decoded result. Reverts throw. */
  async call<T = unknown>(
    from: Account,
    to: `0x${string}`,
    name: string,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    const artifact = artifacts[name]
    const data = encodeFunctionData({ abi: artifact.abi, functionName: fn, args: args as never })
    const result = await this.vm.evm.runCall({
      caller: new EjsAddress(hexToBytes(ACCOUNTS[from])),
      to: new EjsAddress(hexToBytes(to)),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      block: { header: { timestamp: BigInt(this.timestamp), number: 1n } } as never,
    })
    if (result.execResult.exceptionError) {
      const returned = bytesToHex(result.execResult.returnValue) as Hex
      throw new Error(`${fn} reverted: ${decodeRevert(returned) ?? result.execResult.exceptionError.error}`)
    }
    const returned = bytesToHex(result.execResult.returnValue) as Hex
    const outputs = (artifact.abi.find((e) => e.type === 'function' && e.name === fn) as { outputs?: unknown[] })
      ?.outputs
    if (!outputs || outputs.length === 0) return undefined as T
    return decodeFunctionResult({ abi: artifact.abi, functionName: fn, data: returned }) as T
  }

  /** Whether a call reverts, and with what — for the many "must be rejected"
   *  assertions. Returning the reason rather than a boolean means a test can
   *  assert WHICH guard fired, not merely that something did. */
  async revertReason(
    from: Account,
    to: `0x${string}`,
    name: string,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<string | null> {
    try {
      await this.call(from, to, name, fn, args)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Custom errors arrive as bare 4-byte selectors, so a failing assertion would
 * otherwise print `0xcb6c86dd`. The map is DERIVED from the compiled ABIs
 * rather than written out: hand-maintained selector tables drift the moment an
 * error's arguments change, and a stale entry mislabels the guard that fired —
 * which is worse than printing hex, because it is confidently wrong.
 */
const SELECTORS: Record<string, string> = Object.fromEntries(
  Object.values(artifacts).flatMap((artifact) =>
    (artifact.abi as { type: string; name?: string; inputs?: { type: string }[] }[])
      .filter((entry) => entry.type === 'error' && entry.name)
      .map((entry) => {
        const signature = `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(',')})`
        return [toFunctionSelector(signature), signature]
      }),
  ),
)

function decodeRevert(data: Hex): string | null {
  if (data === '0x' || data.length < 10) return null
  const selector = data.slice(0, 10)
  // Error(string)
  if (selector === '0x08c379a0') {
    try {
      const decoded = decodeFunctionResult({
        abi: [{ type: 'function', name: 'e', outputs: [{ type: 'string' }], inputs: [], stateMutability: 'view' }],
        functionName: 'e',
        data: ('0x' + data.slice(10)) as Hex,
      })
      return String(decoded)
    } catch {
      return selector
    }
  }
  return SELECTORS[selector] ?? selector
}
