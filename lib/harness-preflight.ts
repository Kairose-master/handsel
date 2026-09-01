/**
 * Prove the harness runs before staking a bond on it.
 *
 * A worker claims a job, stakes a bond, and only then discovers its harness
 * cannot run. The job's deadline then expires with the escrow held and the
 * bond destroyed by `reclaimJob` — the worker pays for a defect that was
 * detectable on its own machine before it ever touched the market.
 *
 * What the worker checked until now was `which claude`. That answers one
 * question of the three that matter:
 *
 *   - is the binary there?          `which` answers this
 *   - does it actually start?       `which` says nothing
 *   - is it logged in?              `which` says nothing, and this is the
 *                                   one that fails in real life
 *
 * A harness installed and not authenticated is the ordinary state of a fresh
 * machine. It resolves on PATH, spawns cleanly, and exits non-zero on every
 * task with a message on stderr that no on-PATH check will ever read. Worse,
 * `--harness-cmd` had no check at all: a typo in the binary name started the
 * worker happily and turned every claim into an ENOENT after the bond.
 *
 * So preflight RUNS the thing. Once, with a trivial brief, and it reads the
 * answer. Everything here is pure — the spawning lives in the worker, mirrored
 * the way lib/worker-harness.ts is, with tests/worker-harness.test.ts's parity
 * check as the precedent.
 */

/** The probe asks for one word, so a harness that works costs almost nothing
 *  to verify and a harness that is broken says so in the same breath. */
export const PROBE_SENTINEL = 'HANDSEL_PREFLIGHT_OK'

export function probeBrief(): string {
  return [
    `Reply with exactly this word and nothing else: ${PROBE_SENTINEL}`,
    '',
    'This is an automated readiness check, not a task. Do not use any tools,',
    'do not read or write files, and do not explain. One word.',
  ].join('\n')
}

/** A harness that has not answered in this long is not going to. Short on
 *  purpose: this runs before every session, and a two-minute wait to learn
 *  the tool is fine is a two-minute wait nobody will keep paying. */
export const PROBE_TIMEOUT_MS = 90_000

export type ProbeResult = {
  /** Null when the process never started at all (ENOENT and friends). */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The spawn error's code, when there was one. */
  spawnError?: string | null
}

export type PreflightVerdict =
  | { ok: true; note: string }
  | { ok: false; failure: PreflightFailure; message: string; hint: string }

export type PreflightFailure = 'not-found' | 'not-authenticated' | 'timed-out' | 'crashed' | 'no-output'

/**
 * Phrases that mean "the tool is fine, you are not signed in".
 *
 * Matched against the harness's own stderr because there is no shared exit
 * code for it — every one of these tools reports auth failure as a non-zero
 * exit with prose. Getting this wrong in the safe direction just means the
 * generic "crashed" message, which still refuses to start; getting it right
 * means the owner is told to run `claude login` instead of reading a stack
 * trace.
 */
const AUTH_PHRASES = [
  'not logged in',
  'not authenticated',
  'unauthenticated',
  'please log in',
  'please login',
  'run `login`',
  'login required',
  'authentication required',
  'invalid api key',
  'missing api key',
  'no api key',
  'api key not found',
  'set anthropic_api_key',
  'set openai_api_key',
  'unauthorized',
  '401',
  'credentials',
  'expired token',
  'session expired',
]

const NOT_FOUND_CODES = new Set(['enoent', 'eacces', 'enotdir'])

/**
 * Read the probe.
 *
 * Order matters: a spawn failure is checked before an exit code, because a
 * process that never started has no exit code and `null` would otherwise fall
 * through to "crashed" and tell the owner to check their logs for a binary
 * that does not exist.
 */
