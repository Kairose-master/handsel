import { describe, it, expect } from 'vitest'
import {
  MAX_EVENTS_KEPT,
  MAX_EVENTS_PER_REPORT,
  MAX_TEXT,
  NO_SAMPLE,
  STALE_AFTER_MS,
  appendEvents,
  diffStat,
  elapsedLabel,
  furthestPhase,
  runStatus,
  sanitizeEvents,
  sanitizePhase,
  sanitizeSample,
  tokenLabel,
  touchedFiles,
  type RunEvent,
} from '@/lib/harness-run'

const NOW = 1_760_000_000_000
const ev = (over: Partial<RunEvent> = {}): RunEvent => ({
  at: NOW,
  phase: 'code',
  text: 'writing',
  path: null,
  level: 'info',
  ...over,
})

describe('worker telemetry is untrusted input', () => {
  it('drops events with no usable text rather than storing blanks', () => {
    expect(sanitizeEvents([{ text: '' }, { text: '   ' }, { text: null }, {}, 'nope', null], NOW)).toEqual([])
  })

  it('strips colour sequences whole, not just their escape byte', () => {
    // The naive version removes ESC as a control character and leaves `[31m`
    // behind as literal text. Every harness CLI colours its output, so the
    // terminal panel would fill with that residue on the first real run.
    const [e] = sanitizeEvents([{ text: '\u001b[31mwrote\u001b[0m gateway.ts' }], NOW)
    expect(e.text).toBe('wrote gateway.ts')
  })

  it('strips bare control characters too — this text lands in a <pre>', () => {
    const [e] = sanitizeEvents([{ text: 'wrote\u0007 gateway.ts\u0000' }], NOW)
    expect(e.text).toBe('wrote gateway.ts')
  })

  it('clamps text and path length', () => {
    const [e] = sanitizeEvents([{ text: 'x'.repeat(5000), path: 'p'.repeat(5000) }], NOW)
    expect(e.text).toHaveLength(MAX_TEXT)
    expect(e.path!.length).toBeLessThanOrEqual(200)
  })

  it('bounds how much one report can add', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ text: `line ${i}` }))
    expect(sanitizeEvents(many, NOW)).toHaveLength(MAX_EVENTS_PER_REPORT)
  })

  it('falls back to a known phase instead of trusting an arbitrary string', () => {
    expect(sanitizeEvents([{ text: 'x', phase: 'DROP TABLE' }], NOW)[0].phase).toBe('code')
    expect(sanitizePhase('deploy')).toBe('deploy')
    expect(sanitizePhase('rm -rf')).toBeNull()
    expect(sanitizePhase(7)).toBeNull()
  })

  it('replaces a wild clock with receipt time, so one bad worker cannot sort every real event off the list', () => {
    const [future] = sanitizeEvents([{ text: 'x', at: NOW + 400 * 86_400_000 }], NOW)
    expect(future.at).toBe(NOW)
    const [ok] = sanitizeEvents([{ text: 'x', at: NOW - 5000 }], NOW)
    expect(ok.at).toBe(NOW - 5000)
  })
})

describe('a missing reading is null, never zero', () => {
  it('reports absent resource readings as absent', () => {
    expect(sanitizeSample(undefined)).toEqual(NO_SAMPLE)
    expect(sanitizeSample({})).toEqual(NO_SAMPLE)
    // The trap: `Number(undefined) || 0` would render this as an idle machine.
    expect(sanitizeSample({ cpuPct: null }).cpuPct).toBeNull()
    expect(sanitizeSample({ cpuPct: 'busy' }).cpuPct).toBeNull()
  })

  it('keeps a real zero, which is a different thing from no reading', () => {
    expect(sanitizeSample({ cpuPct: 0 }).cpuPct).toBe(0)
  })

  it('clamps a reading into a range a gauge can draw', () => {
    expect(sanitizeSample({ cpuPct: 4000 }).cpuPct).toBe(100)
    expect(sanitizeSample({ cpuPct: -12 }).cpuPct).toBe(0)
  })

  it('has no label for an unmeasured token count', () => {
    expect(tokenLabel(null)).toBeNull()
    expect(tokenLabel(940)).toBe('940')
    expect(tokenLabel(18_432)).toBe('18.4k')
  })
})

