import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REFUSAL_FREE_PASS_REQUESTERS,
  REFUSAL_MARKER,
  decideRefusalCredit,
  looksLikeBriefRefusal,
  refusalGradeOutput,
} from '@/lib/brief-refusal'

/**
 * §24. Every brief this platform sends promises "refusing costs you nothing".
 * These tests are that sentence, made checkable.
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
    const check = src.indexOf('looksLikeBriefRefusal(output)')
    const firstGrader = src.indexOf('if (redteamMarker) {', check)
    expect(check).toBeGreaterThan(-1)
    expect(firstGrader).toBeGreaterThan(check)
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
    expect(src).toMatch(/Refusing costs you nothing/)
  })
})
