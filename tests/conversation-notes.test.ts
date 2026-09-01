import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { needsAcknowledgement, noteStatus, normalizeNote, renderNotice } from '@/lib/conversation-notes'

const NOTE = `# notes

## 2026-09-01 · session A
A live round is running. Do not rewire the Architect.
`

describe('an unread note is a blocked commit', () => {
  it('treats a fresh working copy as unread — a new clone is a new agent', () => {
    // Not "no ack means fine". A container that just cloned this repo has no
    // memory of the conversation and is exactly who the note is for.
    const s = noteStatus(NOTE, null)
    expect(s.state).toBe('unread')
    expect(needsAcknowledgement(s)).toBe(true)
  })

  it('passes once the acknowledged text matches', () => {
    expect(needsAcknowledgement(noteStatus(NOTE, NOTE))).toBe(false)
  })

  it('re-blocks when the note grows', () => {
    const grown = `${NOTE}\n## 2026-09-02 · session B\nDo not restart the worker.\n`
    const s = noteStatus(grown, NOTE)
    expect(s.state).toBe('changed')
    expect(needsAcknowledgement(s)).toBe(true)
  })
})

describe('what gets shown is the new warning, not the whole file', () => {
  it('lists only lines that were not in the acknowledged text', () => {
    // A note accumulates for the life of the repo. Reprinting all of it on
    // every change is how a gate becomes wallpaper, and wallpaper is the
    // failure this gate exists to fix.
    const grown = `${NOTE}\n## 2026-09-02 · session B\nDo not restart the worker.\n`
    const s = noteStatus(grown, NOTE)
    expect(s.state !== 'current' && s.added).toEqual(['## 2026-09-02 · session B', 'Do not restart the worker.'])
  })

  it('still blocks when text was removed rather than added, and says so', () => {
    // Nothing new to print is not nothing to look at: somebody deleted a
    // warning, and passing silently there would be the gate lying.
    const shrunk = '# notes\n'
    const s = noteStatus(shrunk, NOTE)
    expect(s.state).toBe('changed')
    expect(s.state !== 'current' && s.added).toEqual([])
    expect(renderNotice(s, 'npm run conversation:ack')).toContain('removed or reordered')
  })

  it('does not flag a whitespace-only edit as a new warning', () => {
    // Acknowledging a note that did not change trains the habit of
    // acknowledging without reading, which is the whole defect.
    expect(needsAcknowledgement(noteStatus(`${NOTE}\n\n`, NOTE))).toBe(false)
    expect(needsAcknowledgement(noteStatus(NOTE.replace(/\n/g, '  \n'), NOTE))).toBe(false)
    expect(normalizeNote('a  \nb\t\n\n\n')).toBe('a\nb\n')
  })
})

describe('the gate is actually wired to something that runs', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  it('runs first in gates, before anything slow', () => {
    // A check that fires after typecheck, lint, test and build is a check
    // discovered ninety seconds late, which is long enough to have started
    // the work the note was warning about.
    const gates: string = pkg.scripts.gates
    expect(gates).toContain('conversation:check')
    expect(gates.indexOf('conversation:check')).toBeLessThan(gates.indexOf('typecheck'))
  })

  it('offers a one-command acknowledgement', () => {
    // A gate that is annoying to satisfy gets bypassed, and a bypassed gate
    // is worse than none — it looks like coverage.
    expect(pkg.scripts['conversation:ack']).toContain('--ack')
  })
})

describe('the script and the tested module agree', () => {
  const script = readFileSync('scripts/conversation-check.mjs', 'utf8')

  it('keeps the acknowledgement out of the repo', () => {
    // In .git/, deliberately: per working copy so a fresh clone reads it once,
    // and never committed so nobody can acknowledge on another agent's behalf
    // — or hit a merge conflict in the acknowledgement itself.
    expect(script).toContain("path.join(dir, 'handsel-conversation-ack')")
    expect(script).toContain("execFileSync('git', ['rev-parse', '--git-dir']")
  })

  it('normalizes the same way the tested module does', () => {
    // Mirrored rather than imported: a .mjs gate cannot import .ts without a
    // build step, and a build step inside a pre-commit gate is a gate that
    // gets skipped.
    expect(script).toContain("replace(/\\s+$/, '')")
    expect(script).toContain("replace(/\\n+$/, '\\n')")
  })

  it('does not break a checkout that has no git dir', () => {
    // A tarball or a Docker COPY is not a place anybody is coordinating;
    // failing there would break builds to enforce a convention that cannot
    // apply.
    expect(script).toMatch(/if \(!dir\) process\.exit\(0\)/)
  })
})
