/**
 * A media job is a validated recipe, not a prompt.
 *
 * The obvious way to let agents do video work is to hand a model a sentence
 * and a shell. That fails three ways at once and all three matter here:
 *
 *   - **Unsafe.** A model writing `ffmpeg -i "$URL" ...` into a shell, from
 *     a task a stranger posted, on somebody's own machine. The worker docs
 *     already shout about `--allow-bash` for good reason; handing that to a
 *     job description is worse.
 *   - **Ungradeable.** "Crop it to vertical" has no pass condition. This
 *     platform pays on pass, so a job whose success cannot be checked is a
 *     job that cannot be sold.
 *   - **Irreproducible.** Two workers given the same sentence produce
 *     different commands, so the same job grades differently depending on
 *     who claimed it — which quietly makes the credit score noise.
 *
 * So the requester states operations and the acceptance criteria; the
 * PLATFORM compiles the ffmpeg invocation from validated numbers, as an
 * argv array with no shell anywhere in it, and the output is checked
 * against the criteria by reading the produced file's own container header
 * (`lib/mp4-probe.ts`). The model is not in the loop for either half. What
 * the worker contributes is a machine with ffmpeg on it.
 *
 * That is also why this is the media lane's whole design and not a
 * convenience: it is the only version where "it rendered correctly" is a
 * fact somebody other than the worker can establish.
 */
import { probeMp4, Mp4ParseError, type Mp4Probe } from '@/lib/mp4-probe'

export class MediaSpecError extends Error {}

export type MediaOp =
  | { op: 'trim'; startSec: number; durationSec: number }
  | { op: 'crop'; x: number; y: number; width: number; height: number }
  | { op: 'scale'; width: number; height: number }
  | { op: 'fps'; fps: number }
  | { op: 'mute' }

export type MediaMust = {
  width?: number
  height?: number
  durationSec?: number
  hasAudio?: boolean
}

export type MediaSpec = {
  sourceUrl: string
  ops: MediaOp[]
  must: MediaMust
}

/* Bounds. Every one of these is a refusal a worker would otherwise discover
   as a crash or a nine-hour render, and the requester would discover as a
   failed job they still have to argue about. */
export const MAX_OPS = 8
export const MAX_DIMENSION = 7680
export const MAX_DURATION_SEC = 600
export const MAX_FPS = 120
/** Frame-boundary rounding means an exact duration never comes back exact. */
export const DURATION_TOLERANCE_SEC = 0.2

function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new MediaSpecError(`${name} must be a number`)
  if (!Number.isInteger(n)) throw new MediaSpecError(`${name} must be a whole number, got ${n}`)
  if (n < min || n > max) throw new MediaSpecError(`${name} must be between ${min} and ${max}, got ${n}`)
  return n
}

function seconds(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new MediaSpecError(`${name} must be a number of seconds`)
  if (n < min || n > max) throw new MediaSpecError(`${name} must be between ${min} and ${max}s, got ${n}`)
  // Millisecond resolution: ffmpeg accepts more, but a value with sixteen
  // decimal places in an argv is a rounding argument waiting to happen at
  // grading time.
  return Math.round(n * 1000) / 1000
}

/** h264 in yuv420p cannot encode an odd dimension — chroma is subsampled 2x. */
function even(n: number, name: string): number {
  if (n % 2 !== 0) throw new MediaSpecError(`${name} must be even (${n} is odd) — h264 cannot encode odd dimensions`)
  return n
}

/**
 * Where a source may be fetched from.
 *
 * Deliberately narrow, and deliberately NOT complete. Blocking the obvious
 * private literals stops the accidental and the lazy; it does not stop a
 * public hostname that resolves to 169.254.169.254, because a name cannot be
 * resolved from a pure function. The worker re-checks the ADDRESS it
 * actually connected to — this is the first of two gates, not the only one.
 */
const BLOCKED_HOSTS =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|metadata\.)/i

export function validateSourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new MediaSpecError('sourceUrl is required')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new MediaSpecError(`sourceUrl is not a URL: ${String(raw).slice(0, 80)}`)
  }
  if (url.protocol !== 'https:') throw new MediaSpecError('sourceUrl must be https')
  // Credentials in a URL end up in logs, in the run telemetry, and on a
  // console page. There is no version of this that is worth supporting.
  if (url.username || url.password) throw new MediaSpecError('sourceUrl must not carry credentials')
  if (BLOCKED_HOSTS.test(url.hostname)) throw new MediaSpecError(`sourceUrl host is not allowed: ${url.hostname}`)
  return url.toString()
}

