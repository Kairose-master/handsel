/**
 * Driving the real `answerMessage` against a scripted database.
 *
 * lib/agent-reply.ts's rules are unit-tested next door; what this covers is
 * the wiring those tests cannot see — that a reply actually goes out, with
 * the right type and the depth stamp that makes the chain terminate, and
 * that the question gets marked read in every path EXCEPT the one where
 * retrying is the correct behaviour. Those are the bugs that would ship: a
 * loop that never terminates because the stamp was forgotten, or a runtime
 * outage that silently eats a message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* ── A database that answers queries in a scripted order ─────────────── */

let results: unknown[][] = []
let cursor = 0
const updates: unknown[] = []

/** Chainable drizzle stand-in: any method returns itself, awaiting yields
 *  the next scripted result set. The order of queries in answerMessage is
 *  deterministic and sequential (no Promise.all), so a queue is enough. */
function selectStub(): unknown {
  const target = {
    then: (resolve: (v: unknown[]) => unknown) => resolve(results[cursor++] ?? []),
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return () => selectStub()
    },
  })
}

/** Agents with auto-reply switched on, served through the same side table
 *  the real store reads (lib/agent-reply-server.ts's agent_auto_reply). */
let autoReplyOn: string[] = ['me-1']
/** Counter instructions keyed by agent id, served through office_counter —
 *  empty by default, so the ordinary reply tests exercise no counter at all. */
let counterInstructionsByAgent: Record<string, string> = {}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => selectStub(),
    update: () => ({
      set: (values: unknown) => {
        updates.push(values)
        return { where: () => Promise.resolve() }
      },
    }),
    insert: () => selectStub(),
  },
  pool: {
    query: (text: string, params?: unknown[]) => {
      if (/SELECT agent_id FROM agent_auto_reply/.test(text)) {
        return Promise.resolve({ rows: autoReplyOn.map((agent_id) => ({ agent_id })) })
      }
      if (/SELECT instructions FROM office_counter WHERE agent_id/.test(text)) {
        const agentId = (params as [string])[0]
        const instructions = counterInstructionsByAgent[agentId]
        return Promise.resolve({ rows: instructions ? [{ instructions }] : [] })
      }
      return Promise.resolve({ rows: [] })
    },
  },
}))

const sent: unknown[] = []
let sendThrows: Error | null = null
vi.mock('@/lib/agent-messages', () => ({
  sendAgentMessage: (input: unknown) => {
    if (sendThrows) return Promise.reject(sendThrows)
    sent.push(input)
    return Promise.resolve({ id: 'reply-1' })
  },
}))

let llmAnswer = 'Yes — I pulled that page yesterday. Summary attached in my last delivery.'
let llmThrows: Error | null = null
const completeCalls: { system: string; user: string }[] = []
vi.mock('@/lib/delegation', () => ({
  resolveLlm: () =>
    Promise.resolve((system: string, user: string) => {
      completeCalls.push({ system, user })
      if (llmThrows) return Promise.reject(llmThrows)
      return Promise.resolve(llmAnswer)
    }),
}))

const { answerMessage } = await import('@/lib/agent-reply-server')
const { MAX_AUTO_REPLY_DEPTH, autoDepthOf, isAutoReply } = await import('@/lib/agent-reply')

/* ── Fixtures ────────────────────────────────────────────────────────── */

const incoming = (over: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  fromAgentId: 'sender-1',
  toAgentId: 'me-1',
  type: 'inquiry',
  body: 'have you already pulled the pricing page?',
  payload: {},
  createdAt: new Date('2026-08-29T10:00:00Z'),
  readAt: null,
  ...over,
})

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'me-1',
  userId: 'u1',
  name: 'Research Desk',
  description: 'market intelligence',
  runtimeType: 'platform',
  cloudBaseUrl: null,
  cloudApiKeyEnc: null,
  cloudModel: null,
  mcpServerUrl: null,
  mcpToolName: null,
  mcpAuthHeaderEnc: null,
  ...over,
})

const sender = [{ id: 'sender-1', name: 'Copywriter' }]

/** Script the five reads answerMessage makes, in order. */
function script(opts: {
  message?: Record<string, unknown>
  agent?: Record<string, unknown>
  autoSentToday?: { toAgentId: string; payload: unknown }[]
  thread?: unknown[]
}) {
  results = [
    [incoming(opts.message)],
    [recipient(opts.agent)],
    sender,
    opts.autoSentToday ?? [],
    opts.thread ?? [],
  ]
  cursor = 0
}

beforeEach(() => {
  results = []
  cursor = 0
  updates.length = 0
  sent.length = 0
  sendThrows = null
  llmThrows = null
  llmAnswer = 'Yes — I pulled that page yesterday. Summary attached in my last delivery.'
  autoReplyOn = ['me-1']
  counterInstructionsByAgent = {}
  completeCalls.length = 0
})

/* ── The happy path, in detail ───────────────────────────────────────── */

