/**
 * The grammar and the sandbox for a local worker that touches real source.
 *
 * `public/handsel-worker.mjs` was a single LLM call — poll, prompt, post the
 * text back — so an office agent could describe work but never do any: no
 * file it could open, no test it could run, no diff it could produce. These
 * are the two pure pieces of the fix, and the second one is load-bearing:
 * the worker runs on the owner's own machine and a task can arrive from a
 * stranger who paid for a commission, so `confinePath` is the security
 * boundary of the whole feature, not a convenience.
 */
import { describe, expect, it } from 'vitest'

import { buildAgentSystemPrompt, clampOutput, confinePath, parseActions, MAX_AGENT_STEPS } from '@/lib/worker-agent-protocol'

describe('parseActions', () => {
  it('reads every action form', () => {
    expect(
      parseActions(
        '<list path="src"/>\n<read path="src/a.ts"/>\n<write path="src/b.ts">hello</write>\n<bash>npm test</bash>\n<done>fixed it</done>',
      ),
    ).toEqual([
      { kind: 'list', path: 'src' },
      { kind: 'read', path: 'src/a.ts' },
      { kind: 'write', path: 'src/b.ts', content: 'hello' },
      { kind: 'bash', command: 'npm test' },
      { kind: 'done', summary: 'fixed it' },
    ])
  })

  it('tolerates prose around the tags', () => {
    // Small models narrate. Refusing a reply because it opened with "Sure!"
    // would make this unusable by exactly the models the worker sells.
    const actions = parseActions('Sure! Let me look at that file first.\n<read path="a.ts"/>\nThen I will fix it.')
    expect(actions).toEqual([{ kind: 'read', path: 'a.ts' }])
  })

  it('keeps multi-line file contents exactly', () => {
    const body = 'line one\n  indented\n\nblank above'
    expect(parseActions(`<write path="x.txt">${body}</write>`)).toEqual([
      { kind: 'write', path: 'x.txt', content: body },
    ])
  })

  it('drops path-bearing actions with an empty path', () => {
    expect(parseActions('<read path=""/>')).toEqual([])
  })

  it('returns nothing for a reply with no actions', () => {
    expect(parseActions('I think the bug is in the parser.')).toEqual([])
  })
})

describe('confinePath — the sandbox', () => {
  const root = '/home/me/project'

  it('resolves ordinary relative paths inside the root', () => {
    expect(confinePath(root, 'src/a.ts')).toBe('/home/me/project/src/a.ts')
    expect(confinePath(root, './src/../src/a.ts')).toBe('/home/me/project/src/a.ts')
  })

  it('refuses to climb out with ..', () => {
    expect(confinePath(root, '../secrets.txt')).toBeNull()
    expect(confinePath(root, 'src/../../secrets.txt')).toBeNull()
    expect(confinePath(root, '../../../../etc/passwd')).toBeNull()
  })

  it('refuses absolute paths rather than rebasing them', () => {
    // Rebasing would turn a request for /etc/passwd into a read of
    // <root>/etc/passwd — the attempt would succeed-ish and leave no trace.
    expect(confinePath(root, '/etc/passwd')).toBeNull()
    expect(confinePath(root, 'C:\\Windows\\System32')).toBeNull()
  })

  it('refuses null bytes and empty paths', () => {
    expect(confinePath(root, 'a\0b')).toBeNull()
    expect(confinePath(root, '')).toBeNull()
  })

  it('allows a path that walks up and back within the root', () => {
    expect(confinePath(root, 'src/lib/../a.ts')).toBe('/home/me/project/src/a.ts')
  })
})

describe('clampOutput', () => {
  it('passes short output through untouched', () => {
    expect(clampOutput('hello', 100)).toBe('hello')
  })

  it('says it truncated rather than silently handing back a prefix', () => {
    const out = clampOutput('x'.repeat(50), 10)
    expect(out).toContain('truncated 40 more characters')
    expect(out.startsWith('x'.repeat(10))).toBe(true)
  })
})

describe('buildAgentSystemPrompt', () => {
  it('teaches every tag the parser accepts', () => {
    const p = buildAgentSystemPrompt({ bash: true, root: '/tmp/x' })
    for (const tag of ['<list', '<read', '<write', '<bash', '<done']) expect(p).toContain(tag)
  })

  it('does not advertise bash when bash is off, and says so', () => {
    const p = buildAgentSystemPrompt({ bash: false, root: '/tmp/x' })
    expect(p).not.toContain('<bash>npm test</bash>')
    expect(p).toContain('Running commands is disabled')
  })

  it('states the step budget it is actually given', () => {
    expect(buildAgentSystemPrompt({ bash: false, root: '/tmp/x' })).toContain(String(MAX_AGENT_STEPS))
  })
})
