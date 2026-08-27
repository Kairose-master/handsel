import { describe, it, expect } from 'vitest'
import {
  CODEX,
  CASE_STATE_MEANING,
  LAYERS,
  RETRY_CLASSES,
  layerOf,
  impliesWorkerFault,
  openCase,
  appendFinding,
  governingCode,
  caseState,
  disposition,
  retryClassFor,
  establishesResponsibility,
} from '@/lib/adjudication'

const AT = '2026-08-28T00:00:00.000Z'
const opened = () => openCase({ caseId: 'c1', observedCode: 'OBS.DEADLINE_EXCEEDED', at: AT })

describe('only WRK.* means the worker', () => {
  // Charging policy, infrastructure, evidence, a judge or an attacker to the
  // worker is how an outage becomes someone's penalty.
  it('refuses to read any other layer as worker fault', () => {
    for (const code of Object.keys(CODEX)) {
      const isWrk = code.startsWith('WRK.')
      expect(impliesWorkerFault(code), code).toBe(isWrk)
    }
  })

  it('does not treat a timeout as a failure of the work', () => {
    // gRPC's own warning: a state-changing call may have SUCCEEDED with only
    // the response arriving late. An observation is not an outcome.
    expect(impliesWorkerFault('OBS.DEADLINE_EXCEEDED')).toBe(false)
  })

  it('does not treat a permission block as a failure of the work', () => {
    expect(impliesWorkerFault('POL.PERMISSION_DENIED')).toBe(false)
    expect(CODEX['POL.PERMISSION_DENIED'].state).toBe('POLICY_BLOCKED')
  })

  it('does not treat verifier trouble as worker trouble', () => {
    for (const c of ['VRF.DISAGREEMENT', 'VRF.COMPROMISED', 'VRF.INCONCLUSIVE']) {
      expect(impliesWorkerFault(c), c).toBe(false)
    }
  })

  it('does not treat a suspected attack as a guilty worker', () => {
    // SECURITY_SUSPECTED is not MALICIOUS_WORKER. The attacker may be neither
    // party.
    for (const c of ['SEC.PROMPT_INJECTION', 'SEC.SYBIL_SUSPECTED', 'SEC.COLLUSION_SUSPECTED']) {
      expect(impliesWorkerFault(c), c).toBe(false)
      expect(CASE_STATE_MEANING[CODEX[c].state].workerAtFault).toBe('undetermined')
    }
  })
})

describe('observation survives every later interpretation', () => {
  it('keeps the observed code when a cause is attributed', () => {
    const f = appendFinding(opened(), { at: AT, kind: 'attributed', code: 'INF.UNAVAILABLE' })
    expect(f.observedCode).toBe('OBS.DEADLINE_EXCEEDED')
    expect(f.attributedCode).toBe('INF.UNAVAILABLE')
    expect(f.attributionStatus).toBe('ESTABLISHED')
  })

  it('appends rather than replaces', () => {
    let f = opened()
    f = appendFinding(f, { at: AT, kind: 'diagnosed', code: 'INF.UNAVAILABLE' })
    f = appendFinding(f, { at: AT, kind: 'attributed', code: 'WRK.REQUIREMENT_NOT_MET' })
    expect(f.events.map((e) => e.kind)).toEqual(['observed', 'diagnosed', 'attributed'])
    expect(f.events[0].code).toBe('OBS.DEADLINE_EXCEEDED')
  })

  it('lets the same observation reach four different causes', () => {
    // The doc's own fan-out: reconcile, infrastructure, policy, or the worker.
    for (const cause of ['INF.UNAVAILABLE', 'POL.PERMISSION_DENIED', 'WRK.REQUIREMENT_NOT_MET']) {
      const f = appendFinding(opened(), { at: AT, kind: 'attributed', code: cause })
      expect(f.observedCode).toBe('OBS.DEADLINE_EXCEEDED')
      expect(governingCode(f)).toBe(cause)
    }
  })

  it('treats an appeal as a compensating event, not a deletion', () => {
    // A verdict whose history you cannot see is indistinguishable from one
    // nobody questioned.
    let f = appendFinding(opened(), { at: AT, kind: 'attributed', code: 'WRK.REQUIREMENT_NOT_MET' })
    f = appendFinding(f, { at: AT, kind: 'compensated', code: 'INF.UNAVAILABLE', note: 'appeal upheld' })
    expect(f.events).toHaveLength(3)
    expect(f.events.some((e) => e.code === 'WRK.REQUIREMENT_NOT_MET')).toBe(true)
    expect(governingCode(f)).toBe('INF.UNAVAILABLE')
  })

  it('does not mutate the file it was given', () => {
    const before = opened()
    appendFinding(before, { at: AT, kind: 'attributed', code: 'INF.UNAVAILABLE' })
    expect(before.attributedCode).toBeNull()
    expect(before.events).toHaveLength(1)
  })
})

