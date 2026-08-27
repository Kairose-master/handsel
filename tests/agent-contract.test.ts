import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  toAgentContract,
  bindingClaims,
  AGENT_CONTRACT_PROTOCOL,
  AGENT_CONTRACT_VERSION,
  type ContractSourceSpec,
  type ContractSourceJob,
} from '@/lib/agent-contract'

function spec(over: Partial<ContractSourceSpec> = {}): ContractSourceSpec {
  return {
    specHash: '0xabc',
    title: 'Azure read',
    description: 'A webhook receiver at 5M/month',
    acceptanceCriteria: 'Every limit quoted from Microsoft Learn with its page.',
    testCode: null,
    testSuiteSlug: null,
    deliverableKind: 'text',
    requiredCapabilities: ['web'],
    briefNonce: 'n1',
    requesterAgentId: 'req',
    workerAgentId: 'wrk',
    onchainJobId: 14,
    onchainContract: '0x9606',
    autoApprove: true,
    testResult: null,
    splitSpec: null,
    ...over,
  }
}

function job(over: Partial<ContractSourceJob> = {}): ContractSourceJob {
  return { id: 14, requester: '0xREQ', worker: '0xWRK', bounty: 1.71, status: 'Submitted', deadline: null, ...over }
}

describe('the sealed/observed boundary', () => {
  // This is the whole claim of the object. The specHash commits nine fields;
  // everything else about a job is true but not committed. A reader who
  // cannot see the line trusts our database exactly as much as the chain
  // while believing they are trusting the chain.
  const c = toAgentContract({ spec: spec(), job: job(), binding: 'sealed' })

  it('marks exactly the fields lib/spec-hash.ts seals as sealed', () => {
    const claims = Object.keys(bindingClaims(c)).sort()
    expect(claims).toEqual(
      [
        'deliverable.kind',
        'deliverable.requiredCapabilities',
        'settlement.parties.0.agentId',
        'task.description',
        'task.title',
        'verification.criteria',
        'verification.hasTestCode',
        'verification.testSuiteSlug',
      ].sort(),
    )
  })

  it('never seals a verdict', () => {
    // A grader that could rewrite the criteria it grades against would be
    // marking its own homework. Criteria are sealed; the verdict is not, and
    // the two must never share a provenance.
    expect(c.verification.criteria.from).toBe('sealed')
    expect(c.verification.verdict.from).toBe('platform')
    expect(c.verification.graderClass.from).toBe('platform')
  })

  it('takes the parties and the money from the chain, not the row', () => {
    // The chain is the authority on who the parties are; the mirror row has
    // been wrong before (docs/failure-modes.md invariant 6).
    const requester = c.settlement.parties.find((p) => p.role === 'requester')!
    expect(requester.address.from).toBe('chain')
    // The requester's AGENT id is sealed (`agent` is in the brief) while its
    // ADDRESS comes from the chain. Two provenances for one party, because
    // they are two different facts committed by two different things.
    expect(requester.agentId.from).toBe('sealed')
    const worker = c.settlement.parties.find((p) => p.role === 'worker')!
    // The worker is not known when the brief is sealed, so nothing about it can be.
    expect(worker.agentId.from).toBe('platform')
    expect(c.settlement.bountyUsd.from).toBe('chain')
    expect(c.settlement.state.from).toBe('chain')
  })
})

describe('a contract for a spec that is not posted yet', () => {
  // The moment a counterparty most wants to read one.
  const c = toAgentContract({ spec: spec({ onchainJobId: null, onchainContract: null }), binding: 'unverifiable' })

  it('reports chain facts as unknown rather than as zero', () => {
    expect(c.settlement.state.value).toBe('unposted')
    expect(c.settlement.parties.find((p) => p.role === 'worker')!.address.value).toBeNull()
    expect(c.acceptance.onSilence.value).toBe('unknown')
  })

  it('still exposes the whole sealed brief', () => {
    // What the worker is being asked to agree to is knowable before anyone
    // escrows anything, which is the point.
    expect(bindingClaims(c)['verification.criteria']).toContain('Microsoft Learn')
  })
})

