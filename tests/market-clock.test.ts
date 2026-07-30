import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BACKSTOP_INTERVAL_S,
  PASSES_PER_WINDOW,
  checkWindows,
  explain,
  minimumWindowS,
  tooShort,
} from '@/lib/market-clock'

/**
 * A window shorter than the thing that closes it is not a setting, it is a bug.
 *
 * The live contract was deployed with every window at 600s. The backstop that
 * calls the exits lands every 80-100 minutes. Job #1's open window closed and
 * 0.13 USDC stayed locked for 112 minutes, until a request happened to arrive
 * and drive the traffic tick.
 *
 * Nobody chose that. The windows were picked at the contract, the cadence was
 * picked at the scheduler, and no artefact in the repo related them — so both
 * were locally reasonable and jointly wrong. This test is that missing artefact.
 */

describe('the clock is internally consistent', () => {
  it('needs more than one backstop pass per window', () => {
    // At one, a window equal to the sweep interval expects the sweep to land in
    // the instant the window closes. GitHub's scheduler has jitter measured in
    // tens of minutes.
    expect(PASSES_PER_WINDOW).toBeGreaterThanOrEqual(2)
    expect(minimumWindowS(600)).toBe(1200)
  })

  it('measures the backstop by what is delivered, not what is requested', () => {
    // settle-heartbeat.yml asks for */5. The workflow's own comments record that
    // GitHub delivers it every 80-100 minutes. Encoding 300s here would make
    // every check pass against a cadence that does not exist.
    const wf = readFileSync('.github/workflows/settle-heartbeat.yml', 'utf8')
    expect(wf).toContain("cron: '*/5 * * * *'")
    expect(BACKSTOP_INTERVAL_S).toBeGreaterThanOrEqual(80 * 60)
  })

  it('does not count the traffic tick as a guarantee', () => {
    // It requires a visitor, and staleness only matters when nobody is looking.
    // Using it here would assume the market is busy in order to prove it settles.
    const src = readFileSync('lib/market-clock.ts', 'utf8')
    expect(src).toMatch(/BACKSTOP_INTERVAL_S = 100 \* 60/)
    expect(BACKSTOP_INTERVAL_S).not.toBe(300)
  })

  it('reports both sides of the remedy', () => {
    const msg = explain(checkWindows({ delivery: 600 }))
    expect(msg).toMatch(/raise these windows/)
    expect(msg).toMatch(/backstop faster/)
  })
})

describe('the windows a new deployment gets', () => {
  /** The deploy script's defaults — what a deployment gets when nobody overrides. */
  function deployDefaults(): Record<string, number> {
    const src = readFileSync('scripts/deploy-labor-v2.mjs', 'utf8')
    const DAY = 86400
    const read = (env: string): number => {
      const m = src.match(new RegExp(`num\\('${env}',\\s*([^)]+)\\)`))
      if (!m) throw new Error(`${env} not found in deploy script`)
      // The defaults are written as arithmetic (`1 * DAY`, `10 * 60`).
      const expr = m[1].trim().replace(/DAY/g, String(DAY))
      if (!/^[\d*+\s]+$/.test(expr)) throw new Error(`unexpected default for ${env}: ${expr}`)
      return Number(new Function(`return ${expr}`)())
    }
    return {
      // Windows a job WAITS in. maxDeliveryWindow and maxOpenWindow are ceilings
      // on what may be requested, not durations anything waits through, so they
      // are not checked — but minDeliveryWindow is, because a requester may ask
      // for exactly it and real jobs would then sit for that long.
      minDeliveryWindow: read('MIN_DELIVERY_WINDOW_S'),
      reviewWindow: read('REVIEW_WINDOW_S'),
      disputeWindow: read('DISPUTE_WINDOW_S'),
    }
  }

  it('parses the deploy script — the parse is the test here', () => {
    const d = deployDefaults()
    expect(d.reviewWindow).toBe(86400)
    expect(d.disputeWindow).toBe(14 * 86400)
    expect(d.minDeliveryWindow).toBe(600)
  })

  it('has review and dispute windows that outlast the backstop', () => {
    const d = deployDefaults()
    const checks = checkWindows({ reviewWindow: d.reviewWindow, disputeWindow: d.disputeWindow })
    expect(tooShort(checks), explain(checks)).toEqual([])
  })

  /**
   * The one that does NOT satisfy it, recorded rather than hidden.
   *
   * `minDeliveryWindow` defaults to 600s — a floor a requester may ask for. With
   * a ~100 minute backstop, a job that asks for the floor can sit past its
   * delivery deadline for ten times the window before `reclaimJob` arrives.
   *
   * This is a real, currently-accepted gap, and it is deliberately asserted as a
   * KNOWN violation rather than excused: if someone raises the floor or speeds up
   * the backstop, this test fails and tells them to delete it. A skipped test
   * would rot silently; an inverted one cannot.
   */
  it('records minDeliveryWindow as a known, unresolved violation', () => {
    const d = deployDefaults()
    const checks = checkWindows({ minDeliveryWindow: d.minDeliveryWindow })
    expect(
      tooShort(checks).length,
      'minDeliveryWindow now satisfies the invariant — delete this test and add ' +
        'minDeliveryWindow to the check above',
    ).toBe(1)
  })
})

describe('what the app asks for by default', () => {
  it('requests a delivery window the backstop can cover', () => {
    // DEFAULT_DELIVERY_WINDOW_S is what every caller that does not choose gets,
    // so it is the value real jobs actually run with — unlike the contract floor,
    // which merely permits something shorter.
    const src = readFileSync('lib/onchain/labor-v2.ts', 'utf8')
    const m = src.match(/DEFAULT_DELIVERY_WINDOW_S = ([\d\s*]+)/)
    expect(m, 'DEFAULT_DELIVERY_WINDOW_S not found').toBeTruthy()
    const seconds = Number(new Function(`return ${m![1]}`)())
    const checks = checkWindows({ defaultDeliveryWindow: seconds })
    expect(tooShort(checks), explain(checks)).toEqual([])
  })
})
