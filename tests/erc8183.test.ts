import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ERC8183_STATUSES,
  ZERO_ADDRESS,
  toErc8183,
  toErc8183Board,
  type LaborJobInput,
} from '@/lib/onchain/erc8183'

/**
 * The projection is a claim about another project's standard, so the tests
 * check it against the Solidity it claims to describe, not only against
 * itself: the V2 status enum is read out of the contract source, and every
 * variant must have a mapping. A status added on the Solidity side and not
 * mirrored here fails at `npm run test`, the same guard
 * `tests/solana-codec.test.ts` puts on the Rust.
 */

const CONTRACT = join(process.cwd(), 'contracts/src/LaborMarketV2.sol')

const job = (over: Partial<LaborJobInput> = {}): LaborJobInput => ({
  id: 7,
  requester: '0xC1e17',
  worker: ZERO_ADDRESS,
  bounty: 100,
  minScore: 0,
  status: 'Open',
  resultHash: `0x${'0'.repeat(64)}`,
  deadline: 1_785_000_000,
  ...over,
})

describe('every V2 status has a mapping', () => {
  it('the contract enum and the map agree', () => {
    const src = readFileSync(CONTRACT, 'utf8')
    const start = src.indexOf('enum Status {')
    const body = src.slice(start, src.indexOf('\n    }', start))
    const variants = [...body.matchAll(/^\s{8}(\w+),?$/gm)].map((m) => m[1])
    expect(variants.length).toBeGreaterThanOrEqual(8)
    for (const v of variants) {
      expect(toErc8183(job({ status: v })), `no ERC-8183 mapping for V2 status ${v}`).not.toBeNull()
    }
  })

  it('an unknown status is dropped, not guessed', () => {
    // Publishing a lifecycle position nobody reached is worse than publishing
    // nothing — same rule as decodeJobAccount's unknown-variant branch.
    expect(toErc8183(job({ status: 'Rehypothecated' }))).toBeNull()
    expect(toErc8183Board([job(), job({ status: 'Rehypothecated' })])).toHaveLength(1)
  })

  it('only ever emits states the standard defines', () => {
    for (const v of ['Open', 'Accepted', 'Submitted', 'Completed', 'Cancelled', 'Disputed', 'Refunded', 'Expired']) {
      const out = toErc8183(job({ status: v }))!
      expect(ERC8183_STATUSES).toContain(out.status)
    }
  })
})

describe('the asymmetries, which are the point', () => {
  it('a V2 Open job is already Funded — 8183 Open is unreachable here', () => {
    // postJob escrows inline, so this market has no created-but-unfunded
    // state at all. Mapping Open→Open would advertise an unfunded job.
    expect(toErc8183(job({ status: 'Open' }))!.status).toBe('Funded')
    const reachable = new Set(
      ['Open', 'Accepted', 'Submitted', 'Completed', 'Cancelled', 'Disputed', 'Refunded', 'Expired'].map(
        (s) => toErc8183(job({ status: s }))!.status,
      ),
    )
    expect(reachable.has('Open')).toBe(false)
  })

  it('Accepted is also Funded, and says the bond was lost', () => {
    const out = toErc8183(job({ status: 'Accepted', worker: '0xW0rker' }))!
    expect(out.status).toBe('Funded')
    expect(out.provider).toBe('0xW0rker')
    // The standard has no field for a staked bond. That is the biggest thing
    // it cannot see about this market, and it is reported rather than dropped.
    expect(out.lost).toContain('worker-bond')
  })

  it('Disputed keeps its lifecycle position and loses its process', () => {
    const out = toErc8183(job({ status: 'Disputed', worker: '0xW0rker' }))!
    expect(out.status).toBe('Submitted') // delivered, evaluator has not ruled
    expect(out.lost).toContain('dispute')
  })

  it('Expired reports that the two standards mean different things by it', () => {
    // 8183: refunded to the client after timeout. V2: settled by a deadline
    // with no verdict — and expireReview pays the WORKER. Same word.
    expect(toErc8183(job({ status: 'Expired' }))!.lost).toContain('no-verdict-expiry')
  })

  it('a credit-gated job says so', () => {
    expect(toErc8183(job({ minScore: 600 }))!.lost).toContain('credit-gate')
    expect(toErc8183(job({ minScore: 0 }))!.lost).not.toContain('credit-gate')
  })

  it('an ordinary unclaimed, ungated job loses nothing', () => {
    expect(toErc8183(job())!.lost).toEqual([])
  })
})

describe('roles and payload', () => {
  it('evaluator is the client, which the standard explicitly permits', () => {
    // approveJob reverts NotRequester for anyone else, so requester IS the
    // evaluator. 8183 allows evaluator = client where there is no third-party
    // attester; claiming a separate evaluator would be fiction.
    const out = toErc8183(job({ requester: '0xC1e17' }))!
    expect(out.evaluator).toBe('0xC1e17')
    expect(out.evaluator).toBe(out.client)
  })

  it('provider is the zero address until someone claims it', () => {
    expect(toErc8183(job())!.provider).toBe(ZERO_ADDRESS)
    expect(toErc8183(job({ worker: '0x0000000000000000000000000000000000000000' }))!.provider).toBe(ZERO_ADDRESS)
  })

  it('deliverable carries the result hash, zero until submitted', () => {
    expect(toErc8183(job())!.deliverable).toBe(`0x${'0'.repeat(64)}`)
    const submitted = toErc8183(job({ status: 'Submitted', resultHash: `0x${'ab'.repeat(32)}` }))!
    expect(submitted.deliverable).toBe(`0x${'ab'.repeat(32)}`)
  })

  it('a job with no deadline projects expiredAt 0 rather than inventing one', () => {
    // V1 jobs carry no deadlines. 8183 requires the field; zero is the honest
    // value for "this market never set one".
    expect(toErc8183(job({ deadline: null }))!.expiredAt).toBe(0)
  })
})
