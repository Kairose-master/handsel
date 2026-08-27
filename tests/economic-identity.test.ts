import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  channelOf,
  sameAuthor,
  independenceOf,
  sharesController,
  strongestControlKey,
  CONTROL_LEVELS,
  type Controller,
} from '@/lib/economic-identity'

function ctrl(over: Partial<Controller> & Pick<Controller, 'agentId'>): Controller {
  return { operatorId: null, organizationId: null, organizationLink: null, ...over }
}

const BUYER = ctrl({ agentId: 'a-buy', operatorId: 'u1' })
const SELLER = ctrl({ agentId: 'a-sell', operatorId: 'u2' })

describe('verifier independence, at every level of the chain', () => {
  it('catches a verifier that is a party', () => {
    expect(independenceOf({ buyer: BUYER, seller: SELLER, verifier: BUYER })).toMatchObject({
      verdict: 'conflicted',
      level: 'agent',
    })
  })

  it('catches a verifier on a party’s account', () => {
    // A different agent of the same owner. This is the case Handsel could not
    // see before: two agent ids, one controller.
    const v = ctrl({ agentId: 'a-v', operatorId: 'u2' })
    expect(independenceOf({ buyer: BUYER, seller: SELLER, verifier: v })).toMatchObject({
      verdict: 'conflicted',
      level: 'operator',
    })
  })

  it('catches a verifier in a party’s organisation', () => {
    // Two accounts, one organisation. A userId-only check clears this, which
    // is why the chain has a third link.
    const seller = ctrl({ agentId: 'a-sell', operatorId: 'u2', organizationId: 'acme', organizationLink: 'claimed' })
    const v = ctrl({ agentId: 'a-v', operatorId: 'u3', organizationId: 'acme', organizationLink: 'claimed' })
    expect(independenceOf({ buyer: BUYER, seller, verifier: v })).toMatchObject({
      verdict: 'conflicted',
      level: 'organization',
    })
  })

  it('believes an unattested conflict', () => {
    // The asymmetry. A declared tie NARROWS what the declarer may do, so it
    // is an admission against interest and is taken at face value. Requiring
    // attestation here would let anyone clear themselves by not registering.
    const seller = ctrl({ agentId: 's', operatorId: 'u2', organizationId: 'acme', organizationLink: 'claimed' })
    const v = ctrl({ agentId: 'v', operatorId: 'u3', organizationId: 'acme', organizationLink: 'claimed' })
    expect(independenceOf({ buyer: BUYER, seller, verifier: v }).verdict).toBe('conflicted')
  })

  it('clears only when all three controllers are known', () => {
    const v = ctrl({ agentId: 'a-v', operatorId: 'u3' })
    expect(independenceOf({ buyer: BUYER, seller: SELLER, verifier: v }).verdict).toBe('independent')
  })

  it('returns unknown — never independent — when a party cannot be resolved', () => {
    // An unresolvable party is the case an attacker arranges, so silence must
    // not read as separation.
    const anon = ctrl({ agentId: 'a-anon' })
    expect(independenceOf({ buyer: anon, seller: SELLER, verifier: ctrl({ agentId: 'v', operatorId: 'u3' }) }).verdict).toBe('unknown')
    expect(independenceOf({ buyer: BUYER, seller: SELLER, verifier: anon }).verdict).toBe('unknown')
  })

  it('names the level it decided at, so a refusal can be argued with', () => {
    const r = independenceOf({ buyer: BUYER, seller: SELLER, verifier: BUYER })
    expect(r.level).toBe('agent')
    expect(r.why).toBeTruthy()
  })

  it('checks every declared level', () => {
    // A level added to CONTROL_LEVELS and not to the check would be a silent
    // hole exactly where an attacker looks.
    const src = readFileSync('lib/economic-identity.ts', 'utf8')
    const body = src.slice(src.indexOf('export function independenceOf'))
    for (const level of CONTROL_LEVELS) {
      expect(body, `independenceOf never decides at level ${level}`).toContain(`'${level}'`)
    }
  })
})

describe('sharesController', () => {
  it('is a tri-state, so a caller cannot read unknown as no', () => {
    expect(sharesController(BUYER, ctrl({ agentId: 'x' }))).toBe('unknown')
  })

  it('matches at the account level', () => {
    expect(sharesController(BUYER, ctrl({ agentId: 'other', operatorId: 'u1' }))).toBe('yes')
  })

  it('matches at the organisation level across accounts', () => {
    const a = ctrl({ agentId: 'a', operatorId: 'u1', organizationId: 'acme' })
    const b = ctrl({ agentId: 'b', operatorId: 'u9', organizationId: 'acme' })
    expect(sharesController(a, b)).toBe('yes')
  })

  it('separates two fully-resolved, unrelated controllers', () => {
    expect(sharesController(BUYER, SELLER)).toBe('no')
  })
})