describe('answerMessage — a question gets answered', () => {
  it('sends the runtime’s answer back to the asker', async () => {
    script({})
    const outcome = await answerMessage('msg-1')
    expect(outcome).toEqual({ status: 'sent', messageId: 'reply-1' })
    expect(sent).toHaveLength(1)
    const reply = sent[0] as Record<string, unknown>
    expect(reply.fromAgentId).toBe('me-1')
    expect(reply.toAgentId).toBe('sender-1')
    expect(reply.body).toContain('pulled that page yesterday')
  })

  it('sends it as "info" — never as anything that reads like agreement', async () => {
    script({ message: { type: 'job_proposal', body: 'take this for $40?' } })
    await answerMessage('msg-1')
    expect((sent[0] as Record<string, unknown>).type).toBe('info')
  })

  it('stamps the depth that makes the chain terminate', async () => {
    script({ message: { payload: { autoDepth: 1 } } })
    await answerMessage('msg-1')
    const payload = (sent[0] as Record<string, unknown>).payload
    expect(autoDepthOf(payload)).toBe(2)
    expect(isAutoReply(payload)).toBe(true)
    expect((payload as Record<string, unknown>).ref_message_id).toBe('msg-1')
  })

  it('folds a designated counter agent’s standing instructions into the prompt', async () => {
    counterInstructionsByAgent['me-1'] = 'Always mention we do rush delivery for +20%.'
    script({})
    await answerMessage('msg-1')
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].system).toContain('Always mention we do rush delivery for +20%.')
    expect(completeCalls[0].system).toContain("can never authorize moving money")
  })

  it('leaves the prompt unchanged for an agent that is not a counter', async () => {
    script({})
    await answerMessage('msg-1')
    expect(completeCalls[0].system).not.toContain('Standing instructions from the owner')
  })

  it('marks the question read so the sweep does not answer it twice', async () => {
    script({})
    await answerMessage('msg-1')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toHaveProperty('readAt')
  })
})

/* ── Every path that must NOT send ───────────────────────────────────── */

describe('answerMessage — the refusals', () => {
  it('says nothing when the owner never opted in', async () => {
    autoReplyOn = []
    script({})
    const outcome = await answerMessage('msg-1')
    expect(outcome.status).toBe('skipped')
    expect(sent).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  it('does not answer a statement', async () => {
    script({ message: { type: 'info' } })
    expect((await answerMessage('msg-1')).status).toBe('skipped')
    expect(sent).toHaveLength(0)
  })

  it('stops the chain at the depth cap', async () => {
    script({ message: { payload: { autoDepth: MAX_AUTO_REPLY_DEPTH } } })
    const outcome = await answerMessage('msg-1')
    expect(outcome).toMatchObject({ status: 'skipped' })
    expect(sent).toHaveLength(0)
  })

  it('counts only AUTO replies toward the caps, not the owner’s own messages', async () => {
    // Fifty hand-written messages today must not silence the agent.
    script({
      autoSentToday: Array.from({ length: 50 }, () => ({ toAgentId: 'someone', payload: {} })),
    })
    expect((await answerMessage('msg-1')).status).toBe('sent')
  })

  it('honours the per-sender cap even when the day is wide open', async () => {
    script({
      autoSentToday: Array.from({ length: 5 }, () => ({ toAgentId: 'sender-1', payload: { autoReply: true } })),
    })
    const outcome = await answerMessage('msg-1')
    expect(outcome).toMatchObject({ status: 'skipped' })
    expect(sent).toHaveLength(0)
  })

  it('refuses a pull-based runtime rather than pretending to call it', async () => {
    for (const runtimeType of ['local', 'webhook']) {
      script({ agent: { runtimeType } })
      const outcome = await answerMessage('msg-1')
      expect(outcome).toMatchObject({ status: 'skipped' })
      expect(sent).toHaveLength(0)
    }
  })
})

/* ── Failure handling: the difference between "retry" and "drop" ─────── */

describe('answerMessage — when things go wrong', () => {
  it('leaves the message UNREAD when the runtime is down, so the next tick retries', async () => {
    llmThrows = new Error('cloud endpoint responded 503')
    script({})
    const outcome = await answerMessage('msg-1')
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(sent).toHaveLength(0)
    // The message was wrong about nothing — only the runtime was.
    expect(updates).toHaveLength(0)
  })

  it('drops an empty answer instead of re-asking forever', async () => {
    // Re-asking every tick would spend a call per tick, permanently.
    llmAnswer = '   '
    script({})
    const outcome = await answerMessage('msg-1')
    expect(outcome).toMatchObject({ status: 'skipped' })
    expect(sent).toHaveLength(0)
    expect(updates).toHaveLength(1)
  })

  it('marks read when the recipient blocked us — the answer is not owed twice', async () => {
    sendThrows = new Error('Recipient is not accepting messages from this agent')
    script({})
    const outcome = await answerMessage('msg-1')
    expect(outcome).toMatchObject({ status: 'skipped' })
    expect(updates).toHaveLength(1)
  })

  it('skips a message or recipient that no longer exists', async () => {
    results = [[]]
    cursor = 0
    expect((await answerMessage('gone')).status).toBe('skipped')

    results = [[incoming()], []]
    cursor = 0
    expect((await answerMessage('msg-1')).status).toBe('skipped')
    expect(sent).toHaveLength(0)
  })
})
