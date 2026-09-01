import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  PREFLIGHT_TTL_MS,
  PROBE_SENTINEL,
  cachedPassIsFresh,
  preflightKey,
  probeBrief,
  probeVerdict,
  type ProbeResult,
} from '@/lib/harness-preflight'

const NOW = 1_790_000_000_000
const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  exitCode: 0,
  stdout: PROBE_SENTINEL,
  stderr: '',
  timedOut: false,
  spawnError: null,
  ...over,
})
const verdict = (over: Partial<ProbeResult> = {}, install: string | null = 'npm i -g x') =>
  probeVerdict({ bin: 'claude', result: result(over), install })

describe('the three questions which(1) cannot answer', () => {
  it('passes a harness that answers', () => {
    expect(verdict()).toMatchObject({ ok: true })
  })

  it('names a missing binary as missing, not as a crash', () => {
    // A process that never started has no exit code. Reading that null as
    // "exited without a status" would send someone to their logs looking for
    // a binary that is not installed.
    const v = verdict({ spawnError: 'ENOENT', exitCode: null })
    expect(v).toMatchObject({ ok: false, failure: 'not-found' })
    expect(v.ok === false && v.hint).toContain('npm i -g x')
  })

  it('calls an unauthenticated harness unauthenticated, not broken', () => {
    // This is the ordinary state of a fresh machine: on PATH, spawns fine,
    // exits 1 on everything. It is also the failure a bond gets destroyed for.
    for (const stderr of [
      'Error: Not logged in. Run `claude login`.',
      'invalid API key provided',
      'HTTP 401 Unauthorized',
      'Your session expired, please log in again',
      'ANTHROPIC_API_KEY not found — set ANTHROPIC_API_KEY',
    ]) {
      const v = verdict({ exitCode: 1, stdout: '', stderr })
      expect(v, stderr).toMatchObject({ ok: false, failure: 'not-authenticated' })
    }
  })

  it('reads auth failure ahead of the exit code, because it IS a non-zero exit', () => {
    const v = verdict({ exitCode: 1, stdout: '', stderr: 'not logged in' })
    expect(v.ok === false && v.failure).toBe('not-authenticated')
    expect(v.ok === false && v.message).not.toContain('exited 1')
  })

  it('blames a hang on a prompt waiting for a human, which is what it always is', () => {
    const v = verdict({ timedOut: true, stdout: '', stderr: '' })
    expect(v).toMatchObject({ ok: false, failure: 'timed-out' })
    expect(v.ok === false && v.hint).toMatch(/login prompt|trust|by hand/i)
  })

  it('refuses a harness that exits cleanly and says nothing', () => {
    // Clean exit, no output: it will "succeed" on every real task too, and
    // submit an empty deliverable that fails grading for no visible reason.
    expect(verdict({ stdout: '', stderr: '' })).toMatchObject({ ok: false, failure: 'no-output' })
  })

  it('quotes the harness rather than inventing an explanation for a crash', () => {
    const v = verdict({ exitCode: 127, stdout: '', stderr: '\n\nsegfault in plugin loader\nmore detail' })
    expect(v).toMatchObject({ ok: false, failure: 'crashed' })
    expect(v.ok === false && v.hint).toBe('segfault in plugin loader')
  })
})

describe('the probe does not demand obedience', () => {
  it('accepts any real answer, not only the sentinel', () => {
    // Refusing to start because a working harness replied "Sure! HANDSEL_…"
    // would fail the machine over a politeness token. Answering at all proves
    // the three things this exists to prove.
    expect(verdict({ stdout: 'Sure thing — here you go.' })).toMatchObject({ ok: true })
    expect(verdict({ stdout: `Sure! ${PROBE_SENTINEL}` })).toMatchObject({ ok: true, note: 'answered the probe exactly' })
  })

  it('asks for one word and tells the harness not to touch anything', () => {
    // A probe that lets a harness start editing files is a probe that can
    // damage a checkout before a single job has been claimed.
    const b = probeBrief()
    expect(b).toContain(PROBE_SENTINEL)
    expect(b).toMatch(/do not use any tools/i)
    expect(b).toMatch(/do not read or write files/i)
  })
})