describe('phase', () => {
  it('takes the furthest phase reached, not the latest reported', () => {
    // A failing test sends the model back to writing code. The stepper must
    // not walk backwards, or it reads as lost progress.
    const events = [ev({ phase: 'plan' }), ev({ phase: 'code' }), ev({ phase: 'test' }), ev({ phase: 'code' })]
    expect(furthestPhase(events)).toBe('test')
  })

  it('honours a phase the worker states even with no events in it yet', () => {
    expect(furthestPhase([], 'review')).toBe('review')
    expect(furthestPhase([ev({ phase: 'plan' })], 'deploy')).toBe('deploy')
  })

  it('starts at plan', () => {
    expect(furthestPhase([])).toBe('plan')
  })
})

describe('files', () => {
  it('lists each path once, most recently written first', () => {
    const files = touchedFiles([
      ev({ path: 'src/a.ts', at: NOW }),
      ev({ path: 'src/b.ts', at: NOW + 10 }),
      ev({ path: 'src/a.ts', at: NOW + 20 }),
      ev({ path: null }),
    ])
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files[0].at).toBe(NOW + 20)
  })
})

describe('diff stat', () => {
  const DIFF = `diff --git a/src/routes/gateway.ts b/src/routes/gateway.ts
--- a/src/routes/gateway.ts
+++ b/src/routes/gateway.ts
@@ -1,3 +1,4 @@
 const x = 1
-const y = 2
+const y = 3
+const z = 4
diff --git a/README.md b/README.md
--- /dev/null
+++ b/README.md
@@ -0,0 +1,1 @@
+hello
`

  it('counts files and lines off the diff the worker already submits', () => {
    expect(diffStat(DIFF)).toEqual({ files: 2, additions: 3, deletions: 1 })
  })

  it('does not count the file headers or hunk markers as changed lines', () => {
    // `--- a/x` starts with '-' and `+++ b/x` with '+'; counting them would
    // add two phantom lines per file.
    expect(diffStat(DIFF).additions).toBe(3)
  })

  it('ignores /dev/null as a path', () => {
    expect(diffStat(DIFF).files).toBe(2)
  })

  it('is empty for an empty diff rather than throwing', () => {
    expect(diffStat('')).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
})

describe('run status', () => {
  it('calls a finished run by its verdict', () => {
    expect(runStatus({ finishedAt: NOW, ok: true, updatedAt: NOW }, NOW)).toBe('passed')
    expect(runStatus({ finishedAt: NOW, ok: false, updatedAt: NOW }, NOW)).toBe('failed')
  })

  it('calls a silent run stalled instead of leaving it Running forever', () => {
    // A worker that is killed or loses its network never sends a failure —
    // it stops talking, and "Running" is the state that makes someone wait.
    expect(runStatus({ finishedAt: null, ok: null, updatedAt: NOW }, NOW + 5_000)).toBe('running')
    expect(runStatus({ finishedAt: null, ok: null, updatedAt: NOW }, NOW + STALE_AFTER_MS + 1)).toBe('stalled')
  })

  it('a finished run never goes stale', () => {
    expect(runStatus({ finishedAt: NOW, ok: true, updatedAt: NOW }, NOW + 10 * STALE_AFTER_MS)).toBe('passed')
  })
})

describe('append', () => {
  it('keeps history in time order across reports that arrive out of order', () => {
    const merged = appendEvents([ev({ at: NOW + 100, text: 'late' })], [ev({ at: NOW, text: 'early' })])
    expect(merged.map((e) => e.text)).toEqual(['early', 'late'])
  })

  it('bounds what one long run can accumulate, dropping the oldest', () => {
    const existing = Array.from({ length: MAX_EVENTS_KEPT }, (_, i) => ev({ at: NOW + i, text: `e${i}` }))
    const merged = appendEvents(existing, [ev({ at: NOW + 1e6, text: 'newest' })])
    expect(merged).toHaveLength(MAX_EVENTS_KEPT)
    expect(merged[merged.length - 1].text).toBe('newest')
    expect(merged[0].text).toBe('e1')
  })
})

describe('elapsed', () => {
  it('reads the way a person waits', () => {
    expect(elapsedLabel(42_000)).toBe('42s')
    expect(elapsedLabel(162_000)).toBe('2m 42s')
    expect(elapsedLabel(3_900_000)).toBe('1h 05m')
    expect(elapsedLabel(-5)).toBe('0s')
  })
})
