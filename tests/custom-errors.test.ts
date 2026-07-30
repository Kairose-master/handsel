import { encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import { LABOR_MARKET_V2_ABI } from '@/lib/onchain/labor-v2-artifact'
import {
  decodeCustomError,
  explainCustomError,
  explainRevert,
  extractRevertData,
} from '@/lib/onchain/custom-errors'
import { explainOnchainError } from '@/lib/onchain/errors'

/**
 * The reason was always in the response.
 *
 * `postJob` failed on the live deployment and the operator got:
 *
 *     Error [TransactionExecutionError]: Execution reverted for an unknown reason.
 *
 * It was not unknown. LaborMarketV2 raises 23 custom errors and nothing else, and
 * a custom error is a four-byte selector plus ABI-encoded arguments — a shape the
 * existing decoder, which handles `Error(string)` and only that, cannot see. So
 * every V2 revert reached viem's last-resort sentence with its explanation still
 * encoded two frames down the cause chain.
 *
 * Payloads here are built with `encodeErrorResult` against the committed ABI
 * rather than pasted as hex, so the test exercises the real encoding and cannot
 * drift from the contract.
 */

const enc = (errorName: string, args?: readonly unknown[]) =>
  encodeErrorResult({ abi: LABOR_MARKET_V2_ABI, errorName, ...(args ? { args } : {}) } as never)

describe('custom errors decode, arguments and all', () => {
  it('decodes a no-argument error', () => {
    const d = decodeCustomError(enc('WrongStatus'), LABOR_MARKET_V2_ABI as never)
    expect(d?.name).toBe('WrongStatus')
    expect(d?.message).toMatch(/already moved to another status/)
  })

  it('folds the arguments into TooLate — the whole point', () => {
    // A name is a label. `TooLate(now, deadline)` is an explanation, and the
    // difference is the two numbers. These are job #1's real values, 6751s past
    // its window, which the formatter renders as hours because that is what a
    // person reads more easily than "112 minutes".
    const now = 1785399035n
    const deadline = 1785392284n
    const d = decodeCustomError(enc('TooLate', [now, deadline]), LABOR_MARKET_V2_ABI as never)
    expect(d?.name).toBe('TooLate')
    expect(d?.message).toContain('113 minutes ago')
  })

  it('reports TooEarly in the other direction', () => {
    const d = decodeCustomError(enc('TooEarly', [1000n, 1000n + 7200n]), LABOR_MARKET_V2_ABI as never)
    expect(d?.message).toContain('120 minutes away')
  })

  it('quotes both numbers for ScoreTooLow', () => {
    const d = decodeCustomError(enc('ScoreTooLow', [420n, 670n]), LABOR_MARKET_V2_ABI as never)
    expect(d?.message).toContain('420')
    expect(d?.message).toContain('670')
  })

  it('scales the gap to a readable unit', () => {
    expect(explainCustomError('TooLate', [100n, 70n])).toContain('30 seconds')
    expect(explainCustomError('TooLate', [10_000n, 10_000n - 5400n])).toContain('90 minutes')
    expect(explainCustomError('TooLate', [1_000_000n, 1_000_000n - 172_800n])).toContain('2 days')
    // Just past the three-hour handover, where hours finally win.
    expect(explainCustomError('TooLate', [50_000n, 50_000n - 14_400n])).toContain('4 hours')
    // Singular, because "1 minutes ago" is the kind of detail that makes a
    // message look machine-generated and therefore ignorable.
    expect(explainCustomError('TooLate', [160n, 100n])).toContain('1 minute ago')
  })

  it('names an unlisted error rather than giving up on it', () => {
    // FeeTooHigh is a constructor guard that cannot fire post-deployment, so it
    // gets no bespoke sentence — but a NAME is still enormously better than
    // "unknown reason".
    const d = decodeCustomError(enc('FeeTooHigh'), LABOR_MARKET_V2_ABI as never)
    expect(d?.name).toBe('FeeTooHigh')
    expect(d?.message).toContain('FeeTooHigh')
  })

  it('returns null for a payload this ABI does not know', () => {
    // Naming a foreign contract's error with this ABI's vocabulary would be
    // confidently wrong, which is worse than silent.
    expect(decodeCustomError('0xdeadbeef', LABOR_MARKET_V2_ABI as never)).toBeNull()
  })
})

describe('the payload is found wherever viem put it', () => {
  it('walks the cause chain', () => {
    // The real shape: TransactionExecutionError → ExecutionRevertedError →
    // RpcRequestError, and which link holds `.data` depends on whether the call
    // was estimateGas, eth_call or a receipt.
    const payload = enc('SelfWork')
    const inner = Object.assign(new Error('reverted'), { data: payload })
    const mid = Object.assign(new Error('execution reverted'), { cause: inner })
    const outer = Object.assign(new Error('Execution reverted for an unknown reason.'), { cause: mid })
    expect(extractRevertData(outer)).toBe(payload)
  })

  it('handles a data object nested one deeper', () => {
    const payload = enc('NotWorker')
    const e = Object.assign(new Error('x'), { data: { data: payload } })
    expect(extractRevertData(e)).toBe(payload)
  })

  it('falls back to scanning the message', () => {
    const payload = enc('TooLate', [200n, 100n])
    const e = new Error(`RPC failed. Details: execution reverted ${payload} end`)
    expect(extractRevertData(e)).toBe(payload)
  })

  it('prefers the longest candidate, so args are not truncated to a selector', () => {
    // A message containing both the selector and the full payload must yield the
    // full payload — otherwise the arguments are lost at the last step, which is
    // the same class of bug one layer down.
    const full = enc('ScoreTooLow', [1n, 2n])
    const selector = full.slice(0, 10)
    const e = new Error(`saw ${selector} and also ${full}`)
    expect(extractRevertData(e)).toBe(full)
  })

  it('does not mistake a bare 0x for a payload', () => {
    // "reverted with no data" is a real answer and not a decodable one.
    expect(extractRevertData(Object.assign(new Error('x'), { data: '0x' }))).toBeNull()
  })

  it('survives a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(() => extractRevertData(a)).not.toThrow()
  })

  it('returns null when there is nothing there', () => {
    expect(extractRevertData(new Error('the network is down'))).toBeNull()
    expect(extractRevertData(undefined)).toBeNull()
  })
})