describe('paying for the probe once, not every start', () => {
  const key = preflightKey({ harnessId: 'claude', bin: 'claude', binSize: 100, binMtimeMs: 5 })

  it('trusts a recent pass for the same binary', () => {
    expect(cachedPassIsFresh({ key, at: NOW, ok: true }, key, NOW + 60_000)).toBe(true)
    expect(cachedPassIsFresh({ key, at: NOW, ok: true }, key, NOW + PREFLIGHT_TTL_MS + 1)).toBe(false)
  })

  it('re-probes after an upgrade, which a time-based cache would sail past', () => {
    // A tool authenticated at v1 that changed its auth model at v2 is exactly
    // the case a TTL alone misses.
    const upgraded = preflightKey({ harnessId: 'claude', bin: 'claude', binSize: 200, binMtimeMs: 9 })
    expect(upgraded).not.toBe(key)
    expect(cachedPassIsFresh({ key, at: NOW, ok: true }, upgraded, NOW + 1)).toBe(false)
  })

  it('separates two --harness-cmd definitions that share a binary', () => {
    const a = preflightKey({ harnessId: 'custom', bin: 'mytool', argvShape: 'run {brief}' })
    const b = preflightKey({ harnessId: 'custom', bin: 'mytool', argvShape: 'review {brief}' })
    expect(a).not.toBe(b)
  })

  it('never caches a failure', () => {
    // A cached failure keeps a worker refused for a day after the owner fixed
    // the exact thing it complained about, and the retry that should have
    // taken two seconds becomes a mystery.
    expect(cachedPassIsFresh({ key, at: NOW, ok: false }, key, NOW + 1)).toBe(false)
  })

  it('distrusts an entry stamped in the future rather than trusting it forever', () => {
    expect(cachedPassIsFresh({ key, at: NOW + 10_000, ok: true }, key, NOW)).toBe(false)
  })
})

describe('the worker runs the same preflight this file describes', () => {
  // lib/harness-preflight.ts is the tested copy; public/handsel-worker.mjs is
  // the one that actually decides whether somebody's machine takes paid work.
  // Same precedent as tests/worker-harness.test.ts: assert against the source
  // so the two cannot drift into disagreeing about when a bond is safe.
  const worker = readFileSync('public/handsel-worker.mjs', 'utf8')

  it('refuses to start rather than refusing each job', () => {
    // Exiting IS the claim gate — a worker that never polls never stakes a
    // bond. Per-task refusal would let the market keep handing this agent work
    // while its credit score paid for a missing login.
    expect(worker).toContain('async function preflightHarness()')
    expect(worker).toMatch(/await preflightHarness\(\)/)
    const callAt = worker.indexOf('await preflightHarness()')
    const pollAt = worker.indexOf('polling every')
    expect(callAt).toBeGreaterThan(0)
    expect(callAt).toBeLessThan(pollAt)
  })

  it('checks the --harness-cmd binary exists, which it did not before', () => {
    // A typo'd binary used to start the worker happily and turn every claim
    // into an ENOENT after the bond was already staked.
    expect(worker).toMatch(/--harness-cmd needs .*on PATH/)
  })

  it('carries the same sentinel and the same auth phrases', () => {
    expect(worker).toContain(PROBE_SENTINEL)
    for (const phrase of ['not logged in', 'invalid api key', 'unauthorized', 'session expired']) {
      expect(worker.toLowerCase(), phrase).toContain(phrase)
    }
  })

  it('reads auth before the exit code in the worker too', () => {
    // The ordering is the whole reason an owner sees "not signed in" instead
    // of "exited 1"; asserted here because it is an ordering, not a value,
    // and a refactor can reverse it without changing any test above.
    const auth = worker.indexOf('AUTH_PHRASES.some')
    const exit = worker.indexOf("failure: 'crashed'")
    expect(auth).toBeGreaterThan(0)
    expect(auth).toBeLessThan(exit)
  })

  it('offers a way out, so preflight can never be the thing that blocks a run', () => {
    expect(worker).toContain('--no-preflight')
  })

  it('caches only passes', () => {
    expect(worker).toContain('async function writePreflightPass(')
    expect(worker).not.toMatch(/writePreflightFail|ok:\s*false\s*\}\)\s*,\s*'utf8'/)
  })
})