export function probeVerdict(input: {
  bin: string
  result: ProbeResult
  install?: string | null
}): PreflightVerdict {
  const { bin, result } = input
  const install = input.install ? ` Install it with: ${input.install}` : ''
  const haystack = `${result.stderr}\n${result.stdout}`.toLowerCase()

  if (result.spawnError && NOT_FOUND_CODES.has(result.spawnError.toLowerCase())) {
    return {
      ok: false,
      failure: 'not-found',
      message: `\`${bin}\` could not be run on this machine.`,
      hint: `Check the name and that it is on PATH.${install}`,
    }
  }

  if (result.timedOut) {
    return {
      ok: false,
      failure: 'timed-out',
      message: `\`${bin}\` did not answer a one-word prompt within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s.`,
      // The overwhelmingly common cause, and the one a headless run can never
      // recover from: the tool is waiting for a human who is not there.
      hint: 'It is most likely waiting for input — a login prompt, a trust-this-directory question, or a first-run setup step. Run it once by hand in a terminal and answer whatever it asks.',
    }
  }

  // Auth is checked before the exit code because it IS a non-zero exit, and
  // "exited 1" is the least useful true thing that could be said about it.
  if (AUTH_PHRASES.some((p) => haystack.includes(p))) {
    return {
      ok: false,
      failure: 'not-authenticated',
      message: `\`${bin}\` is installed but not signed in.`,
      hint: `Authenticate it once by hand — for most harnesses that is \`${bin} login\` or an API key in the environment — then start the worker again.`,
    }
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      failure: 'crashed',
      message: `\`${bin}\` exited ${result.exitCode ?? 'without a status'} on a one-word prompt.`,
      hint: firstLine(result.stderr) || 'Run the same command by hand to see what it says.',
    }
  }

  if (!`${result.stdout}${result.stderr}`.trim()) {
    return {
      ok: false,
      failure: 'no-output',
      message: `\`${bin}\` exited cleanly but produced nothing.`,
      hint: 'A harness that prints nothing cannot deliver work either. Check that it is configured with a model.',
    }
  }

  // The sentinel is NOT required. Any tool that answered at all has proven the
  // three things this exists to prove — it starts, it is authenticated, it
  // reaches a model — and demanding exact obedience on a one-word instruction
  // would refuse to start over a harness that politely said "Sure! HANDSEL…".
  const echoed = `${result.stdout}`.includes(PROBE_SENTINEL)
  return { ok: true, note: echoed ? 'answered the probe exactly' : 'answered' }
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 300)
}

/* ── Not paying for this on every start ────────────────────────────────── */

export type PreflightCacheEntry = {
  key: string
  at: number
  ok: boolean
}

/**
 * What makes one preflight result apply to a later run.
 *
 * The binary's size and mtime are in the key, so an upgrade re-probes: a tool
 * that was authenticated at v1 and changed its auth model at v2 is exactly the
 * case a time-based cache alone would sail past.
 */
export function preflightKey(input: {
  harnessId: string
  bin: string
  binSize?: number | null
  binMtimeMs?: number | null
  /** Distinguishes two --harness-cmd definitions using the same binary. */
  argvShape?: string | null
}): string {
  return [input.harnessId, input.bin, input.binSize ?? '?', Math.round(input.binMtimeMs ?? 0), input.argvShape ?? '']
    .join('|')
}

/** A pass is trusted for a day. Long enough that nobody pays for the probe
 *  twice in a working session; short enough that an expired login is caught
 *  the next morning rather than never. */
export const PREFLIGHT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Only a PASS is ever cached.
 *
 * Caching a failure would mean a worker that stays refused for a day after the
 * owner fixed the very thing it complained about — turning a two-second retry
 * into a mystery. Failures are cheap to re-check precisely because the harness
 * fails fast.
 */
export function cachedPassIsFresh(entry: PreflightCacheEntry | null | undefined, key: string, now: number): boolean {
  if (!entry || !entry.ok) return false
  if (entry.key !== key) return false
  return now - entry.at < PREFLIGHT_TTL_MS && entry.at <= now
}
