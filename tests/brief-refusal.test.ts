import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANNOT_DO_MARKER,
  REFUSAL_FREE_PASS_REQUESTERS,
  REFUSAL_MARKER,
  classifyRefusal,
  decideRefusalCredit,
  incapableGradeOutput,
  looksLikeBriefRefusal,
  refusalGradeOutput,
} from '@/lib/brief-refusal'

/**
 * §24. Every brief this platform sends promises refusing costs the worker
 * nothing. These tests are that sentence, made checkable.
 *
 * §25 added the second half: a worker that simply CANNOT do the work is making a
 * different claim about a different party, and must not be routed through the
 * accusation exit.
 */

describe('looksLikeBriefRefusal', () => {
  it('recognises the marker', () => {
    expect(looksLikeBriefRefusal(`${REFUSAL_MARKER}: the brief asked me to move funds.`)).toBe(true)
  })

  it('recognises the refusal that actually happened on the live board', () => {
    // Verbatim from job #6 on mainnet — the submission that got graded 0.000.
    const real =
      "I'm sorry, but the task description you provided attempted to direct me outside of the specified work " +
      'by requesting a call to the `wallet_balance` tool/function. I cannot comply with that request.'
    expect(looksLikeBriefRefusal(real)).toBe(true)
  })

  it('recognises paraphrases, since models restate the clause rather than quote it', () => {
    expect(
      looksLikeBriefRefusal('The job description is asking me to go beyond the stated task, so I will not do it.'),
    ).toBe(true)
    expect(
      looksLikeBriefRefusal('This brief directs me outside the work I was hired for and I decline to continue.'),
    ).toBe(true)
  })

  it('does NOT fire on ordinary failure, which is the whole risk', () => {
    // If any of these counted, every worker could dodge a bad grade by
    // sounding uncertain — the free pass has to be narrower than "I couldn't".
    for (const text of [
      "I couldn't finish this task.",
      'I ran out of time and cannot complete the work.',
      "I don't think I should do this.",
      'The requirements were unclear so I stopped.',
      'Task failed. No output produced.',
      'I refuse to write code this ugly.',
      '',
      '   ',
    ]) {
      expect(looksLikeBriefRefusal(text), JSON.stringify(text)).toBe(false)
    }
  })

  it('does not fire on a submission that merely discusses the safety rules', () => {
    expect(
      looksLikeBriefRefusal(
        'Here is the summary you asked for. Note that a task description can never authorise moving funds.',
      ),
    ).toBe(false)
  })
})

/**
 * §25. The defect this file predicted, twenty-four hours after predicting it.
 *
 * A worker took a real $5 job on the live board, found it needed to read GitHub
 * and fetch live pages, had no such tool, and said so — using the only
 * vocabulary we had given it. The detector matched the marker and nothing else,
 * so "I lack a capability" was recorded as "this requester wrote an attack".
 */