describe('outcomes that are not verdicts about the worker', () => {
  it('keeps a refused brief distinct from a failure', () => {
    // A refused brief goes on record against the REQUESTER. Flattening it into
    // "failed" writes a verdict about the worker that nobody reached.
    const c = toAgentContract({
      spec: spec({ testResult: { passed: false, refusedBrief: true } }),
      job: job(),
      binding: 'sealed',
    })
    expect(c.verification.outcome.value).toBe('brief-refused')
  })

  it('keeps work nobody could do distinct from work done badly', () => {
    const c = toAgentContract({
      spec: spec({ testResult: { passed: false, workerIncapable: true } }),
      job: job(),
      binding: 'sealed',
    })
    expect(c.verification.outcome.value).toBe('worker-incapable')
  })

  it('reports ungraded as pending, not as failed', () => {
    const c = toAgentContract({ spec: spec({ testResult: { passed: null } }), job: job(), binding: 'sealed' })
    expect(c.verification.verdict.value).toBe('ungraded')
    expect(c.verification.outcome.value).toBe('pending')
  })

  it('surfaces an appeal, because a rewritten verdict is otherwise invisible', () => {
    const c = toAgentContract({
      spec: spec({ testResult: { passed: true, appeal: { originalPassed: false } } }),
      job: job(),
      binding: 'sealed',
    })
    expect(c.verification.appealed.value).toBe(true)
  })
})

describe('reproducibility is not the same question as tampering', () => {
  it('says a row with no nonce cannot be checked at all', () => {
    const c = toAgentContract({ spec: spec({ briefNonce: null }), job: job(), binding: 'unverifiable' })
    expect(c.task.reproducible.value).toBe(false)
    expect(c.binding).toBe('unverifiable')
  })

  it('reports a mismatch as a mismatch', () => {
    const c = toAgentContract({ spec: spec(), job: job(), binding: 'mismatch' })
    expect(c.binding).toBe('mismatch')
  })
})

describe('deadlines', () => {
  it('reports time remaining, not an absolute stamp a reader must localise', () => {
    const c = toAgentContract({
      spec: spec(),
      job: job({ deadline: 1000 + 3600 }),
      binding: 'sealed',
      nowSec: 1000,
    })
    expect(c.acceptance.deadlineInSec.value).toBe(3600)
  })

  it('clamps a lapsed deadline to zero rather than going negative', () => {
    const c = toAgentContract({ spec: spec(), job: job({ deadline: 500 }), binding: 'sealed', nowSec: 1000 })
    expect(c.acceptance.deadlineInSec.value).toBe(0)
  })
})

describe('settlement splits', () => {
  it('names the payees a split creates', () => {
    const c = toAgentContract({
      spec: spec({ splitSpec: { payees: [{ agentId: 'head', address: '0xH', amountUsd: 0.4 }] } }),
      job: job(),
      binding: 'sealed',
    })
    const payee = c.settlement.parties.find((p) => p.role === 'payee')
    expect(payee?.agentId.value).toBe('head')
    expect(payee?.shareUsd?.value).toBe(0.4)
  })

  it('survives a splitSpec shape it does not recognise', () => {
    // splitSpec is jsonb written by several code paths over time. A contract
    // that throws on an old row is unreadable for exactly the jobs most worth
    // auditing.
    for (const bad of [42, 'x', {}, { payees: 'no' }, { payees: [null, 7] }]) {
      expect(() => toAgentContract({ spec: spec({ splitSpec: bad }), job: job(), binding: 'sealed' })).not.toThrow()
    }
  })
})

describe('the envelope', () => {
  it('carries a protocol name and a version', () => {
    const c = toAgentContract({ spec: spec(), job: job(), binding: 'sealed' })
    expect(c.protocol).toBe(AGENT_CONTRACT_PROTOCOL)
    expect(c.version).toBe(AGENT_CONTRACT_VERSION)
  })

  it('reuses the specHash as its id rather than minting a second one', () => {
    // A second identifier is a second thing to disagree about, and this one is
    // already the on-chain commitment.
    const c = toAgentContract({ spec: spec(), job: job(), binding: 'sealed' })
    expect(c.id).toBe('0xabc')
  })
})