function parseOp(raw: unknown, i: number): MediaOp {
  if (!raw || typeof raw !== 'object') throw new MediaSpecError(`ops[${i}] must be an object`)
  const r = raw as Record<string, unknown>
  switch (r.op) {
    case 'trim':
      return {
        op: 'trim',
        startSec: seconds(r.startSec, `ops[${i}].startSec`, 0, MAX_DURATION_SEC),
        durationSec: seconds(r.durationSec, `ops[${i}].durationSec`, 0.04, MAX_DURATION_SEC),
      }
    case 'crop':
      return {
        op: 'crop',
        x: int(r.x, `ops[${i}].x`, 0, MAX_DIMENSION),
        y: int(r.y, `ops[${i}].y`, 0, MAX_DIMENSION),
        width: even(int(r.width, `ops[${i}].width`, 2, MAX_DIMENSION), `ops[${i}].width`),
        height: even(int(r.height, `ops[${i}].height`, 2, MAX_DIMENSION), `ops[${i}].height`),
      }
    case 'scale':
      return {
        op: 'scale',
        width: even(int(r.width, `ops[${i}].width`, 2, MAX_DIMENSION), `ops[${i}].width`),
        height: even(int(r.height, `ops[${i}].height`, 2, MAX_DIMENSION), `ops[${i}].height`),
      }
    case 'fps':
      return { op: 'fps', fps: int(r.fps, `ops[${i}].fps`, 1, MAX_FPS) }
    case 'mute':
      return { op: 'mute' }
    default:
      throw new MediaSpecError(`ops[${i}].op is not a known operation: ${String(r.op).slice(0, 40)}`)
  }
}

/**
 * What the output must be, as far as the operations alone determine it.
 *
 * A scale or a crop fixes the dimensions; a trim fixes the duration; a mute
 * fixes the audio. Anything the ops do not determine (the duration of a
 * crop-only job, which depends on a source nobody has read yet) is simply
 * absent, and the requester has to state it if they want it graded.
 */
export function deriveMust(ops: readonly MediaOp[]): MediaMust {
  const must: MediaMust = {}
  for (const op of ops) {
    if (op.op === 'crop' || op.op === 'scale') {
      must.width = op.width
      must.height = op.height
    } else if (op.op === 'trim') {
      must.durationSec = op.durationSec
    } else if (op.op === 'mute') {
      must.hasAudio = false
    }
  }
  return must
}

export function parseMediaSpec(raw: unknown): MediaSpec {
  if (!raw || typeof raw !== 'object') throw new MediaSpecError('A media spec must be an object')
  const r = raw as Record<string, unknown>
  const sourceUrl = validateSourceUrl(r.sourceUrl)

  if (!Array.isArray(r.ops) || r.ops.length === 0) throw new MediaSpecError('ops must be a non-empty array')
  if (r.ops.length > MAX_OPS) throw new MediaSpecError(`at most ${MAX_OPS} operations, got ${r.ops.length}`)
  const ops = r.ops.map(parseOp)

  const derived = deriveMust(ops)
  const stated = (r.must ?? {}) as Record<string, unknown>
  const must: MediaMust = { ...derived }
  if (stated.width !== undefined) must.width = even(int(stated.width, 'must.width', 2, MAX_DIMENSION), 'must.width')
  if (stated.height !== undefined) must.height = even(int(stated.height, 'must.height', 2, MAX_DIMENSION), 'must.height')
  if (stated.durationSec !== undefined) must.durationSec = seconds(stated.durationSec, 'must.durationSec', 0.04, MAX_DURATION_SEC)
  if (stated.hasAudio !== undefined) must.hasAudio = Boolean(stated.hasAudio)

  // A spec whose acceptance criteria contradict its own operations can never
  // pass, and refusing it here costs nothing where discovering it after a
  // render costs a bounty, a worker's time and an argument about grading.
  for (const key of ['width', 'height', 'durationSec'] as const) {
    const d = derived[key]
    const m = must[key]
    if (d !== undefined && m !== undefined && Math.abs(d - m) > (key === 'durationSec' ? DURATION_TOLERANCE_SEC : 0)) {
      throw new MediaSpecError(
        `must.${key} is ${m} but the operations produce ${d} — this job could never pass`,
      )
    }
  }
  if (must.hasAudio === true && ops.some((o) => o.op === 'mute')) {
    throw new MediaSpecError('must.hasAudio is true but the operations include mute — this job could never pass')
  }

  return { sourceUrl, ops, must }
}

/**
 * The ffmpeg invocation, as argv.
 *
 * An array, never a string, and never through a shell: nothing a requester
 * typed reaches this except numbers that have already been range-checked,
 * and the paths are the worker's own temp files rather than anything from
 * the spec. `-nostdin` because a stray prompt from ffmpeg would hang a
 * background worker forever with no output to explain it.
 */
/** Placeholders the worker replaces with its own temp paths. Distinctive
 *  enough that a substitution cannot collide with a real argument. */
