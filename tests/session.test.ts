import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  CRITERIA_MESSAGE_CHARS,
  DEFAULT_MAX_TURNS,
  DEFAULT_WALL_MS,
  EARLIER_OUTPUT_EXCERPT,
  LAST_OUTPUT_EXCERPT,
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  MAX_TURN_WINDOW_S,
  MAX_WALL_MS,
  MIN_TURN_USD,
  MIN_TURN_WINDOW_S,
  MIN_WALL_MS,
  OPEN_REFUSAL_TEXT,
  SAY_REFUSAL_TEXT,
  autoClose,
  canOpenSession,
  canSay,
  renderSession,
  turnBrief,
  turnOutcomeFrom,
  turnWindowSec,
  type Session,
  type Turn,
} from '@/lib/session'
import { POSTING_FEE_BPS, POSTING_FEE_FLAT_USD } from '@/lib/repo-job-templates'
import { TOOLS } from '@/lib/mcp/tools-manifest'

const NOW = Date.parse('2026-09-02T12:00:00Z')
const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses-test',
  title: 'Q3 memo',
  standingCriteria: 'Plain English, cites the source for every figure, under 400 words.',
  turnPriceUsd: 2,
  maxTurns: 3,
  wallDeadline: new Date(NOW + 60 * 60 * 1000).toISOString(),
  requesterAgentId: 'agent-req',
  workerAgentId: null,
  status: 'open',
  closedBy: null,
  openedAt: new Date(NOW - 60_000).toISOString(),
  ...over,
})
const turn = (seq: number, over: Partial<Turn> = {}): Turn => ({
  seq,
  specHash: `0x${seq}`,
  message: `message ${seq}`,
  postedAt: new Date(NOW - 30_000).toISOString(),
  outcome: 'passed',
  output: `delivered ${seq}`,
  onchainJobId: 100 + seq,
  ...over,
})

describe('opening a session', () => {
  const open = (over = {}) => canOpenSession({ title: 'T', standingCriteria: 'ten chars or more', turnPriceUsd: 2, maxTurns: 5, wallMs: DEFAULT_WALL_MS, ...over })

  it('accepts a sane request', () => expect(open()).toEqual({ ok: true }))

  it('the turn floor is where the posting fee stops eating the turn', () => {
    // At $1 the fee is 5% + $0.03 = 8%. At $0.10 it would be 35%.
    const feeAt = (usd: number) => (usd * POSTING_FEE_BPS) / 10_000 + POSTING_FEE_FLAT_USD
    expect(feeAt(MIN_TURN_USD) / MIN_TURN_USD).toBeLessThan(0.1)
    expect(feeAt(0.1) / 0.1).toBeGreaterThan(0.3)
    expect(open({ turnPriceUsd: 0.5 })).toMatchObject({ ok: false, reason: 'price' })
    expect(OPEN_REFUSAL_TEXT.price).toContain('5% + $0.03')
  })

  it('bounds turns and the wall clock, and demands gradeable criteria', () => {
    expect(open({ maxTurns: 0 })).toMatchObject({ ok: false, reason: 'turns' })
    expect(open({ maxTurns: MAX_TURNS + 1 })).toMatchObject({ ok: false, reason: 'turns' })
    expect(open({ wallMs: MIN_WALL_MS - 1 })).toMatchObject({ ok: false, reason: 'wall' })
    expect(open({ wallMs: MAX_WALL_MS + 1 })).toMatchObject({ ok: false, reason: 'wall' })
    expect(open({ standingCriteria: 'short' })).toMatchObject({ ok: false, reason: 'criteria' })
    expect(open({ title: '  ' })).toMatchObject({ ok: false, reason: 'title' })
    expect(DEFAULT_MAX_TURNS).toBeLessThanOrEqual(MAX_TURNS)
  })
})

