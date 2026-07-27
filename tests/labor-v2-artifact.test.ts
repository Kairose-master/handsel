import { describe, expect, it } from 'vitest'
import { LABOR_MARKET_V2_ABI, LABOR_MARKET_V2_BYTECODE } from '@/lib/onchain/labor-v2-artifact'

/**
 * The artifact is generated and committed, so the server can deploy without
 * solc. Generated files go stale silently: someone edits the .sol, forgets to
 * run scripts/compile-labor-v2.mjs, and the deployed contract is the previous
 * design with the current source sitting next to it in the repo.
 *
 * These assertions pin the surface the rest of the system was written against.
 * They cannot prove the bytecode is correct — that needs an EVM — but they do
 * catch every rename, signature change, and forgotten recompile.
 */

// The generated ABI is `as const`, so every nested array is deeply readonly and
// does not structurally match a mutable shape. Widen through `unknown` once,
// here, rather than sprinkling casts through the assertions.
type AbiEntry = {
  type: string
  name?: string
  inputs?: readonly { readonly name: string; readonly type: string }[]
  outputs?: readonly { readonly name: string }[]
  stateMutability?: string
}
const abi = LABOR_MARKET_V2_ABI as unknown as readonly AbiEntry[]

const fn = (name: string) => abi.find((e) => e.type === 'function' && e.name === name)
const sig = (name: string) => fn(name)?.inputs?.map((i) => i.type).join(',')
const has = (type: string, name: string) => abi.some((e) => e.type === type && e.name === name)

describe('the deployable artifact exists at all', () => {
  it('carries bytecode long enough to be a real contract', () => {
    expect(LABOR_MARKET_V2_BYTECODE.startsWith('0x')).toBe(true)
    expect(LABOR_MARKET_V2_BYTECODE.length).toBeGreaterThan(1000)
  })

  it('fits inside the EIP-170 deployed-code limit with room to spare', () => {
    // Creation code is larger than runtime code, so passing this on creation
    // size is the conservative check.
    expect((LABOR_MARKET_V2_BYTECODE.length - 2) / 2).toBeLessThan(24576)
  })
})

describe('the exits from a stalled job — the whole reason for v2', () => {
  it('exposes reclaimJob, the exit from Accepted that v1 lacked (audit R1)', () => {
    expect(sig('reclaimJob')).toBe('uint256')
  })

  it('exposes expireReview, the mirror stall where the requester goes silent', () => {
    expect(sig('expireReview')).toBe('uint256')
  })

  it('makes both exits permissionless — no operator, no owner, no arbiter arg', () => {
    // If either ever grows a caller restriction it will not show up in the ABI,
    // but an added address parameter would — and that is the shape a
    // "just let the operator do it" patch takes.
    expect(fn('reclaimJob')?.inputs?.length).toBe(1)
    expect(fn('expireReview')?.inputs?.length).toBe(1)
  })

  it('lets the off-chain warner read the contract clock instead of keeping its own', () => {
    expect(fn('reclaimable')?.stateMutability).toBe('view')
    expect(fn('reviewExpirable')?.stateMutability).toBe('view')
  })

  it('announces both exits as events, so they are auditable from a log', () => {
    expect(has('event', 'JobReclaimed')).toBe(true)
    expect(has('event', 'ReviewExpired')).toBe(true)
  })
})

describe('the assignable release — the lien', () => {
  it('exposes assignPayee(jobId, payee)', () => {
    expect(sig('assignPayee')).toBe('uint256,address')
  })

  it('emits the assignment, so a second lender can see the first one’s claim', () => {
    expect(has('event', 'PayeeAssigned')).toBe(true)
  })

  it('exposes the payee through the public jobs mapping', () => {
    const jobs = fn('jobs')
    expect(jobs?.stateMutability).toBe('view')
    // A lender must be able to verify the assignment itself, not take the
    // operator's word or an indexer's.
    expect((jobs?.outputs ?? []).map((o) => o.name)).toContain('payee')
  })
})

describe('the deadline is set by the requester but bounded by the contract', () => {
  it('takes the delivery window at post time', () => {
    expect(sig('postJob')).toBe('uint256,uint256,bytes32,uint32')
  })

  it('publishes both bounds, so the caller can be told why a window was rejected', () => {
    expect(fn('MIN_DELIVERY_WINDOW')?.stateMutability).toBe('view')
    expect(fn('MAX_DELIVERY_WINDOW')?.stateMutability).toBe('view')
  })

  it('fixes the review window in the contract rather than letting the requester pick it', () => {
    // It protects the worker FROM the requester. A value chosen by the party it
    // constrains is not a protection, so there must be no setter and no
    // per-job parameter.
    expect(fn('REVIEW_WINDOW')?.stateMutability).toBe('view')
    expect(has('function', 'setReviewWindow')).toBe(false)
  })
})

describe('what v2 deliberately did NOT change', () => {
  it('still requires the requester to approve on merit', () => {
    expect(sig('approveJob')).toBe('uint256')
  })

  it('still routes a contested job to the arbiter, not to a timeout', () => {
    expect(sig('raiseDispute')).toBe('uint256')
    expect(sig('resolveDispute')).toBe('uint256,bool')
    expect(fn('arbiter')?.stateMutability).toBe('view')
  })

  it('has no owner, no pause, and no upgrade hatch', () => {
    // Every one of these would hand the operator a way to reverse a settlement,
    // which is the property this system exists to remove.
    for (const escape of ['owner', 'pause', 'unpause', 'upgradeTo', 'setArbiter', 'withdraw', 'sweep']) {
      expect(has('function', escape)).toBe(false)
    }
  })
})