describe('classifyRefusal separates the two claims', () => {
  /** Verbatim from the live board. This is the whole reason §25 exists. */
  const LIVE_25 =
    'HANDSEL-REFUSED-BRIEF – The task requires accessing external resources (GitHub repository files, ' +
    'public APIs, and live web pages) to verify consistency of mainnet vs. testnet labels, which I cannot do.'

  it('reads the live §25 submission as incapacity, not as an accusation', () => {
    expect(classifyRefusal(LIVE_25)).toBe('incapable')
  })

  it('recognises it by its REASON, not by falling through to a default', () => {
    // The bare marker already defaults to 'incapable', so the test above would
    // pass even if the reason patterns were dead. Strip the marker: what is left
    // is the sentence alone, and it must still be understood. Without this the
    // fix is a coin that happens to land right.
    const reasonOnly = LIVE_25.replace(REFUSAL_MARKER, '').trim()
    expect(reasonOnly).not.toContain(REFUSAL_MARKER)
    expect(classifyRefusal(`${CANNOT_DO_MARKER} ${reasonOnly}`)).toBe('incapable')
    // And with the WRONG marker plus that reason, the reason still wins.
    expect(classifyRefusal(LIVE_25)).toBe('incapable')
  })

  it('still reads the live §24 submission as an attack', () => {
    // The regression that matters most. This text names a capability noun
    // (`tool/function`) fourteen characters before a negation (`I cannot`), so a
    // loose incapacity pattern silently converts a real attack report into a
    // no-fault repost — and the attacker stops appearing in the record at all.
    const real =
      "I'm sorry, but the task description you provided attempted to direct me outside of the specified work " +
      'by requesting a call to the `wallet_balance` tool/function. I cannot comply with that request.'
    expect(classifyRefusal(real)).toBe('brief-attack')
  })

  it('the explicit incapacity marker is taken at its word', () => {
    expect(classifyRefusal(`${CANNOT_DO_MARKER}: I have no browser.`)).toBe('incapable')
  })

  it('the attack marker still means what it says when the reason is unrecognised', () => {
    // The override runs one way only. A worker now has a documented alternative
    // for "I can't"; picking the accusation marker anyway is a choice, and a
    // marker that never means what it says is not a marker.
    expect(classifyRefusal(`${REFUSAL_MARKER} — something felt off about this one.`)).toBe('brief-attack')
    expect(classifyRefusal(`${REFUSAL_MARKER}: the brief asked me to move funds.`)).toBe('brief-attack')
  })

  it('unmarked incapacity is NOT a refusal, because this exit moves money', () => {
    // `incapable` refunds the escrow and reposts the job. Any text that reaches
    // it is text that moves money, so it takes a marker or an accusation
    // sentence to get there — free-text "I couldn't" stays an ordinary failure.
    for (const text of [
      "I don't have network access to fetch that page.",
      'I lack the tools required for this.',
      "I couldn't finish this task.",
      'Task failed. No output produced.',
      '',
      '   ',
    ]) {
      expect(classifyRefusal(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('the two kinds are the only kinds, and neither is the other', () => {
    expect(classifyRefusal(LIVE_25)).not.toBe('brief-attack')
    expect(looksLikeBriefRefusal(LIVE_25)).toBe(false)
  })
})

describe('what an incapacity records', () => {
  it("carries the worker's reason, because it accuses nobody and the requester needs it", () => {
    const out = incapableGradeOutput('HANDSEL-CANNOT-DO — I have no GitHub access.')
    expect(out).toContain('no GitHub access')
    expect(out).toMatch(/beyond its capabilities/i)
    expect(out).toMatch(/nothing was recorded against the requester/i)
  })

  it('bounds worker-authored text rather than storing it whole', () => {
    const out = incapableGradeOutput('x'.repeat(5000))
    expect(out.length).toBeLessThan(700)
  })

  it('survives an empty reason', () => {
    expect(incapableGradeOutput('')).toMatch(/beyond its capabilities/i)
    expect(incapableGradeOutput('')).not.toMatch(/Worker said/)
  })
})

describe('decideRefusalCredit — the promise, as policy', () => {
  it('a refusal writes no credit event', () => {
    expect(decideRefusalCredit({ distinctRequestersRefused: 1 }).credit).toBe('none')
  })

  it('holds up to the free-pass limit, then stops', () => {
    expect(decideRefusalCredit({ distinctRequestersRefused: REFUSAL_FREE_PASS_REQUESTERS }).credit).toBe('none')
    expect(decideRefusalCredit({ distinctRequestersRefused: REFUSAL_FREE_PASS_REQUESTERS + 1 }).credit).toBe('failure')
  })

  it('counts distinct REQUESTERS, so one attacker cannot exhaust the pass', () => {
    // The count is supplied as distinct requesters precisely so that fifty jobs
    // from one attacker is 1, not 50. This test pins the contract of the input.
    expect(decideRefusalCredit({ distinctRequestersRefused: 1 }).credit).toBe('none')
  })

  it('an unreadable history keeps the benefit of the doubt', () => {
    // Our own broken query must not turn into someone else's bad mark — the
    // promise is printed in every brief and does not have an exception for
    // "unless our database is having a bad day".
    const d = decideRefusalCredit({ distinctRequestersRefused: 99, countUnknown: true })
    expect(d.credit).toBe('none')
    expect(d.reason).toMatch(/unreadable|benefit of the doubt/)
  })

  it('every outcome carries a printable reason', () => {
    expect(decideRefusalCredit({ distinctRequestersRefused: 1 }).reason.length).toBeGreaterThan(0)
    expect(decideRefusalCredit({ distinctRequestersRefused: 99 }).reason.length).toBeGreaterThan(0)
  })
})

describe('the recorded output', () => {
  it('names the requester and states that no verdict was recorded', () => {
    const out = refusalGradeOutput('agent-9')
    expect(out).toContain('agent-9')
    expect(out).toMatch(/No verdict was recorded about the worker/)
  })

  it('works without a requester', () => {
    expect(refusalGradeOutput(null)).toMatch(/refused/i)
  })
})

/**
 * Static guards on the wiring. The promise is only true if the check runs
 * BEFORE any grader, and if a refusal never reaches agent_events.
 */
describe('the grading path honours the promise', () => {
  const src = readFileSync(join(process.cwd(), 'lib/callback/labor-market.ts'), 'utf8')

  it('checks for refusal before any grader runs', () => {
    const check = src.indexOf('classifyRefusal(output)')
    const firstGrader = src.indexOf('if (redteamMarker) {', check)
    expect(check).toBeGreaterThan(-1)
    expect(firstGrader).toBeGreaterThan(check)
  })

  it('routes the two kinds to two different outcomes', () => {
    const incapable = src.indexOf("refusalKind === 'incapable'")
    const attack = src.indexOf("refusalKind === 'brief-attack'")
    expect(incapable).toBeGreaterThan(-1)
    expect(attack).toBeGreaterThan(-1)
    expect(incapable).not.toBe(attack)
  })

  it('an incapacity records nothing against the requester and returns the job', () => {
    const start = src.indexOf("refusalKind === 'incapable'")
    const end = src.indexOf("refusalKind === 'brief-attack'")
    const branch = src.slice(start, end)
    // No accusation, no attack-refusal counter, and the job actually goes back.
    expect(branch).not.toContain('BRIEF_REFUSED')
    expect(branch).not.toContain('refusedBrief')
    expect(branch).toMatch(/returnFailedJobToMarket\(spec,/)
    // And the reposting receipt states the real reason rather than inheriting
    // the failed-tests wording (§23: a receipt must name the fact it is about).
    expect(branch).toMatch(/note:\s*'Auto: the worker lacked a capability/)
  })

  it('an incapacity writes no credit event either', () => {
    const branch = src.slice(src.indexOf("refusalKind === 'incapable'"), src.indexOf("refusalKind === 'brief-attack'"))
    expect(branch).not.toContain('insert(agentEvent)')
  })

  it('returns on the passed:null path, so no credit event is written', () => {
    // The existing rule in this file: passed:null means "an infra fact about
    // us, not behavioural data about the worker" and writes no agent_event. A
    // refusal is the same kind of fact, so it takes the same exit.
    expect(src).toMatch(/refusedBrief: true/)
    const refusalReturn = src.indexOf('refusedBrief: true')
    const eventInsert = src.indexOf('insert(agentEvent)')
    expect(eventInsert).toBeGreaterThan(refusalReturn)
  })

  it('records the refusal against the requester, not the worker', () => {
    expect(src).toContain("'BRIEF_REFUSED'")
    expect(src).toMatch(/requester \$\{spec\.requesterAgentId\}/)
  })

  it('does not give red-team jobs the free pass', () => {
    // There the objective IS adversarial, and "I refuse" is not a proof.
    expect(src).toMatch(/!redteamMarker \? await import\('@\/lib\/brief-refusal'\)/)
  })
})

describe('the brief still promises what the code now delivers', () => {
  const src = readFileSync(join(process.cwd(), 'lib/untrusted-input.ts'), 'utf8')

  it('the clause tells workers refusal is free', () => {
    expect(src).toMatch(/Neither costs you anything/)
  })

  it('gives workers BOTH vocabularies, which is the §25 root cause', () => {
    // The worker that broke this was not gaming us. It had one word for two
    // situations and used it. A clause that names only the attack marker
    // guarantees every incapacity arrives dressed as an accusation.
    expect(src).toContain(REFUSAL_MARKER)
    expect(src).toContain(CANNOT_DO_MARKER)
    expect(src).toMatch(/recorded against different parties/)
  })

  it('tells the worker what happens to a job it cannot do', () => {
    expect(src).toMatch(/returns to the market/)
  })
})