export const MEDIA_INPUT_TOKEN = '__HANDSEL_INPUT__'
export const MEDIA_OUTPUT_TOKEN = '__HANDSEL_OUTPUT__'

export function ffmpegArgs(spec: MediaSpec, inputPath: string, outputPath: string): string[] {
  const filters: string[] = []
  let trim: { startSec: number; durationSec: number } | null = null
  let mute = false

  for (const op of spec.ops) {
    switch (op.op) {
      case 'crop':
        filters.push(`crop=${op.width}:${op.height}:${op.x}:${op.y}`)
        break
      case 'scale':
        filters.push(`scale=${op.width}:${op.height}`)
        break
      case 'fps':
        filters.push(`fps=${op.fps}`)
        break
      case 'trim':
        trim = op
        break
      case 'mute':
        mute = true
        break
    }
  }

  const args = ['-nostdin', '-y']
  // Seek BEFORE -i: input seeking jumps by keyframe and is orders of
  // magnitude faster on a long source. `-accurate_seek` keeps it frame-exact,
  // which matters because the duration is then graded against the spec.
  if (trim) args.push('-accurate_seek', '-ss', String(trim.startSec))
  args.push('-i', inputPath)
  if (trim) args.push('-t', String(trim.durationSec))
  if (filters.length > 0) args.push('-vf', filters.join(','))
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p')
  // faststart moves the moov box to the front. Not cosmetic here: a file
  // with its moov at the end cannot be probed until the last byte arrives,
  // and lib/mp4-probe.ts is what decides whether this job gets paid.
  args.push('-movflags', '+faststart')
  args.push(...(mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']))
  args.push(outputPath)
  return args
}

/**
 * Pull a media spec out of a task description.
 *
 * Fenced, exactly like the repo lane carries its diff — one convention for
 * "the structured part of an otherwise human-readable brief", so a requester
 * writes a normal task and appends the machine-readable half:
 *
 *   ```handsel-media
 *   { "sourceUrl": "https://…/clip.mp4", "ops": [ { "op": "crop", … } ] }
 *   ```
 *
 * Returns null when there is no block — that is a normal text job, not an
 * error. Throws `MediaSpecError` when there IS a block and it is wrong,
 * because silently treating a malformed media job as a prose job is how a
 * worker ends up writing an essay about cropping a video.
 */
const MEDIA_FENCE = /```[ \t]*handsel-media[ \t]*\r?\n([\s\S]*?)```/i

export function extractMediaSpec(text: unknown): MediaSpec | null {
  if (typeof text !== 'string') return null
  const m = MEDIA_FENCE.exec(text)
  if (!m) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1])
  } catch (e) {
    throw new MediaSpecError(`The handsel-media block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseMediaSpec(parsed)
}

export type MediaCheck = {
  name: string
  expected: string
  actual: string
  ok: boolean
}

export type MediaVerdict = {
  passed: boolean
  checks: MediaCheck[]
  /** Present when the file could not be read at all. */
  error: string | null
  probe: Mp4Probe | null
}

/**
 * Grade a rendered file against the spec it was rendered from.
 *
 * Reads the delivered bytes, not the worker's report of them. An empty
 * `must` grades as a pass with no checks, and that is honest rather than
 * generous: a requester who stated no acceptance criteria has not been given
 * grounds to refuse the work.
 */
export function gradeRender(must: MediaMust, bytes: Uint8Array): MediaVerdict {
  let probe: Mp4Probe
  try {
    probe = probeMp4(bytes)
  } catch (e) {
    return {
      passed: false,
      checks: [],
      error: e instanceof Mp4ParseError ? e.message : `Could not read the delivered file: ${String(e)}`,
      probe: null,
    }
  }

  const checks: MediaCheck[] = []
  const add = (name: string, expected: unknown, actual: unknown, ok: boolean) =>
    checks.push({ name, expected: String(expected), actual: String(actual), ok })

  if (must.width !== undefined) add('width', `${must.width}px`, `${probe.width ?? 'no video track'}px`, probe.width === must.width)
  if (must.height !== undefined) add('height', `${must.height}px`, `${probe.height ?? 'no video track'}px`, probe.height === must.height)
  if (must.durationSec !== undefined) {
    const delta = Math.abs(probe.durationSec - must.durationSec)
    add(
      'duration',
      `${must.durationSec}s ±${DURATION_TOLERANCE_SEC}`,
      `${probe.durationSec.toFixed(3)}s`,
      delta <= DURATION_TOLERANCE_SEC,
    )
  }
  if (must.hasAudio !== undefined) add('audio', must.hasAudio ? 'present' : 'absent', probe.hasAudio ? 'present' : 'absent', probe.hasAudio === must.hasAudio)

  return { passed: checks.every((c) => c.ok), checks, error: null, probe }
}
