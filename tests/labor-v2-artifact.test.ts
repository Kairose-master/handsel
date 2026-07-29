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

  it('exposes expireOpen, the stall that was the state every job starts in', () => {
    // `cancelJob` is requester-only, so a job nobody accepted and whose
    // requester lost its key held escrow forever with no deadline. R1 in the
    // one state nobody examined, because it is where jobs are supposed to wait.
    expect(sig('expireOpen')).toBe('uint256')
    expect(fn('MAX_OPEN_WINDOW')?.stateMutability).toBe('view')
    expect(has('event', 'OpenExpired')).toBe(true)
  })

  it('exposes expireDispute, the stall the first draft of v2 missed', () => {
    // Disputed was reachable and its only door was resolveDispute, callable by
    // an immutable arbiter with no setter. A lost key froze every contested
    // escrow forever — R1 again, in the contract written to fix R1.
    expect(sig('expireDispute')).toBe('uint256')
  })

  it('makes ALL FOUR exits permissionless — no operator, no owner, no arbiter arg', () => {
    // If any ever grows a caller restriction it will not show up in the ABI,
    // but an added address parameter would — and that is the shape a
    // "just let the operator do it" patch takes.
    for (const exit of ['expireOpen', 'reclaimJob', 'expireReview', 'expireDispute']) {
      expect(fn(exit)?.inputs?.length).toBe(1)
    }
  })

  it('lets the off-chain sweeps read the contract clock instead of keeping their own', () => {
    expect(fn('openExpirable')?.stateMutability).toBe('view')
    expect(fn('reclaimable')?.stateMutability).toBe('view')
    expect(fn('reviewExpirable')?.stateMutability).toBe('view')
    expect(fn('disputeExpirable')?.stateMutability).toBe('view')
  })

  it('announces every exit as an event, so they are auditable from a log', () => {
    expect(has('event', 'JobReclaimed')).toBe(true)
    expect(has('event', 'ReviewExpired')).toBe(true)
    expect(has('event', 'DisputeExpired')).toBe(true)
  })

  it('publishes the dispute window, so the wait is knowable before you escalate', () => {
    expect(fn('DISPUTE_WINDOW')?.stateMutability).toBe('view')
  })

  it('puts the dispute deadline on-chain, in the job itself', () => {
    expect((fn('jobs')?.outputs ?? []).map((o) => o.name)).toContain('disputeDeadline')
  })
})

describe('the assignable release — the lien', () => {
  it('assigns an AMOUNT, not the whole cash flow', () => {
    // Naming a lender sole payee makes it receive the full bounty and owe the
    // worker the remainder back — off-chain, unsecured, in the opposite
    // direction. That is a transfer of risk, not a reduction of it.
    expect(sig('assignPayee')).toBe('uint256,address,uint256')
  })

  it('emits the assignment WITH its size, so a second lender can price the residual', () => {
    const ev = abi.find((e) => e.type === 'event' && e.name === 'PayeeAssigned')
    expect(ev).toBeDefined()
    expect(ev?.inputs?.map((i) => i.type)).toEqual(['uint256', 'address', 'address', 'uint256'])
  })

  it('exposes the payee AND its amount through the public jobs mapping', () => {
    const jobs = fn('jobs')
    expect(jobs?.stateMutability).toBe('view')
    // A lender must be able to verify the assignment itself, not take the
    // operator's word or an indexer's.
    const names = (jobs?.outputs ?? []).map((o) => o.name)
    expect(names).toContain('payee')
    expect(names).toContain('payeeAmount')
  })

  it('computes the split for the lender, so the lender never reimplements it', () => {
    expect(fn('releaseSplit')?.stateMutability).toBe('view')
    expect((fn('releaseSplit')?.outputs ?? []).map((o) => o.name)).toEqual(['payee', 'toPayee', 'toWorker'])
  })

  it('reports both recipients on completion, so a split cannot be mis-attributed', () => {
    const ev = abi.find((e) => e.type === 'event' && e.name === 'JobCompleted')
    const names = (ev?.inputs ?? []).map((i) => i.name)
    expect(names).toContain('payeeAmount')
    expect(names).toContain('workerAmount')
  })
})

