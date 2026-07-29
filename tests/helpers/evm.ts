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
  decodeEventLog,
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
  /** Where the protocol fee goes. Separate from every other role so a fee
   *  landing in the wrong place shows up as a balance nobody expected. */
  house: '0x7777777777777777777777777777777777777777',
} as const

export type Account = keyof typeof ACCOUNTS

/**
 * LaborMarketV2's deploy-time `Config`.
 *
 * These were `constant` in the contract until a deployment needed to serve both
 * a testnet and Base without a source edit. They are a struct rather than eleven
 * positional arguments because `reviewWindow` and `disputeWindow` are both
 * uint32 seconds — transposing them compiles, deploys, and passes every bounds
 * check, and the contract is immutable.
 *
 * `bondBps: 0` is the default here on purpose: it is the no-bond behaviour every
 * test in the suite was written against, so the whole existing suite goes on
 * exercising the path a first mainnet deployment will actually run. Tests about
 * the bond override the one field.
 */
export type MarketConfig = {
  feeBps: number
  feeRecipient: string
  flatFee: bigint
  bondBps: number
  flatBond: bigint
  minDeliveryWindow: number
  maxDeliveryWindow: number
  reviewWindow: number
  maxOpenWindow: number
  disputeWindow: number
  silenceForfeitBps: number
  minBounty: bigint
}

export const DEFAULT_CONFIG: MarketConfig = {
  feeBps: 200,
  feeRecipient: ACCOUNTS.house,
  // Zero by default so the whole existing suite keeps exercising the
  // proportional-only pricing it was written against; the flat components have
  // their own file.
  flatFee: 0n,
  bondBps: 0,
  flatBond: 0n,
  minDeliveryWindow: 10 * 60,
  maxDeliveryWindow: 30 * 24 * 3600,
  reviewWindow: 7 * 24 * 3600,
  maxOpenWindow: 60 * 24 * 3600,
  disputeWindow: 14 * 24 * 3600,
  silenceForfeitBps: 1000,
  minBounty: 1n,
}

export const marketConfig = (overrides: Partial<MarketConfig> = {}): MarketConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
})

/** ethereumjs shape: [emitter, topics, data]. */
type RawLog = [Uint8Array, Uint8Array[], Uint8Array]

export class Chain {
  private vm!: VM
  private nextAddress = 0x100
  private lastLogs: RawLog[] = []
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
      // Decoded, like every other revert in this harness. A constructor guard
      // is the one revert that fires exactly once — on a deploy, under time
      // pressure, against an address about to be published — so "revert" with
      // no name is the least useful place in the whole system to lose it. This
      // used to print `exceptionError.error`, which for a custom error is the
      // bare string "revert" and names nothing.
      const returned = bytesToHex(result.execResult.returnValue) as Hex
      throw new Error(
        `deploy ${name} reverted: ${decodeRevert(returned) ?? result.execResult.exceptionError.error}`,
      )
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
    this.lastLogs = (result.execResult.logs ?? []) as RawLog[]
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

  /** Decoded events of one name emitted by the most recent send/call.
   *
   *  A settlement is two claims: it moves money, and it TELLS the outside world
   *  what it moved. The balance assertions everywhere else cover the first. An
   *  indexer — or a lender deciding whether it was repaid — only ever sees the
   *  second, so it needs pinning too. Logs that do not decode against this
   *  artifact are skipped rather than thrown on: a call may legitimately emit
   *  another contract's events (the token's Transfer, most often). */
  events<T = Record<string, unknown>>(name: string, event: string): T[] {
    const abi = artifacts[name].abi
    const out: T[] = []
    for (const [, topics, data] of this.lastLogs) {
      try {
        const decoded = decodeEventLog({
          abi,
          topics: topics.map((t) => bytesToHex(t) as Hex) as [] | [Hex, ...Hex[]],
          data: bytesToHex(data) as Hex,
        })
        if (decoded.eventName === event) out.push(decoded.args as T)
      } catch {
        // not this ABI's event
      }
    }
    return out
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
