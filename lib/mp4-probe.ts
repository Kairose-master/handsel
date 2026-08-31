/**
 * Read an MP4's real dimensions and duration out of its own bytes.
 *
 * This exists because of the one rule the whole product rests on: a
 * deliverable is graded by someone other than the worker that produced it.
 * For text that is a grader agent; for a rendered video it has to be the
 * file. A worker that reports "here is your 1080x1920, 15 seconds" is
 * self-reporting, and `docs/positioning.md` is blunt about what a
 * self-reported number is worth. Nothing checks the pixels — but the
 * container header is not an opinion, and a worker cannot lie about it
 * without producing a file that genuinely has those properties.
 *
 * Pure, dependency-free and server-side on purpose. The platform runs on
 * Vercel functions where there is no ffprobe to shell out to, and adding a
 * WASM decoder to verify a header would be a lot of machinery for four
 * integers that sit at known offsets in a box structure ISO/IEC 14496-12 has
 * not changed in twenty years.
 *
 * What it reads, and nothing more: `mvhd` for timescale and duration, the
 * sample description (`stsd`) for the coded frame size, `tkhd` for the
 * display size, `hdlr` to tell which track is the video one. It does not
 * decode a single frame, so it can tell you the
 * file CLAIMS to be 1080x1920 for fifteen seconds; it cannot tell you the
 * frames are not black. That limit is real and is why this returns evidence
 * for a grader rather than a verdict of its own.
 */

export type Mp4Track = {
  kind: 'video' | 'audio' | 'other'
  /** Coded pixels, from the sample description. Null on non-video tracks. */
  width: number | null
  height: number | null
  /** What `tkhd` says to DISPLAY the track at. Differs from the coded size
   *  whenever the pixels are not square. */
  displayWidth: number
  displayHeight: number
}

export type Mp4Probe = {
  /** Seconds, from the movie header's duration/timescale. */
  durationSec: number
  /**
   * The video track's CODED dimensions — the number of pixels actually
   * encoded, which is what ffprobe prints and what anybody means by
   * "1080x1920". Null when there is no video track.
   */
  width: number | null
  height: number | null
  /**
   * What the container asks a player to DISPLAY it at.
   *
   * Not the same number, and the difference is not academic: crop a square
   * out of a 640x480 clip and scale it to 720x1280 and ffmpeg preserves the
   * original aspect by writing 1280x1280 into `tkhd` while the coded frame
   * is 720x1280. Grading a paid render on the display size would fail that
   * job — the first version of this parser did exactly that, and it took
   * running a real crop to notice.
   */
  displayWidth: number | null
  displayHeight: number | null
  hasVideo: boolean
  hasAudio: boolean
  /** `isom`, `mp42`, … from `ftyp`. Useful for saying WHY a file was rejected. */
  majorBrand: string | null
  tracks: Mp4Track[]
}

export class Mp4ParseError extends Error {}

/* A box is [size:u32][type:4cc][payload]. size 1 means a 64-bit size follows
   the type; size 0 means "to the end of the file". */
const HEADER = 8

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1]
}
function u32(b: Uint8Array, at: number): number {
  // Unsigned: `<<24` on a byte with the high bit set produces a negative
  // number in JS, which turns a perfectly valid box size into a parse that
  // walks backwards through the file.
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
}
function u64(b: Uint8Array, at: number): number {
  // Two 32-bit halves rather than BigInt: durations and offsets here are far
  // below 2^53, and returning a Number keeps every caller arithmetic-simple.
  return u32(b, at) * 4294967296 + u32(b, at + 4)
}
function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
}
/** 16.16 fixed point, which is how tkhd stores display dimensions. */
function fixed1616(b: Uint8Array, at: number): number {
  return u32(b, at) / 65536
}

type Box = { type: string; start: number; end: number; payload: number }

/** Immediate children of the region [from, to). */
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + HEADER <= to) {
    let size = u32(b, at)
    const type = fourcc(b, at + 4)
    let payload = at + HEADER
    if (size === 1) {
      if (at + 16 > to) break
      size = u64(b, at + 8)
      payload = at + 16
    } else if (size === 0) {
      size = to - at
    }
    // A size that does not advance, or runs past the region, means the file
    // is not what it says it is. Stop rather than loop forever on it — this
    // parser is fed bytes an untrusted worker uploaded.
    if (size < HEADER || at + size > to) break
    out.push({ type, start: at, end: at + size, payload })
    at += size
  }
  return out
}

function find(boxes: Box[], type: string): Box | undefined {
  return boxes.find((x) => x.type === type)
}