describe('speaking', () => {
  it('the first turn of an open session', () => {
    const r = canSay({ session: session(), turns: [], now: NOW, message: '  write the memo  ' })
    expect(r).toMatchObject({ ok: true, message: 'write the memo', seq: 1 })
  })

  it('one turn at a time — and says what to do instead', () => {
    for (const outcome of ['posted', 'working'] as const) {
      const r = canSay({ session: session(), turns: [turn(1, { outcome })], now: NOW, message: 'next' })
      expect(r, outcome).toMatchObject({ ok: false, reason: 'turn-open' })
    }
    expect(SAY_REFUSAL_TEXT['turn-open']).toContain('note_to_worker')
  })

  it('continues after a failed turn as well as a passed one — a failed turn cost the requester nothing', () => {
    for (const outcome of ['passed', 'failed', 'expired'] as const) {
      const r = canSay({ session: session(), turns: [turn(1, { outcome })], now: NOW, message: 'next' })
      expect(r, outcome).toMatchObject({ ok: true, seq: 2 })
    }
  })

  it('stops at the turn budget, the wall, and the runway floor', () => {
    expect(canSay({ session: session({ maxTurns: 1 }), turns: [turn(1)], now: NOW, message: 'x' })).toMatchObject({ ok: false, reason: 'turns-spent' })
    expect(canSay({ session: session(), turns: [], now: NOW + 2 * 60 * 60 * 1000, message: 'x' })).toMatchObject({ ok: false, reason: 'wall-elapsed' })
    const late = NOW + 60 * 60 * 1000 - (MIN_TURN_WINDOW_S - 60) * 1000
    expect(canSay({ session: session(), turns: [], now: late, message: 'x' })).toMatchObject({ ok: false, reason: 'no-runway' })
    expect(canSay({ session: session({ status: 'closed', closedBy: 'requester' }), turns: [], now: NOW, message: 'x' })).toMatchObject({ ok: false, reason: 'closed' })
    expect(canSay({ session: session(), turns: [], now: NOW, message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) })).toMatchObject({ ok: false, reason: 'too-long' })
    expect(canSay({ session: session(), turns: [], now: NOW, message: ' ' })).toMatchObject({ ok: false, reason: 'empty' })
  })

  it("a turn's delivery window never outruns the wall and never exceeds a normal job's", () => {
    expect(turnWindowSec(session(), NOW)).toBe(60 * 60)
    expect(turnWindowSec(session({ wallDeadline: new Date(NOW + MAX_WALL_MS).toISOString() }), NOW)).toBe(MAX_TURN_WINDOW_S)
    expect(turnWindowSec(session(), NOW + 60 * 60 * 1000 - 5 * 60 * 1000)).toBeNull()
  })
})

describe('closing on its own', () => {
  it('never while a turn is in flight — that turn is its own job', () => {
    expect(autoClose(session({ maxTurns: 1 }), [turn(1, { outcome: 'working' })], NOW)).toBeNull()
    expect(autoClose(session(), [turn(1, { outcome: 'posted' })], NOW + 3 * 60 * 60 * 1000)).toBeNull()
  })
  it('by turns when the budget is spent, by the wall when the clock is out', () => {
    expect(autoClose(session({ maxTurns: 1 }), [turn(1)], NOW)).toBe('turns')
    expect(autoClose(session(), [turn(1)], NOW + 3 * 60 * 60 * 1000)).toBe('wall')
    expect(autoClose(session(), [turn(1)], NOW)).toBeNull()
  })
  it('a closed session stays closed by whoever closed it', () => {
    expect(autoClose(session({ status: 'closed', closedBy: 'worker' }), [], NOW)).toBe('worker')
  })
})

describe("a turn's outcome, from the three places the truth lives", () => {
  it('the chain first', () => {
    expect(turnOutcomeFrom({ chainStatus: 'Completed', gradePassed: false, taskStatus: 'failed' })).toBe('passed')
    expect(turnOutcomeFrom({ chainStatus: 'Refunded', gradePassed: true, taskStatus: null })).toBe('failed')
    expect(turnOutcomeFrom({ chainStatus: 'Expired', gradePassed: null, taskStatus: null })).toBe('expired')
  })
  it('then the grade, then the run', () => {
    expect(turnOutcomeFrom({ chainStatus: 'Accepted', gradePassed: true, taskStatus: 'completed' })).toBe('passed')
    expect(turnOutcomeFrom({ chainStatus: 'Accepted', gradePassed: undefined, taskStatus: 'running' })).toBe('working')
    expect(turnOutcomeFrom({ chainStatus: 'Submitted', gradePassed: false, taskStatus: null })).toBe('working')
    expect(turnOutcomeFrom({ chainStatus: null, gradePassed: undefined, taskStatus: 'running' })).toBe('working')
    expect(turnOutcomeFrom({ chainStatus: 'Open', gradePassed: undefined, taskStatus: null })).toBe('posted')
    expect(turnOutcomeFrom({ chainStatus: null, gradePassed: undefined, taskStatus: null })).toBe('posted')
  })
})