describe('the price of silence', () => {
  it('publishes the forfeit rate, so a requester can read it before it applies', () => {
    // A charge a party cannot see coming is a penalty, and this is not one.
    expect(fn('SILENCE_FORFEIT_BPS')?.stateMutability).toBe('view')
  })

  it('computes the expiry split too, not only the release split', () => {
    expect(fn('expirySplit')?.stateMutability).toBe('view')
    expect((fn('expirySplit')?.outputs ?? []).map((o) => o.name)).toEqual([
      'toRequester',
      'toPayee',
      'toWorker',
    ])
  })

  it('reports every leg of an expiry, because it is the one terminal state with three', () => {
    const ev = abi.find((e) => e.type === 'event' && e.name === 'ReviewExpired')
    expect((ev?.inputs ?? []).map((i) => i.name)).toEqual(['jobId', 'refunded', 'toPayee', 'toWorker'])
  })

  it('has no setter — the rate is not something an operator can tune per job', () => {
    for (const setter of ['setForfeit', 'setSilenceForfeit', 'setForfeitBps']) {
      expect(has('function', setter)).toBe(false)
    }
  })
})

describe('a job that was never posted is not a job', () => {
  it('has a distinct error for it', () => {
    // Status.Open is enum value ZERO, so an unposted job reads back as Open.
    // Without a check, acceptJob on a nonexistent id mints a JobAccepted event
    // — a reputation record from nothing.
    expect(has('error', 'NoSuchJob')).toBe(true)
  })

  it('refuses a bounty that escrows nothing', () => {
    expect(has('error', 'BountyTooLow')).toBe(true)
    expect(fn('MIN_BOUNTY')?.stateMutability).toBe('view')
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

describe('withdraw is a claim, not a drain', () => {
  // `withdraw` was on the forbidden list above until settlement became a
  // credit, and the guard firing was correct: on an escrow contract that name
  // is the classic operator drain. It is allowed now only because of the
  // properties below, so they are asserted rather than assumed.

  it('takes no argument, so it cannot name whose money to move', () => {
    expect(fn('withdraw')?.inputs).toHaveLength(0)
  })

  it('lets you redirect only your OWN balance', () => {
    // withdrawTo(address) takes a DESTINATION, not a source. There is no
    // withdrawFrom, and no two-address form that could move someone else's.
    expect(sig('withdrawTo')).toBe('address')
    for (const drain of ['withdrawFrom', 'withdrawFor', 'withdrawAll', 'collect']) {
      expect(has('function', drain)).toBe(false)
    }
  })

  it('publishes every balance it owes', () => {
    expect(fn('withdrawable')?.stateMutability).toBe('view')
    expect(fn('totalWithdrawable')?.stateMutability).toBe('view')
  })

  it('announces money actually leaving, separately from settlement', () => {
    // Every other event is a CREDIT. An indexer that conflates the two reports
    // a worker as paid before it has been.
    const ev = abi.find((e) => e.type === 'event' && e.name === 'Withdrawn')
    expect((ev?.inputs ?? []).map((i) => i.name)).toEqual(['account', 'to', 'amount'])
  })
})

describe('the registry cannot take the market down with it', () => {
  it('has a distinct error for an unreadable score', () => {
    // Not ScoreTooLow(0, n) — that would blame the worker for the registry
    // being down.
    expect(has('error', 'RegistryUnavailable')).toBe(true)
  })

  it('bounds the gas it will forward', () => {
    expect(fn('REGISTRY_GAS_LIMIT')?.stateMutability).toBe('view')
  })
})

describe('the escrow says whether it is solvent', () => {
  it('exposes the running total, not just a per-job amount', () => {
    expect(fn('totalEscrowed')?.stateMutability).toBe('view')
  })

  it('answers solvency in one call', () => {
    // A check that costs a scan over every job ever posted is a check nobody
    // runs, and an invariant nobody runs is not an invariant.
    expect(fn('escrowSolvency')?.inputs).toHaveLength(0)
    expect((fn('escrowSolvency')?.outputs ?? []).map((o) => o.name)).toEqual(['owed', 'held', 'surplus'])
  })

  it('offers no sweep for the surplus', () => {
    // A function that moves tokens the contract does not owe is a function
    // that can move tokens it does.
    for (const escape of ['sweep', 'skim', 'rescue', 'recover', 'withdrawSurplus']) {
      expect(has('function', escape)).toBe(false)
    }
  })
})

describe('the protocol fee', () => {
  it('is set at deploy and immutable', () => {
    // The off-chain collector only worked while the operator drove every
    // agent's account. This one survives a user posting with their own key.
    expect(fn('feeBps')?.stateMutability).toBe('view')
    expect(fn('feeRecipient')?.stateMutability).toBe('view')
    for (const setter of ['setFee', 'setFeeBps', 'setFeeRecipient', 'updateFee']) {
      expect(has('function', setter)).toBe(false)
    }
  })

  it('takes the addresses positionally and every number by name', () => {
    // The three addresses stay positional because they are distinct types that
    // a wrong order would not survive. Every NUMBER moved into a struct, and
    // this is the assertion that makes the struct worth having: `reviewWindow`
    // and `disputeWindow` are both uint32 seconds, so transposing them
    // compiles, deploys, and passes every bounds check the constructor runs.
    // The contract is immutable, so that transposition is permanent.
    //
    // Pinning the ORDER here as well as the names is deliberate. A deploy
    // script that builds the struct positionally is still possible, so a
    // reordering of these fields must break something loudly at CI time rather
    // than quietly at deploy time.
    const ctor = abi.find((e) => e.type === 'constructor')
    const inputs = ctor?.inputs ?? []
    expect(inputs.map((i) => i.name)).toEqual(['_usdc', '_registry', '_arbiter', 'cfg'])

    const cfg = inputs[3] as { components?: { name: string; type: string }[] }
    expect((cfg.components ?? []).map((c) => `${c.name}:${c.type}`)).toEqual([
      'feeBps:uint16',
      'feeRecipient:address',
      'flatFee:uint256',
      'bondBps:uint16',
      'flatBond:uint256',
      'minDeliveryWindow:uint32',
      'maxDeliveryWindow:uint32',
      'reviewWindow:uint32',
      'maxOpenWindow:uint32',
      'disputeWindow:uint32',
      'silenceForfeitBps:uint16',
      'minBounty:uint256',
    ])
  })

  it('still has no setter for anything the constructor fixed', () => {
    // The windows became constructor arguments; they must not have become
    // MUTABLE on the way. Configurable-per-deployment and configurable-after-
    // deployment are different properties, and only the first one was wanted.
    for (const name of [
      'REVIEW_WINDOW',
      'DISPUTE_WINDOW',
      'MAX_OPEN_WINDOW',
      'MIN_DELIVERY_WINDOW',
      'MAX_DELIVERY_WINDOW',
      'SILENCE_FORFEIT_BPS',
      'MIN_BOUNTY',
      'bondBps',
    ]) {
      expect(fn(name)?.stateMutability, `${name} should be a view`).toBe('view')
    }
    for (const setter of [
      'setReviewWindow',
      'setDisputeWindow',
      'setWindows',
      'setBondBps',
      'setForfeit',
      'setMinBounty',
      'setFlatFee',
      'setFlatBond',
      'setConfig',
    ]) {
      expect(has('function', setter), `${setter} must not exist`).toBe(false)
    }
  })

  it('prices the worker bond, and publishes its ceiling', () => {
    // Accepting used to be free, which the non-refundable posting fee turned
    // into a grief the victim paid for: measured at requester −100_000 and
    // house +100_000 over five cycles, with the squatter's balance unchanged.
    expect(fn('bondFor')?.stateMutability).toBe('view')
    expect(fn('feeOn')?.stateMutability).toBe('view')
    // A percentage cannot cover a fixed cost, and gas is a fixed cost — so both
    // sides carry a flat component and both are immutable views, not setters.
    expect(fn('flatFee')?.stateMutability).toBe('view')
    expect(fn('flatBond')?.stateMutability).toBe('view')
    expect(fn('MAX_BOND_BPS')?.stateMutability).toBe('view')
    expect(has('error', 'BondTooHigh')).toBe(true)
    expect(has('error', 'ForfeitTooHigh')).toBe(true)
  })

  it('publishes its own ceiling, and refuses to exceed it', () => {
    expect(fn('MAX_FEE_BPS')?.stateMutability).toBe('view')
    expect(has('error', 'FeeTooHigh')).toBe(true)
    expect(has('error', 'ZeroFeeRecipient')).toBe(true)
  })

  it('reports what was charged in the posting event', () => {
    const ev = abi.find((e) => e.type === 'event' && e.name === 'JobPosted')
    expect((ev?.inputs ?? []).map((i) => i.name)).toContain('fee')
  })
})

describe('what v2 deliberately did NOT change', () => {
  it('still requires the requester to approve on merit', () => {
    expect(sig('approveJob')).toBe('uint256')
  })

  it('still routes a contested job to the arbiter FIRST', () => {
    // expireDispute is a backstop against an arbiter that is gone, not a
    // replacement for one that works: it cannot be called before the window.
    expect(sig('raiseDispute')).toBe('uint256')
    expect(sig('resolveDispute')).toBe('uint256,bool')
    expect(fn('arbiter')?.stateMutability).toBe('view')
  })

  it('has no owner, no pause, and no upgrade hatch', () => {
    // Every one of these would hand the operator a way to reverse a settlement,
    // which is the property this system exists to remove.
    for (const escape of ['owner', 'pause', 'unpause', 'upgradeTo', 'setArbiter', 'sweep']) {
      expect(has('function', escape)).toBe(false)
    }
  })
})