function readMvhd(b: Uint8Array, box: Box): number {
  const version = b[box.payload]
  // v0: creation(4) modification(4) timescale(4) duration(4)
  // v1: creation(8) modification(8) timescale(4) duration(8)
  const at = box.payload + 4
  const timescale = version === 1 ? u32(b, at + 16) : u32(b, at + 8)
  const duration = version === 1 ? u64(b, at + 20) : u32(b, at + 12)
  if (!timescale) return 0
  return duration / timescale
}

function readTkhd(b: Uint8Array, box: Box): { width: number; height: number } {
  // Width and height are the LAST eight bytes of the box in BOTH versions,
  // which is far more robust than counting forward past the 36-byte matrix
  // and a version-dependent run of timestamps.
  const w = box.end - 8
  return { width: fixed1616(b, w), height: fixed1616(b, w + 4) }
}

/**
 * Coded dimensions, from the first visual entry of the sample description.
 *
 * `stsd` holds one entry per sample format; a visual entry (avc1, hvc1, …)
 * carries width and height as plain 16-bit integers at a fixed offset. An
 * AUDIO entry has other things at those bytes — a sample rate reads as a
 * 44100-pixel-wide video — so this is only ever called for a track whose
 * handler already said 'vide'.
 */
function readCodedSize(b: Uint8Array, mdia: Box): { width: number; height: number } | null {
  const minf = find(children(b, mdia.payload, mdia.end), 'minf')
  if (!minf) return null
  const stbl = find(children(b, minf.payload, minf.end), 'stbl')
  if (!stbl) return null
  const stsd = find(children(b, stbl.payload, stbl.end), 'stsd')
  if (!stsd) return null
  // version+flags(4) entry_count(4), then the first entry.
  const entry = stsd.payload + 8
  // Within a visual sample entry: size(4) format(4) reserved(6)
  // data_reference_index(2) pre_defined(2) reserved(2) pre_defined(12)
  // width(2) height(2)  →  width at +32.
  if (entry + 36 > stsd.end) return null
  return { width: u16(b, entry + 32), height: u16(b, entry + 34) }
}

function readHandler(b: Uint8Array, mdia: Box): 'video' | 'audio' | 'other' {
  const hdlr = find(children(b, mdia.payload, mdia.end), 'hdlr')
  if (!hdlr) return 'other'
  // version+flags(4) pre_defined(4) handler_type(4)
  const type = fourcc(b, hdlr.payload + 8)
  if (type === 'vide') return 'video'
  if (type === 'soun') return 'audio'
  return 'other'
}

/**
 * Probe an MP4/MOV. Throws `Mp4ParseError` on anything that is not one —
 * the caller wants to say "that is not a video file", not to receive zeros
 * that look like a very short one.
 */
export function probeMp4(bytes: Uint8Array): Mp4Probe {
  if (bytes.length < 16) throw new Mp4ParseError('File is too short to be an MP4')
  const top = children(bytes, 0, bytes.length)
  if (top.length === 0) throw new Mp4ParseError('No MP4 boxes found — is this an MP4?')

  const ftyp = find(top, 'ftyp')
  const majorBrand = ftyp ? fourcc(bytes, ftyp.payload).trim() : null

  const moov = find(top, 'moov')
  if (!moov) {
    // Real and worth naming: a file still being written, or one muxed
    // without +faststart and truncated, has its moov at the end or not yet.
    throw new Mp4ParseError('No moov box — the file is truncated or still being written')
  }

  const moovKids = children(bytes, moov.payload, moov.end)
  const mvhd = find(moovKids, 'mvhd')
  if (!mvhd) throw new Mp4ParseError('No mvhd box — cannot read duration')
  const durationSec = readMvhd(bytes, mvhd)

  const tracks: Mp4Track[] = []
  for (const trak of moovKids.filter((x) => x.type === 'trak')) {
    const kids = children(bytes, trak.payload, trak.end)
    const tkhd = find(kids, 'tkhd')
    const mdia = find(kids, 'mdia')
    if (!tkhd) continue
    const display = readTkhd(bytes, tkhd)
    const kind = mdia ? readHandler(bytes, mdia) : 'other'
    const coded = kind === 'video' && mdia ? readCodedSize(bytes, mdia) : null
    tracks.push({
      kind,
      width: coded ? coded.width : null,
      height: coded ? coded.height : null,
      displayWidth: Math.round(display.width),
      displayHeight: Math.round(display.height),
    })
  }

  const video = tracks.find((t) => t.kind === 'video')
  return {
    durationSec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    displayWidth: video ? video.displayWidth : null,
    displayHeight: video ? video.displayHeight : null,
    hasVideo: Boolean(video),
    hasAudio: tracks.some((t) => t.kind === 'audio'),
    majorBrand,
    tracks,
  }
}
