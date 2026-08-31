import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Mp4ParseError, probeMp4 } from '@/lib/mp4-probe'

/**
 * A real file, not a hand-built box tree.
 *
 * The whole value of this parser is that it agrees with what ffmpeg
 * actually writes, so the fixture is a 160x120, 1.0s, video+audio MP4
 * produced by `ffmpeg -f lavfi -i testsrc ... -c:v libx264 -c:a aac`. A
 * synthetic byte tree would only ever prove the parser agrees with my
 * reading of the spec, which is the thing most likely to be wrong.
 */
const SAMPLE = new Uint8Array(readFileSync('tests/fixtures/probe-sample.mp4'))

describe('probing a real MP4', () => {
  it('reads the dimensions ffprobe reports', () => {
    const p = probeMp4(SAMPLE)
    expect(p.width).toBe(160)
    expect(p.height).toBe(120)
  })

  it('reads the duration ffprobe reports', () => {
    expect(probeMp4(SAMPLE).durationSec).toBeCloseTo(1.0, 2)
  })

  it('finds both tracks and tells them apart by handler', () => {
    const p = probeMp4(SAMPLE)
    expect(p.hasVideo).toBe(true)
    expect(p.hasAudio).toBe(true)
    expect(p.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'video'])
  })

  it('takes dimensions from the VIDEO track, not whichever track came first', () => {
    // An audio sample entry has a sample RATE where a visual one has width,
    // so reading stsd on the wrong track reports a 44100-pixel-wide video.
    const p = probeMp4(SAMPLE)
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    expect(audio.width).toBeNull()
    expect(p.width).toBe(160)
  })

  it('reports the brand, so a rejection can say what the file actually was', () => {
    expect(probeMp4(SAMPLE).majorBrand).toBeTruthy()
  })
})

describe('coded size versus display size', () => {
  /**
   * The trap that only showed up on a real crop.
   *
   * This fixture is 120x120 scaled to 60x160, so its pixels are not square:
   * ffmpeg encodes a 60x160 frame and writes a DISPLAY size into `tkhd`
   * that preserves the original aspect. Grading a paid render against
   * `tkhd` fails a correct file — which is exactly what the first version
   * of this parser did.
   */
  const ANAMORPHIC = new Uint8Array(readFileSync('tests/fixtures/probe-anamorphic.mp4'))

  it('reports the coded frame, matching what ffprobe prints', () => {
    const p = probeMp4(ANAMORPHIC)
    expect(p.width).toBe(60)
    expect(p.height).toBe(160)
  })

  it('still exposes the display size, which is a different number here', () => {
    const p = probeMp4(ANAMORPHIC)
    expect(p.displayWidth).not.toBe(p.width)
  })

  it('agrees with itself on a square-pixel file', () => {
    const p = probeMp4(SAMPLE)
    expect(p.displayWidth).toBe(p.width)
    expect(p.displayHeight).toBe(p.height)
  })
})

describe('refusing what is not an MP4', () => {
  it('rejects an empty or tiny buffer', () => {
    expect(() => probeMp4(new Uint8Array(0))).toThrow(Mp4ParseError)
    expect(() => probeMp4(new Uint8Array(4))).toThrow(Mp4ParseError)
  })

  it('rejects a file with no recognisable boxes', () => {
    expect(() => probeMp4(new TextEncoder().encode('not a video at all, just prose'))).toThrow(Mp4ParseError)
  })

  it('names a truncated file rather than returning zeros', () => {
    // Everything up to but not including moov. A caller must be able to tell
    // "still uploading" apart from "a zero-second video".
    const cut = SAMPLE.slice(0, 40)
    expect(() => probeMp4(cut)).toThrow(/truncated|moov|boxes/i)
  })

  it('terminates on a box whose size points backwards', () => {
    // Fed by an untrusted worker: a zero-advance size must not spin forever.
    const evil = new Uint8Array(64)
    evil.set([0, 0, 0, 2, 0x66, 0x74, 0x79, 0x70], 0) // size 2 < header
    expect(() => probeMp4(evil)).toThrow(Mp4ParseError)
  })

  it('does not walk backwards on a box size with the high bit set', () => {
    // `b[at] << 24` is negative in JS for any size over 2GB; unsigned
    // arithmetic is what stops that becoming an infinite loop.
    const evil = new Uint8Array(64)
    evil.set([0xff, 0xff, 0xff, 0xf0, 0x66, 0x74, 0x79, 0x70], 0)
    expect(() => probeMp4(evil)).toThrow(Mp4ParseError)
  })
})