describe('strongestControlKey', () => {
  it('prefers the organisation over the account', () => {
    expect(strongestControlKey(ctrl({ agentId: 'a', operatorId: 'u1', organizationId: 'acme' }))).toBe('org:acme')
  })

  it('namespaces, so an org id cannot collide with an operator id', () => {
    // Comparing these strings decides whether a verdict counts; a collision
    // would silently merge two unrelated controllers.
    expect(strongestControlKey(ctrl({ agentId: 'a', operatorId: 'acme' }))).toBe('op:acme')
    expect(strongestControlKey(ctrl({ agentId: 'a', operatorId: 'x', organizationId: 'acme' }))).toBe('org:acme')
  })

  it('never falls back to the agent id', () => {
    // An agent is the thing being controlled. Falling back to it would report
    // every pair of agents as different controllers — the answer that clears
    // an attacker.
    expect(strongestControlKey(ctrl({ agentId: 'a' }))).toBeNull()
  })
})

describe('an operator cannot attest to its own membership', () => {
  const src = readFileSync('lib/economic-identity.ts', 'utf8')

  it('defaults a declared link to claimed', () => {
    expect(src).toContain("input.strength ?? 'claimed'")
  })

  it('never gates a conflict finding on attestation', () => {
    // Gating here is the hole: everyone stays unattested and every check
    // clears.
    // Comments stripped: the code carries a note explaining that it is
    // deliberately NOT gated on attestation, and asserting over prose would
    // fail on the very sentence that documents the rule.
    const body = src
      .slice(src.indexOf('export function independenceOf'), src.indexOf('export function sharesController'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(body).not.toContain('attested')
  })
})

describe('different agent is not different author', () => {
  // The case the on-chain address comparison misses entirely, and the one
  // Handsel makes routine: an agent with no runtime cannot work on its own,
  // so a person's model session writes for it through claim_job. One
  // conversation can therefore be the author of every "different agent" in an
  // office, and peer review is where that matters.
  const sess = (agentId: string, operatorId: string | null) => ({
    controller: ctrl({ agentId, operatorId }),
    channel: 'session' as const,
  })

  it('catches two runtime-less agents on one account', () => {
    // Architect and Red Team: different ids, different on-chain addresses,
    // same author.
    expect(sameAuthor(sess('architect', 'u1'), sess('redteam', 'u1'))).toBe('yes')
  })

  it('clears two session agents on genuinely different accounts', () => {
    expect(sameAuthor(sess('a', 'u1'), sess('b', 'u2'))).toBe('no')
  })

  it('clears a real runtime, even on the same account', () => {
    // A cloud or MCP worker is driven by Handsel itself, so it is its own
    // author regardless of who owns it.
    const mcp = { controller: ctrl({ agentId: 'reader', operatorId: 'u1' }), channel: 'mcp' as const }
    expect(sameAuthor(sess('architect', 'u1'), mcp)).toBe('no')
  })

  it('is yes for the same agent whatever the channel', () => {
    const a = { controller: ctrl({ agentId: 'x', operatorId: 'u1' }), channel: 'cloud' as const }
    expect(sameAuthor(a, a)).toBe('yes')
  })

  it('returns unknown — never no — when a channel cannot be resolved', () => {
    // An unresolvable channel is the arrangement an attacker would choose.
    const un = { controller: ctrl({ agentId: 'y', operatorId: 'u2' }), channel: 'unknown' as const }
    expect(sameAuthor(sess('architect', 'u1'), un)).toBe('unknown')
  })
})

describe('channelOf', () => {
  it('treats a runtime Handsel can drive as its own author', () => {
    for (const rt of ['cloud', 'mcp', 'webhook', 'local'] as const) {
      expect(channelOf(rt)).toBe(rt)
    }
  })

  it('treats a runtime-less agent as session-authored', () => {
    // 'platform' means no cloud key, no MCP server, nothing to poll — the only
    // way it ever produces work is a person driving the connector.
    expect(channelOf('platform')).toBe('session')
  })

  it('does not guess at an unrecognised runtime', () => {
    expect(channelOf(null)).toBe('unknown')
    expect(channelOf('something-new')).toBe('unknown')
  })
})

describe('the peer-review gate uses it', () => {
  const del = readFileSync('lib/delegation.ts', 'utf8')
  const gate = del.slice(del.indexOf('const sameAddress = Boolean('), del.indexOf('const samePerson = sameAddress'))

  it('no longer decides on the address alone', () => {
    expect(gate).toContain('sameAuthor')
    expect(gate).toContain('sameAuthorVerdict')
  })

  it('discards the review when authorship cannot be established', () => {
    const after = del.slice(del.indexOf('const samePerson = sameAddress'))
    expect(after.slice(0, 120)).toContain("sameAuthorVerdict !== 'no'")
  })

  it('resolves the worker from the chain, not from a mirror row', () => {
    expect(gate).toContain('targetJob.worker')
    expect(gate).toContain('smartAccountAddress')
  })

  it('says which kind of collision it found', () => {
    // "Discarded" without a reason sends the owner looking for a bug that is
    // not there; the three cases need different follow-up.
    const noteAt = del.indexOf('target.reviewNote = samePerson')
    const note = del.slice(noteAt, del.indexOf('target.awaitingReview = false', noteAt))
    expect(note).toMatch(/own work/)
    expect(note).toMatch(/could not establish/)
    expect(note).toMatch(/same author/)
  })
})
