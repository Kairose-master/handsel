import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DURATION_TOLERANCE_SEC,
  extractMediaSpec,
  MAX_OPS,
  MediaSpecError,
  deriveMust,
  ffmpegArgs,
  gradeRender,
  parseMediaSpec,
  validateSourceUrl,
} from '@/lib/media-recipe'

const SRC = 'https://cdn.example.com/clip.mp4'
const spec = (over: Record<string, unknown> = {}) => parseMediaSpec({ sourceUrl: SRC, ops: [{ op: 'mute' }], ...over })

describe('where a source may come from', () => {
  it('takes an ordinary https url', () => {
    expect(validateSourceUrl(SRC)).toBe(SRC)
  })

  it('refuses plaintext http', () => {
    expect(() => validateSourceUrl('http://cdn.example.com/a.mp4')).toThrow(/https/)
  })

  it('refuses credentials, which would land in logs and on the console page', () => {
    expect(() => validateSourceUrl('https://user:pw@cdn.example.com/a.mp4')).toThrow(/credentials/)
  })

  it('refuses the obvious internal targets', () => {
    for (const host of [
      'https://localhost/a.mp4',
      'https://127.0.0.1/a.mp4',
      'https://10.1.2.3/a.mp4',
      'https://192.168.0.9/a.mp4',
      'https://172.16.0.1/a.mp4',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/x',
    ]) {
      expect(() => validateSourceUrl(host), host).toThrow(/not allowed/)
    }
  })

  it('refuses a non-url outright rather than passing it along', () => {
    expect(() => validateSourceUrl('clip.mp4')).toThrow(MediaSpecError)
    expect(() => validateSourceUrl(null)).toThrow(MediaSpecError)
  })
})

describe('operations are numbers, not text', () => {
  it('rejects an unknown operation by name', () => {
    expect(() => spec({ ops: [{ op: 'exec' }] })).toThrow(/not a known operation/)
  })

  it('rejects odd dimensions, which h264 cannot encode in yuv420p', () => {
    expect(() => spec({ ops: [{ op: 'scale', width: 1081, height: 1920 }] })).toThrow(/even/)
  })

  it('rejects out-of-range and non-integer values', () => {
    expect(() => spec({ ops: [{ op: 'scale', width: 99999, height: 1080 }] })).toThrow(/between/)
    expect(() => spec({ ops: [{ op: 'crop', x: 1.5, y: 0, width: 100, height: 100 }] })).toThrow(/whole number/)
    expect(() => spec({ ops: [{ op: 'fps', fps: 0 }] })).toThrow(/between/)
  })

  it('bounds how many operations one job can chain', () => {
    const many = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'mute' }))
    expect(() => spec({ ops: many })).toThrow(/at most/)
  })

  it('requires at least one operation — a job that does nothing cannot be graded', () => {
    expect(() => spec({ ops: [] })).toThrow(/non-empty/)
  })
})

describe('acceptance criteria', () => {
  it('derives what the operations already determine', () => {
    expect(deriveMust([{ op: 'scale', width: 1080, height: 1920 }])).toEqual({ width: 1080, height: 1920 })
    expect(deriveMust([{ op: 'trim', startSec: 2, durationSec: 15 }])).toEqual({ durationSec: 15 })
    expect(deriveMust([{ op: 'mute' }])).toEqual({ hasAudio: false })
  })

  it('leaves undetermined properties absent rather than guessing them', () => {
    // A crop fixes the frame but says nothing about how long the result is.
    expect(deriveMust([{ op: 'crop', x: 0, y: 0, width: 100, height: 100 }]).durationSec).toBeUndefined()
  })

  it('refuses a spec whose criteria contradict its own operations', () => {
    // Discovering this after the render costs a bounty, a worker's time and
    // an argument about grading. It costs nothing here.
    expect(() =>
      spec({ ops: [{ op: 'scale', width: 1080, height: 1920 }], must: { width: 720 } }),
    ).toThrow(/could never pass/)
    expect(() => spec({ ops: [{ op: 'mute' }], must: { hasAudio: true } })).toThrow(/could never pass/)
  })

  it('accepts criteria the operations do not cover', () => {
    const s = spec({ ops: [{ op: 'crop', x: 0, y: 0, width: 720, height: 1280 }], must: { durationSec: 15 } })
    expect(s.must).toEqual({ width: 720, height: 1280, durationSec: 15 })
  })
})

