import test from 'node:test'
import assert from 'node:assert/strict'
import { approve, editMessage, fingerprint, recordEvent } from '../ops/policy.mjs'
import { providers } from '../ops/providers.mjs'

const now = Date.parse('2026-09-30T00:00:00Z')
const input = () => ({
  recipient: 'developer@example.com',
  subject: 'Handsel integration',
  body: 'Would a scoped integration experiment be useful?',
  contactEvidence: 'https://example.com/contact',
  contactBasis: 'invited',
})
const state = () => ({
  leads: [{ id: 'lead-1', owner: 'developer' }],
  messages: [{ id: 'message-1', leadId: 'lead-1', status: 'draft' }],
  events: [],
  suppressions: [],
})
const disallowedTextControl = code => code < 32 && ![9, 10, 13].includes(code)
const lead = {
  repo: 'developer/research-agent',
  readme: 'This agent uses MCP tools for research.',
  sourceUrl: 'https://github.com/developer/research-agent',
}
function model(result) {
  return providers({ ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'test-model' }, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/generate')
    assert.equal(init.method, 'POST')
    return Response.json({ response: JSON.stringify(result) })
  })
}

test('reviewed message bodies retain the exact ASCII control-character policy', () => {
  // Include the C0 boundary, all printable ASCII, and DEL. Do not broaden the
  // original filter while repairing its no-control-regex lint violation.
  for (let code = 0; code <= 127; code++) {
    const s = state(), body = `before${String.fromCharCode(code)}after`
    if (disallowedTextControl(code)) {
      assert.throws(() => editMessage(s, 'message-1', { ...input(), body }, now), /Invalid body/, `code ${code}`)
      assert.deepEqual(s, state(), 'a refused edit must not mutate the message or audit log')
    } else {
      assert.equal(editMessage(s, 'message-1', { ...input(), body }, now).body, body, `code ${code}`)
    }
  }
})

test('control characters are rejected before trimming in every reviewed text field', () => {
  for (let code = 0; code < 32; code++) {
    if (!disallowedTextControl(code)) continue
    const char = String.fromCharCode(code)
    for (const field of ['recipient', 'subject', 'body', 'contactEvidence']) {
      for (const position of ['start', 'end']) {
        const s = state(), draft = input()
        draft[field] = position === 'start' ? char + draft[field] : draft[field] + char
        assert.throws(() => editMessage(s, 'message-1', draft, now), /Invalid /, `${field}/${position}/${code}`)
        assert.deepEqual(s, state())
      }
    }
  }
})

test('Unicode and body whitespace survive; field limits and header checks remain enforced', () => {
  const body = '진우의 에이전트 🤖\t中文\r\nA scoped experiment.'
  assert.equal(editMessage(state(), 'message-1', { ...input(), body: `  ${body}  ` }, now).body, body)
  for (const subject of ['hello\rBcc: other@example.com', 'hello\nBcc: other@example.com']) {
    assert.throws(() => editMessage(state(), 'message-1', { ...input(), subject }, now), /Subject cannot contain newlines/)
  }
  assert.throws(() => editMessage(state(), 'message-1', { ...input(), recipient: 'a@example.com\nb@example.com' }, now), /single reviewed email/)
  for (const invalid of ['', ' \t\r\n ', null, 7, 'a'.repeat(6001)]) {
    assert.throws(() => editMessage(state(), 'message-1', { ...input(), body: invalid }, now), /Invalid body/)
  }
  assert.equal(editMessage(state(), 'message-1', { ...input(), body: 'a'.repeat(6000) }, now).body.length, 6000)
})

test('approval operator and activation evidence retain the same control-character guards', () => {
  for (let code = 0; code < 32; code++) {
    if (!disallowedTextControl(code)) continue
    const char = String.fromCharCode(code), s = state()
    const message = editMessage(s, 'message-1', input(), now)
    const before = structuredClone(s)
    assert.throws(() => approve(s, 'message-1', {
      confirm: true, hash: fingerprint(message), operator: `review${char}er`,
    }, now), /Invalid operator/)
    assert.deepEqual(s, before)
    assert.throws(() => recordEvent(s, 'lead-1', {
      type: 'integrated', evidence: `https://example.com/${char}proof`,
    }, now), /Invalid event evidence URL/)
    assert.deepEqual(s, before)
  }
})

test('model suggestions retain their original NUL-through-backspace rejection range', async () => {
  for (const code of [...Array.from({ length: 33 }, (_, i) => i), 127]) {
    const result = { evidence: 'MCP tools', reason: `Possible${String.fromCharCode(code)}integration` }
    const call = () => model(result).research(lead)
    if (code <= 8) {
      await assert.rejects(call, /Model suggestion failed evidence checks/, `code ${code}`)
    } else {
      assert.equal((await call()).reason, result.reason, `code ${code}`)
    }
  }
})

test('model evidence, length and prohibited-claim checks are not weakened', async () => {
  for (const reason of ['HTTP://example.com', 'HTTPS://example.com', 'GuArAnTeE income', 'Earn $1', '', '  ', null, 7, 'x'.repeat(301)]) {
    await assert.rejects(() => model({ evidence: 'MCP tools', reason }).research(lead), /Model suggestion failed evidence checks/)
  }
  for (const evidence of ['', ' ', null, 7, 'invented capability', 'x'.repeat(241)]) {
    await assert.rejects(() => model({ evidence, reason: 'Possible research integration' }).research(lead), /Model suggestion failed evidence checks/)
  }
})

test('valid Unicode model suggestions remain unmodified and require human review', async () => {
  const result = { evidence: 'MCP tools', reason: '리서치 도구 · 研究工具 🤖' }
  assert.deepEqual(await model(result).research(lead), {
    ...result,
    source: `${lead.sourceUrl}#readme`,
    status: 'model_suggestion_requires_human_review',
  })
})
