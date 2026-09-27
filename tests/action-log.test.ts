import { describe, expect, it } from 'vitest'
import {
  ACTION_LOG_MAX_ENTRIES,
  ACTION_LOG_SCHEMA,
  actionLogHash,
  actionLogSummary,
  noFailedTail,
  parseActionLog,
  requiresTool,
  runPredicates,
} from '@/lib/action-log'
import { EVIDENCE_SCHEMA, evidenceHashOf, type EvidenceBundle } from '@/lib/attestation'

/**
 * The action log is the worker's hash-committed account of HOW a deliverable
 * was produced. These pin: the accepted shape, that the hash is canonical
 * (key order and key casing cannot change it), that adding the field to an
 * evidence bundle does not disturb any bundle issued without it, and that the
 * two built-in predicates say what they claim.
 */

const good = [
  { seq: 1, tool: 'web_search', ok: true, input_hash: 'ab'.repeat(32), ms: 1200, note: 'looked up the spec' },
  { seq: 2, tool: 'pytest', ok: true, output_hash: '0x' + 'cd'.repeat(32) },
]

describe('parseActionLog', () => {
  it('accepts a well-formed log and normalizes hashes to 0x-lowercase', () => {
    const r = parseActionLog(good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.log.schema).toBe(ACTION_LOG_SCHEMA)
    expect(r.log.entries[0].inputHash).toBe('0x' + 'ab'.repeat(32))
    expect(r.log.entries[1].outputHash).toBe('0x' + 'cd'.repeat(32))
    expect(r.log.entries[0].note).toBe('looked up the spec')
  })
  it('numbers entries when seq is omitted and accepts camelCase keys', () => {
    const r = parseActionLog([{ tool: 'a', ok: true, inputHash: '0x' + '11'.repeat(32) }, { tool: 'b', ok: false }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.log.entries.map((e) => e.seq)).toEqual([1, 2])
    expect(r.log.entries[0].inputHash).toBe('0x' + '11'.repeat(32))
  })
  it('refuses the shapes a grader cannot trust', () => {
    expect(parseActionLog([]).ok).toBe(false)
    expect(parseActionLog('nope').ok).toBe(false)
    expect(parseActionLog([{ tool: '', ok: true }]).ok).toBe(false)
    expect(parseActionLog([{ tool: 'a', ok: 'yes' }]).ok).toBe(false)
    expect(parseActionLog([{ seq: 2, tool: 'a', ok: true }, { seq: 2, tool: 'b', ok: true }]).ok).toBe(false)
    expect(parseActionLog([{ tool: 'a', ok: true, input_hash: 'zz' }]).ok).toBe(false)
    expect(parseActionLog(Array.from({ length: ACTION_LOG_MAX_ENTRIES + 1 }, () => ({ tool: 'a', ok: true }))).ok).toBe(false)
  })
  it('caps a note at 280 chars', () => {
    const r = parseActionLog([{ tool: 'a', ok: true, note: 'x'.repeat(1000) }])
    expect(r.ok && r.log.entries[0].note?.length).toBe(280)
  })
})

describe('actionLogHash', () => {
  it('is independent of key order and input key casing', () => {
    const a = parseActionLog([{ seq: 1, tool: 't', ok: true, input_hash: 'ab'.repeat(32) }])
    const b = parseActionLog([{ inputHash: '0x' + 'AB'.repeat(32), ok: true, tool: 't', seq: 1 }])
    expect(a.ok && b.ok && actionLogHash(a.log)).toBe(b.ok && actionLogHash(b.log))
  })
  it('changes when any entry changes', () => {
    const a = parseActionLog(good)
    const b = parseActionLog([...good.slice(0, 1), { ...good[1], ok: false }])
    expect(a.ok && b.ok && actionLogHash(a.log) !== actionLogHash(b.log)).toBe(true)
  })
})

describe('evidence bundle compatibility', () => {
  const base: EvidenceBundle = {
    schema: EVIDENCE_SCHEMA,
    spec: 'write a haiku',
    deliverable: { text: 'old pond / frog jumps in / sound of water' },
    grader: 'llm',
    graderClass: 'model',
  }
  it('an undefined actionLogHash leaves every pre-existing evidence hash unchanged', () => {
    expect(evidenceHashOf({ ...base, actionLogHash: undefined })).toBe(evidenceHashOf(base))
  })
  it('a present actionLogHash is bound into the evidence hash', () => {
    const r = parseActionLog(good)
    if (!r.ok) throw new Error('fixture')
    expect(evidenceHashOf({ ...base, actionLogHash: actionLogHash(r.log) })).not.toBe(evidenceHashOf(base))
  })
})

describe('predicates', () => {
  const r = parseActionLog(good)
  if (!r.ok) throw new Error('fixture')
  it('requiresTool counts only successful calls', () => {
    expect(requiresTool('pytest')(r.log).passed).toBe(true)
    expect(requiresTool('pytest', { minCalls: 2 })(r.log).passed).toBe(false)
    expect(requiresTool('ffmpeg')(r.log).passed).toBe(false)
    const failed = parseActionLog([{ tool: 'pytest', ok: false }])
    expect(failed.ok && requiresTool('pytest')(failed.log).passed).toBe(false)
  })
  it('noFailedTail looks only at the last step', () => {
    expect(noFailedTail(r.log).passed).toBe(true)
    const bad = parseActionLog([{ tool: 'a', ok: true }, { tool: 'b', ok: false }])
    expect(bad.ok && noFailedTail(bad.log).passed).toBe(false)
  })
  it('runPredicates is all-or-nothing and keeps every reason', () => {
    const out = runPredicates(r.log, [requiresTool('web_search'), requiresTool('ffmpeg'), noFailedTail])
    expect(out.passed).toBe(false)
    expect(out.results.map((x) => x.passed)).toEqual([true, false, true])
  })
  it('summary names tools once and counts failures', () => {
    const s = actionLogSummary(r.log)
    expect(s).toEqual({ entries: 2, tools: ['web_search', 'pytest'], failed: 0, totalMs: 1200 })
  })
})
