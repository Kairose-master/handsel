import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FULL_LOOP,
  LOOP_STEPS,
  leftoverNote,
  parseStopAfter,
  stepsFor,
  stopsAfter,
} from '@/lib/solana-loop-plan'

describe('parseStopAfter', () => {
  it('no body means the full loop — existing callers are unchanged', () => {
    expect(parseStopAfter(undefined)).toEqual({ ok: true, stopAfter: 'withdraw' })
    expect(parseStopAfter(null)).toEqual({ ok: true, stopAfter: 'withdraw' })
    expect(FULL_LOOP).toBe('withdraw')
  })

  /**
   * The property worth a test of its own: a typo must REFUSE, not run five
   * transactions the caller never asked for.
   */
  it('an unrecognised value refuses instead of defaulting to everything', () => {
    for (const bad of ['pos', 'POST', 'all', '', 3, {}, true]) {
      const out = parseStopAfter(bad)
      expect(out.ok, `${JSON.stringify(bad)} was accepted`).toBe(false)
    }
  })

  it('the refusal lists the valid values', () => {
    const out = parseStopAfter('nope')
    expect(out.ok).toBe(false)
    if (!out.ok) for (const step of LOOP_STEPS) expect(out.error).toContain(step)
  })

  it('accepts each real step', () => {
    for (const step of LOOP_STEPS) expect(parseStopAfter(step)).toEqual({ ok: true, stopAfter: step })
  })
})

describe('stopsAfter / stepsFor', () => {
  it('stopping at post runs one step and skips the rest', () => {
    expect(stepsFor('post')).toEqual(['post'])
    expect(stopsAfter('post', 'post')).toBe(true)
    expect(stopsAfter('post', 'accept')).toBe(true)
  })

  it('the full loop skips nothing', () => {
    expect(stepsFor('withdraw')).toEqual([...LOOP_STEPS])
    for (const step of LOOP_STEPS.slice(0, -1)) expect(stopsAfter('withdraw', step)).toBe(false)
  })

  it('each stop point runs a prefix of the loop, never a hole in the middle', () => {
    for (const stop of LOOP_STEPS) {
      const planned = stepsFor(stop)
      expect(planned).toEqual(LOOP_STEPS.slice(0, planned.length))
      expect(planned[planned.length - 1]).toBe(stop)
    }
  })

  it('a job stopped at post is the one that leaves the board with Open work', () => {
    // The whole reason this option exists: the merged task feed lists claimable
    // work, and a board of finished jobs contributes nothing to it.
    expect(stepsFor('post')).not.toContain('accept')
  })
})

describe('leftoverNote', () => {
  it('the full loop leaves nothing to disclose', () => {
    expect(leftoverNote('withdraw')).toBeUndefined()
  })

  it('an early stop says the job will sit there and why', () => {
    for (const stop of ['post', 'accept', 'submit', 'approve'] as const) {
      const note = leftoverNote(stop)
      expect(note).toBeTruthy()
      expect(note!).toContain(stop)
      expect(note!).toContain('ephemeral')
    }
  })
})

describe('the route uses this module rather than its own copy', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/admin/solana-loop/route.ts'), 'utf8')

  it('imports the plan', () => {
    expect(src).toMatch(/from '@\/lib\/solana-loop-plan'/)
  })

  it('refuses a bad stop_after before spending anything', () => {
    // The parse must precede the first transaction; a validation that runs
    // after funding has already cost devnet SOL for a request that 400s.
    //
    // Measured inside the handler only — the import block names
    // `sendAndConfirmTransaction` near the top of the file, and comparing
    // against that would compare a call to an import.
    const body = src.slice(src.indexOf('export async function POST'))
    const parseAt = body.indexOf('parseStopAfter(')
    const spendAt = body.indexOf('await sendAndConfirmTransaction(')
    expect(parseAt, 'parseStopAfter is not called in the handler').toBeGreaterThan(-1)
    expect(spendAt, 'no awaited transaction found in the handler').toBeGreaterThan(-1)
    expect(parseAt).toBeLessThan(spendAt)
  })
})