describe('an unattributed observation is inconclusive, not a failure', () => {
  it('holds a bare timeout rather than resolving it', () => {
    const f = opened()
    expect(f.attributionStatus).toBe('UNDETERMINED')
    expect(caseState(f)).toBe('INCONCLUSIVE')
    expect(disposition(f).moneyMoves).toBe('held')
    expect(disposition(f).workerAtFault).toBe('undetermined')
  })

  it('distinguishes "not yet decided" from "no fault"', () => {
    // Null attribution is not innocence and must not read as it.
    expect(opened().attributedCode).toBeNull()
    expect(disposition(opened()).workerAtFault).toBe('undetermined')
  })

  it('resolves once responsibility is established', () => {
    const f = appendFinding(opened(), { at: AT, kind: 'attributed', code: 'WRK.REQUIREMENT_NOT_MET' })
    expect(caseState(f)).toBe('ATTRIBUTED_FAIL')
    expect(disposition(f)).toEqual({ moneyMoves: 'refunds', workerAtFault: true })
  })

  it('lets a policy block resolve without attribution, since it happened before the work', () => {
    const f = openCase({ caseId: 'c2', observedCode: 'POL.PERMISSION_DENIED', at: AT })
    expect(caseState(f)).toBe('POLICY_BLOCKED')
    expect(disposition(f).moneyMoves).toBe('no')
  })
})

describe('what to do is separate from what it is', () => {
  it('never blind-retries after a timeout', () => {
    // The state-changing call may already have landed, so re-running a
    // non-idempotent job is how one payment becomes two.
    expect(retryClassFor('OBS.DEADLINE_EXCEEDED')).toBe('RECONCILE_FIRST')
  })

  it('backs off on somebody else’s outage', () => {
    expect(retryClassFor('INF.UNAVAILABLE')).toBe('SAFE_BACKOFF')
  })

  it('sends a disagreement to a different verifier, not the same one again', () => {
    for (const c of ['VRF.DISAGREEMENT', 'VRF.INCONCLUSIVE']) {
      expect(retryClassFor(c), c).toBe('NEW_VERIFIER')
    }
  })

  it('escalates rather than retrying anything security-shaped', () => {
    for (const c of ['EVD.INTEGRITY_FAILED', 'SEC.PROMPT_INJECTION', 'VRF.COMPROMISED']) {
      expect(retryClassFor(c), c).toBe('NO_RETRY_ESCALATE')
    }
  })

  it('escalates an unknown code rather than retrying it', () => {
    expect(retryClassFor('WHO.KNOWS')).toBe('NO_RETRY_ESCALATE')
  })
})

describe('evidence carries three judgments and a hash settles one', () => {
  it('does not let authenticity alone establish responsibility', () => {
    // Authenticating a record by hash establishes that the file is the file —
    // not who wrote it, and not whether what it says is true.
    expect(
      establishesResponsibility({ authenticity: 'verified', admissibility: 'undetermined', weight: 'undetermined' }),
    ).toBe(false)
    expect(
      establishesResponsibility({ authenticity: 'verified', admissibility: 'admissible', weight: 'weak' }),
    ).toBe(false)
  })

  it('requires all three', () => {
    expect(
      establishesResponsibility({ authenticity: 'verified', admissibility: 'admissible', weight: 'strong' }),
    ).toBe(true)
  })

  it('never establishes anything on unchecked authenticity', () => {
    expect(
      establishesResponsibility({ authenticity: 'unchecked', admissibility: 'admissible', weight: 'strong' }),
    ).toBe(false)
  })
})

describe('the codex', () => {
  it('gives every code a declared layer that matches its prefix', () => {
    for (const [code, v] of Object.entries(CODEX)) {
      expect(LAYERS, code).toHaveProperty(v.layer)
      expect(layerOf(code), code).toBe(v.layer)
    }
  })

  it('gives every code a retry class and a resting state', () => {
    for (const [code, v] of Object.entries(CODEX)) {
      expect(RETRY_CLASSES, code).toContain(v.retry)
      expect(CASE_STATE_MEANING, code).toHaveProperty(v.state)
      expect(v.means.length, `${code} needs a definition`).toBeGreaterThan(10)
    }
  })

  it('stays small — the layers do the work a long list would', () => {
    expect(Object.keys(CODEX).length).toBeLessThanOrEqual(25)
  })

  it('keeps worker fault and money movement independent', () => {
    // Neither column is derivable from the other: a no-fault cancellation
    // refunds, and a settlement block holds money with nobody at fault.
    expect(CASE_STATE_MEANING.NO_FAULT_CANCELLED).toMatchObject({ workerAtFault: false, moneyMoves: 'refunds' })
    expect(CASE_STATE_MEANING.SETTLEMENT_BLOCKED).toMatchObject({ workerAtFault: false, moneyMoves: 'held' })
    expect(CASE_STATE_MEANING.PROVISIONAL_PASS).toMatchObject({ workerAtFault: false, moneyMoves: 'held' })
  })

  it('separates a blocked payment from a failed judgment', () => {
    // "Judged, but the rail refused" is not a verdict about anyone.
    expect(CODEX['ECO.SETTLEMENT_FAILED'].state).toBe('SETTLEMENT_BLOCKED')
    expect(impliesWorkerFault('ECO.SETTLEMENT_FAILED')).toBe(false)
  })
})