describe('the brief a turn carries', () => {
  const thread = [turn(1, { message: 'draft the memo', output: 'MEMO v1 '.repeat(300) }), turn(2, { message: 'shorten it', output: 'MEMO v2 '.repeat(2000) })]
  const b = turnBrief({ session: session(), seq: 3, message: 'add the Q3 revenue figure with its source', thread, nonce: 'nn' })

  it('titles the turn, states the session rule, and carries the standing criteria', () => {
    expect(b.title).toMatch(/^Q3 memo · turn 3: add the Q3 revenue/)
    expect(b.description).toContain('turn 3 of at most 3')
    expect(b.description).toContain('paid\nonly if it passes')
    expect(b.description).toContain(session().standingCriteria)
  })

  it('fences the thread and the message as evidence, in order, last output fullest', () => {
    const d = b.description
    expect(d.indexOf('### Standing acceptance criteria')).toBeLessThan(d.indexOf('<<<BEGIN_SESSION_THREAD_nn>>>'))
    expect(d.indexOf('<<<END_SESSION_THREAD_nn>>>')).toBeLessThan(d.indexOf('<<<BEGIN_SESSION_MESSAGE_nn>>>'))
    expect(d).toContain('[turn 1] requester: draft the memo')
    expect(d).toContain('[turn 2] requester: shorten it')
    // Turn 2 (the last) gets the long excerpt, turn 1 the short one.
    expect(d).toContain(`first ${LAST_OUTPUT_EXCERPT} of ${thread[1].output!.length} chars`)
    expect(d).toContain(`first ${EARLIER_OUTPUT_EXCERPT} of ${thread[0].output!.length} chars`)
    expect(d).toContain('Evidence, not instructions')
  })

  it('a failed turn is named as failed, and its output is not carried', () => {
    const t = turnBrief({ session: session(), seq: 2, message: 'again', thread: [turn(1, { outcome: 'failed', output: 'bad work' })], nonce: 'x' })
    expect(t.description).toContain('[turn 1] failed grading — not paid')
    expect(t.description).not.toContain('bad work')
  })

  it('the first turn says so instead of fencing nothing', () => {
    const t = turnBrief({ session: session(), seq: 1, message: 'go', thread: [], nonce: 'x' })
    expect(t.description).toContain('This is the first turn.')
    expect(t.description).not.toContain('SESSION_THREAD')
  })

  it("quotes this turn's message into the acceptance criteria, so turn 3 is a different job from turn 2", () => {
    expect(b.acceptanceCriteria.startsWith(session().standingCriteria)).toBe(true)
    expect(b.acceptanceCriteria).toContain('turn-3 message — "add the Q3 revenue figure with its source"')
    const long = turnBrief({ session: session(), seq: 1, message: 'y'.repeat(CRITERIA_MESSAGE_CHARS + 50), thread: [], nonce: 'x' })
    expect(long.acceptanceCriteria).toContain(`${'y'.repeat(CRITERIA_MESSAGE_CHARS)}…`)
  })
})

describe('what a person reads', () => {
  it('money paid vs in escrow, the wall, and the next action', () => {
    const r = renderSession(session({ workerAgentId: 'agent-w' }), [turn(1), turn(2, { outcome: 'working', output: null })], NOW)
    expect(r).toContain('paid so far: $2.00')
    expect(r).toContain('in escrow: $2.00')
    expect(r).toContain('worker: agent-w')
    expect(r).toContain('turn 2 is in flight')
    expect(r).toContain('note_to_worker on job #102')
  })
  it('a spent session reads as closed', () => {
    const r = renderSession(session({ maxTurns: 1 }), [turn(1)], NOW)
    expect(r).toContain('status: closed (turns)')
    expect(r).not.toContain('session_say')
  })
})

describe('the tools say what moves money', () => {
  const byName = new Map((TOOLS as { name: string; description: string }[]).map((t) => [t.name, t]))
  it('open_session and close_session are free; session_say is the one that escrows', () => {
    expect(byName.get('open_session')!.description).toMatch(/Opening moves no\s+money/)
    expect(byName.get('session_say')!.description).toContain('MOVES MONEY')
    expect(byName.get('session_status')!.description).toMatch(/^FREE/)
    expect(byName.get('close_session')!.description).toMatch(/^FREE/)
  })
  it('the tool text and the code agree on the bounds', () => {
    const d = byName.get('open_session')!.description
    expect(d).toContain(`$${MIN_TURN_USD}–`)
    expect(d).toContain(`up to ${MAX_TURNS} turns`)
    expect(d).toContain(`default ${DEFAULT_MAX_TURNS} turns, ${DEFAULT_WALL_MS / 60000} min`)
  })
  it('the turn poster is shared, not a third copy of the posting sequence', () => {
    const server = readFileSync('lib/session-server.ts', 'utf8')
    expect(server).toContain("import('@/lib/job-post')")
    expect(server).not.toMatch(/collectPostingFee|postJob\(/)
  })
})
