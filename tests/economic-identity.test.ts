import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
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