describe('the whole path, from a viem error to a sentence', () => {
  it('explains a nested TooLate end to end', () => {
    const payload = enc('TooLate', [1785399035n, 1785392284n])
    const err = Object.assign(new Error('Execution reverted for an unknown reason.'), {
      cause: Object.assign(new Error('reverted'), { data: payload }),
    })
    const d = explainRevert(err, LABOR_MARKET_V2_ABI as never)
    expect(d?.name).toBe('TooLate')
    expect(d?.message).toContain('113 minutes ago')
  })

  it('is reached by explainOnchainError, which every action already calls', () => {
    // The wiring is the deliverable. asActionError → explainOnchainError is the
    // single chokepoint every server action funnels through, so decoding here
    // fixes the message for all of them rather than for the one being debugged.
    const payload = enc('ScoreTooLow', [120n, 500n])
    const err = Object.assign(new Error('Execution reverted for an unknown reason.'), {
      cause: Object.assign(new Error('reverted'), { data: payload }),
    })
    const msg = explainOnchainError(err)
    expect(msg).toContain('ScoreTooLow')
    expect(msg).toContain('120')
    expect(msg).toContain('500')
    expect(msg).not.toMatch(/unknown reason/)
  })

  it('leaves non-revert failures to the paths that already handled them', () => {
    // Rate limits and paymaster refusals are not reverts and had working
    // explanations; this must not shadow them.
    expect(explainOnchainError(new Error('429 Too Many Requests'))).toMatch(/rate-limiting/)
  })
})

describe('the builtins still reach the decoder that handles them', () => {
  it('does not swallow Error(string) — the regression this ordering caused', () => {
    // `Error(string)` and `Panic(uint256)` are Solidity builtins and viem decodes
    // them against ANY abi, so putting custom errors first made a plain
    // `require("USDC: balance...")` come back as name `Error` and land in the
    // generic branch, which reported "the contract rejected the call with Error"
    // and discarded the string. The existing empty-wallet test caught it.
    const payload = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }],
      errorName: 'Error',
      args: ['USDC: balance too low'],
    } as never)
    const msg = explainOnchainError(new Error(`reverted ${payload}`))
    expect(msg).toContain('USDC: balance')
    expect(msg).not.toContain('rejected the call with Error')
  })
})
