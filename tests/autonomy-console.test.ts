/**
 * The autonomy console's pure parts (lib/autonomy-console.ts).
 *
 * Both functions here decide what an owner is told about automations that
 * spend money unattended, so both failure directions matter: a merge that
 * silently drops a source hides an action that happened, and an "is anything
 * running" that counts a refused mandate claims one is running when none is.
 */
import { describe, expect, it } from 'vitest'
import { isAnythingActive, mergeAutonomyLog, type AutonomyLogEntry, type AutonomyView } from '@/lib/autonomy-console'

const entry = (at: string, source: AutonomyLogEntry['source'], what = 'x'): AutonomyLogEntry => ({
  at,
  source,
  what,
  amount: null,
  txHash: null,
  ok: true,
})

describe('mergeAutonomyLog', () => {
  it('interleaves sources by time, newest first', () => {
    const merged = mergeAutonomyLog([
      [entry('2026-08-29T10:00:00Z', 'gas'), entry('2026-08-29T08:00:00Z', 'gas')],
      [entry('2026-08-29T09:00:00Z', 'bond'), entry('2026-08-29T07:00:00Z', 'bond')],
    ])
    expect(merged.map((e) => e.at)).toEqual([
      '2026-08-29T10:00:00Z',
      '2026-08-29T09:00:00Z',
      '2026-08-29T08:00:00Z',
      '2026-08-29T07:00:00Z',
    ])
  })

  it('caps AFTER merging, so a busy source cannot crowd out a newer entry', () => {
    // Ten old gas rows and one recent birth: capping per source first would
    // be fine here, but capping the gas source to 3 BEFORE the merge would
    // still leave the birth — the failure is the reverse, so assert the
    // newest survives and the total is capped.
    const gas = Array.from({ length: 10 }, (_, i) => entry(`2026-08-2${i % 9}T01:00:00Z`, 'gas'))
    const merged = mergeAutonomyLog([gas, [entry('2026-08-29T23:00:00Z', 'birth')]], 3)
    expect(merged).toHaveLength(3)
    expect(merged[0].source).toBe('birth')
  })

  it('keeps source order stable within one timestamp', () => {
    const same = '2026-08-29T10:00:00Z'
    const merged = mergeAutonomyLog([[entry(same, 'gas', 'first')], [entry(same, 'bond', 'second')]])
    expect(merged.map((e) => e.what)).toEqual(['first', 'second'])
  })

  it('handles empty and all-empty sources', () => {
    expect(mergeAutonomyLog([])).toEqual([])
    expect(mergeAutonomyLog([[], []])).toEqual([])
  })

  it('never returns more than the cap, and a zero cap returns nothing', () => {
    expect(mergeAutonomyLog([[entry('2026-08-29T10:00:00Z', 'gas')]], 0)).toEqual([])
  })
})

describe('isAnythingActive', () => {
  const base: Omit<AutonomyView, 'anyActive'> = {
    deployment: { realMoney: false, chainName: 'Base Sepolia' },
    gasPool: null,
    autoMine: { enabled: 0, total: 3 },
    autoReply: { enabled: 0, answerable: 0, total: 3 },
    offices: [],
    log: [],
  }
  const office = (over: Partial<AutonomyView['offices'][number]> = {}): AutonomyView['offices'][number] => ({
    slot: 1,
    name: 'Main Office',
    automaton: { enabled: false, floorUsd: 0.25, spent: 0, budget: 2, unit: 'usd' },
    lineage: {
      enabled: false,
      allowedHere: true,
      birthsToday: 0,
      retirementsToday: 0,
      seededTodayUsd: 0,
      maxBirthsPerWindow: 2,
    },
    ...over,
  })

  it('is false when nothing is switched on', () => {
    expect(isAnythingActive({ ...base, offices: [office()] })).toBe(false)
  })

  it('counts an enabled gas pool', () => {
    expect(
      isAnythingActive({
        ...base,
        gasPool: { sourceAgentName: 'A', enabled: true, targetEth: '0.0002', spent: 0, budget: 0.005, unit: 'eth' },
      }),
    ).toBe(true)
  })

  it('does not count a gas pool that is set but switched off', () => {
    expect(
      isAnythingActive({
        ...base,
        gasPool: { sourceAgentName: 'A', enabled: false, targetEth: '0.0002', spent: 0, budget: 0.005, unit: 'eth' },
      }),
    ).toBe(false)
  })

  it('counts auto-mining agents', () => {
    expect(isAnythingActive({ ...base, autoMine: { enabled: 1, total: 3 } })).toBe(true)
  })

  it('counts an enabled office Automaton', () => {
    expect(isAnythingActive({ ...base, offices: [office({ automaton: { enabled: true, floorUsd: 0.25, spent: 0, budget: 2, unit: 'usd' } })] })).toBe(true)
  })

  it('does NOT count a lineage mandate the deployment refuses', () => {
    // The one that matters: switched on, but real money means the gate is
    // shut. Saying "something is running" here would be a false positive
    // about money moving.
    const refused = office({
      lineage: { enabled: true, allowedHere: false, birthsToday: 0, retirementsToday: 0, seededTodayUsd: 0, maxBirthsPerWindow: 2 },
    })
    expect(isAnythingActive({ ...base, offices: [refused] })).toBe(false)
  })

  it('counts a lineage mandate the deployment permits', () => {
    const allowed = office({
      lineage: { enabled: true, allowedHere: true, birthsToday: 0, retirementsToday: 0, seededTodayUsd: 0, maxBirthsPerWindow: 2 },
    })
    expect(isAnythingActive({ ...base, offices: [allowed] })).toBe(true)
  })
  it('counts an agent answering messages by itself as active', () => {
    expect(isAnythingActive({ ...base, autoReply: { enabled: 1, answerable: 1, total: 3 } })).toBe(true)
  })

  it('does NOT count auto-reply switched on for a runtime nothing can call', () => {
    // Same distinction lineage's allowedHere draws: a green light over a
    // switch that can never fire tells the owner the opposite of the truth.
    expect(isAnythingActive({ ...base, autoReply: { enabled: 2, answerable: 0, total: 3 } })).toBe(false)
  })

})