describe('the sealed set cannot drift from lib/spec-hash.ts', () => {
  // The object's only real claim is "these fields are committed and those are
  // not". Add a field to SEALED_FIELDS and forget it here and the contract
  // starts under-claiming; drop one and it starts lying. Neither is visible in
  // any other test, so the two lists are compared directly.
  const src = readFileSync('lib/spec-hash.ts', 'utf8').replace(/\0/g, '')
  const block = src.slice(src.indexOf('const SEALED_FIELDS'), src.indexOf('] as const', src.indexOf('const SEALED_FIELDS')))
  const fields = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])

  it('reads the real list', () => {
    expect(fields.length).toBeGreaterThanOrEqual(9)
    expect(fields).toContain('acceptanceCriteria')
  })

  it('accounts for every sealed field', () => {
    // Each brief field maps to exactly one place in the contract. `nonce` is
    // deliberately not exposed: it is the blinding factor, and publishing it
    // for an unposted job would let anyone confirm a guess at the brief.
    const covered: Record<string, string> = {
      title: 'task.title',
      agent: 'settlement.parties.0.agentId',
      nonce: '(withheld — blinding factor; task.reproducible reports only whether we still hold it)',
      description: 'task.description',
      acceptanceCriteria: 'verification.criteria',
      testCode: 'verification.hasTestCode',
      deliverableKind: 'deliverable.kind',
      requiredCapabilities: 'deliverable.requiredCapabilities',
      testSuiteSlug: 'verification.testSuiteSlug',
    }
    const unaccounted = fields.filter((f) => !(f in covered))
    expect(unaccounted, `sealed fields with no home in AgentContract: ${unaccounted.join(', ')}`).toEqual([])
  })

  it('claims nothing as sealed that the hash does not cover', () => {
    const c = toAgentContract({ spec: spec(), job: job(), binding: 'sealed' })
    const claimed = Object.keys(bindingClaims(c))
    const legitimate = new Set([
      'task.title',
      'task.description',
      'verification.criteria',
      'verification.hasTestCode',
      'verification.testSuiteSlug',
      'deliverable.kind',
      'deliverable.requiredCapabilities',
      'settlement.parties.0.agentId',
    ])
    const overclaimed = claimed.filter((k) => !legitimate.has(k))
    expect(overclaimed, `claimed sealed but not in the hash: ${overclaimed.join(', ')}`).toEqual([])
  })
})

describe('the route a counterparty can act on', () => {
  it('says what may be issued from where the trade actually is', () => {
    const c = toAgentContract({ spec: spec(), job: job({ status: 'Accepted' }), binding: 'sealed' })
    expect(c.route.state).toBe('Accepted')
    expect(c.route.issuable).toContain('delivery')
    // Delivery before acknowledgement is the illegal transition the table
    // exists to block; from Accepted it is the expected next move.
    expect(c.route.issuable).not.toContain('acknowledgement')
  })

  it('separates the instruments that move money', () => {
    // The subset a counterparty must have decided about before it acts.
    const c = toAgentContract({ spec: spec(), job: job({ status: 'Open' }), binding: 'sealed' })
    expect(c.route.movesValue).toContain('acknowledgement')
    expect(c.route.movesValue.every((t) => c.route.issuable.includes(t))).toBe(true)
  })

  it('reports a settled trade as terminal rather than as having no options', () => {
    const c = toAgentContract({ spec: spec(), job: job({ status: 'Completed' }), binding: 'sealed' })
    expect(c.route.terminal).toBe(true)
    expect(c.route.issuable).toEqual([])
  })

  it('treats an unposted spec as draft, not as unknown', () => {
    // An unposted spec has real options — it can still be ordered — and
    // calling it unknown would hide them.
    const c = toAgentContract({ spec: spec({ onchainJobId: null }), binding: 'unverifiable' })
    expect(c.route.state).toBe('draft')
    expect(c.route.issuable).toContain('order')
  })
})