describe('the ffmpeg invocation', () => {
  it('is an argv array with no shell metacharacters anywhere', () => {
    const args = ffmpegArgs(
      spec({ ops: [{ op: 'crop', x: 10, y: 20, width: 720, height: 1280 }, { op: 'fps', fps: 30 }] }),
      '/tmp/in.mp4',
      '/tmp/out.mp4',
    )
    expect(Array.isArray(args)).toBe(true)
    for (const a of args) expect(a, a).not.toMatch(/[;&|`$><\n]/)
  })

  it('never passes the source URL to ffmpeg — the worker fetches it itself', () => {
    // ffmpeg reading http directly is a much larger attack surface than a
    // fetch the worker controls and can size-limit.
    const args = ffmpegArgs(spec(), '/tmp/in.mp4', '/tmp/out.mp4')
    expect(args.join(' ')).not.toContain('example.com')
  })

  it('builds the filter chain in the order the operations were given', () => {
    const args = ffmpegArgs(
      spec({ ops: [{ op: 'crop', x: 0, y: 0, width: 720, height: 1280 }, { op: 'scale', width: 360, height: 640 }] }),
      'in',
      'out',
    )
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=720:1280:0:0,scale=360:640')
  })

  it('seeks before the input and limits after it', () => {
    const args = ffmpegArgs(spec({ ops: [{ op: 'trim', startSec: 3, durationSec: 5 }] }), 'in', 'out')
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'))
    expect(args).toContain('-accurate_seek')
  })

  it('drops audio for a mute job and keeps it otherwise', () => {
    expect(ffmpegArgs(spec({ ops: [{ op: 'mute' }] }), 'in', 'out')).toContain('-an')
    expect(ffmpegArgs(spec({ ops: [{ op: 'fps', fps: 24 }] }), 'in', 'out')).toContain('aac')
  })

  it('always writes a probe-able file — faststart is what lets grading read it', () => {
    const args = ffmpegArgs(spec(), 'in', 'out')
    expect(args).toContain('+faststart')
  })

  it('never waits on stdin, which would hang a background worker with no explanation', () => {
    expect(ffmpegArgs(spec(), 'in', 'out')).toContain('-nostdin')
  })
})

describe('grading a delivered render', () => {
  const SAMPLE = new Uint8Array(readFileSync('tests/fixtures/probe-sample.mp4'))
  // The fixture is a real 160x120, 1.0s, video+audio MP4 from ffmpeg.

  it('passes a file that matches what was asked for', () => {
    const v = gradeRender({ width: 160, height: 120, durationSec: 1, hasAudio: true }, SAMPLE)
    expect(v.passed).toBe(true)
    expect(v.checks.every((c) => c.ok)).toBe(true)
  })

  it('fails on the actual bytes, not on the worker s word for them', () => {
    const v = gradeRender({ width: 1080, height: 1920 }, SAMPLE)
    expect(v.passed).toBe(false)
    expect(v.checks.find((c) => c.name === 'width')).toMatchObject({ expected: '1080px', actual: '160px', ok: false })
  })

  it('allows frame-boundary slack on duration but not a different clip', () => {
    expect(gradeRender({ durationSec: 1 + DURATION_TOLERANCE_SEC * 0.5 }, SAMPLE).passed).toBe(true)
    expect(gradeRender({ durationSec: 5 }, SAMPLE).passed).toBe(false)
  })

  it('catches a silent render sold as having audio, and the reverse', () => {
    expect(gradeRender({ hasAudio: false }, SAMPLE).passed).toBe(false)
    expect(gradeRender({ hasAudio: true }, SAMPLE).passed).toBe(true)
  })

  it('fails a file that is not a video at all, and says so', () => {
    const v = gradeRender({ width: 160 }, new TextEncoder().encode('I promise this is a video'))
    expect(v.passed).toBe(false)
    expect(v.error).toBeTruthy()
    expect(v.probe).toBeNull()
  })

  it('passes with no checks when the requester stated no criteria', () => {
    // Honest rather than generous: nobody was given grounds to refuse.
    const v = gradeRender({}, SAMPLE)
    expect(v.passed).toBe(true)
    expect(v.checks).toEqual([])
  })
})

describe('carrying a spec inside a task', () => {
  const block = (json: string) => `Make me a vertical cut of this clip.\n\n\`\`\`handsel-media\n${json}\n\`\`\`\n`

  it('finds the fenced block in an otherwise human brief', () => {
    const s = extractMediaSpec(
      block(JSON.stringify({ sourceUrl: SRC, ops: [{ op: 'scale', width: 720, height: 1280 }] })),
    )
    expect(s?.must).toEqual({ width: 720, height: 1280 })
  })

  it('returns null for an ordinary text job rather than throwing', () => {
    expect(extractMediaSpec('Write me a haiku about deposits.')).toBeNull()
    expect(extractMediaSpec(null)).toBeNull()
  })

  it('throws when a block IS present and malformed', () => {
    // Silently falling back to "text job" is how a worker ends up writing an
    // essay about cropping a video.
    expect(() => extractMediaSpec(block('{ not json'))).toThrow(/not valid JSON/)
    expect(() => extractMediaSpec(block(JSON.stringify({ sourceUrl: SRC, ops: [{ op: 'nope' }] })))).toThrow(
      /not a known operation/,
    )
  })
})
