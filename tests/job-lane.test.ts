/**
 * Which machine a job runs on.
 *
 * Before this, one undifferentiated pool: a platform-driven `cloud` or `mcp`
 * agent could claim work a local worker was about to do for free. The
 * platform then paid an LLM call for a job whose entire point was that
 * somebody else's computer would run it — and the local worker, the only one
 * that can open a file or run a test (`--workdir`), sat idle.
 */
import { describe, expect, it } from 'vitest'

import { JOB_LANES, laneAcceptsRuntime, laneRefusalReason, normalizeLane } from '@/lib/job-lane'

describe('normalizeLane', () => {
  it('keeps the two real lanes', () => {
    expect(normalizeLane('local')).toBe('local')
    expect(normalizeLane('handsel')).toBe('handsel')
  })

  it('falls back to `any` for anything else', () => {
    // Permissive on purpose: a stricter default would retire every job
    // posted before this column existed.
    for (const raw of [null, undefined, '', 'LOCAL', 'cloud', 'nonsense']) {
      expect(normalizeLane(raw as string | null)).toBe('any')
    }
  })
})

describe('laneAcceptsRuntime', () => {
  it('lets anyone take an undeclared job', () => {
    for (const rt of ['local', 'cloud', 'mcp', 'platform', 'webhook', null]) {
      expect(laneAcceptsRuntime('any', rt)).toBe(true)
    }
  })

  it('reserves a local job for a local worker', () => {
    expect(laneAcceptsRuntime('local', 'local')).toBe(true)
    for (const rt of ['cloud', 'mcp', 'platform', 'webhook', null]) {
      expect(laneAcceptsRuntime('local', rt)).toBe(false)
    }
  })

  it('keeps a local worker out of the platform lane', () => {
    expect(laneAcceptsRuntime('handsel', 'local')).toBe(false)
    for (const rt of ['cloud', 'mcp', 'platform', 'webhook']) {
      expect(laneAcceptsRuntime('handsel', rt)).toBe(true)
    }
  })

  it('treats a missing runtime as the platform default, matching the schema', () => {
    // agent.runtimeType defaults to 'platform'; a null must not read as a
    // free pass into the local lane.
    expect(laneAcceptsRuntime('handsel', null)).toBe(true)
    expect(laneAcceptsRuntime('local', null)).toBe(false)
  })
})

describe('laneRefusalReason', () => {
  it('is null when the worker is allowed', () => {
    expect(laneRefusalReason('local', 'local')).toBeNull()
    expect(laneRefusalReason('any', 'cloud')).toBeNull()
  })

  it('says which machine the job wanted', () => {
    expect(laneRefusalReason('local', 'cloud')).toContain('local worker')
    expect(laneRefusalReason('handsel', 'local')).toContain('platform runtime')
  })
})

describe('JOB_LANES', () => {
  it('lists every lane the normalizer can produce', () => {
    for (const l of JOB_LANES) expect(normalizeLane(l)).toBe(l)
  })
})
