import { describe, expect, it } from 'vitest'
import {
  BOUNTY_STATUS_CODE,
  FRONTIER_LAYOUT,
  VERIFICATION_CODE,
  beaconTile,
  buildFrontier,
  inPlaza,
  inWorld,
  toBeacon,
  toTotems,
  totemTile,
} from '@/lib/frontier-layout'
import type { TaskSpec } from '@/lib/task-spec'
import { JOB_STATUS } from '@/lib/onchain/config'

/**
 * The bridge to the MUD game (docs/frontier.md). The game's contract derives a
 * beacon's tile from the job id; this file mirrors that derivation. The
 * vectors below are ALSO asserted in `Frontier.t.sol` in Kairose-master/mud —
 * change one side and the other's test goes red, which is the point.
 */

describe('beaconTile — the same vectors Frontier.t.sol pins', () => {
  it('matches the contract', () => {
    expect(beaconTile(1)).toEqual({ x: -12, z: 0 })
    expect(beaconTile(2)).toEqual({ x: 10, z: -13 })
    expect(beaconTile(42)).toEqual({ x: -2, z: -15 })
    expect(beaconTile(1000)).toEqual({ x: 13, z: 24 })
  })

  it('accepts the id as a string, number or bigint and refuses a negative one', () => {
    expect(beaconTile('42')).toEqual(beaconTile(42n))
    expect(() => beaconTile(-1)).toThrow()
  })

  it('never lands in the plaza and always inside the world', () => {
    for (let id = 0; id < 5000; id++) {
      const t = beaconTile(id)
      expect(inWorld(t), `job ${id}`).toBe(true)
      expect(inPlaza(t), `job ${id}`).toBe(false)
    }
  })

  it('is deterministic', () => {
    expect(beaconTile(123456789)).toEqual(beaconTile(123456789))
  })
})

describe('totemTile — rank 0 at the top, clockwise', () => {
  it('places a lone totem at the top of the ring', () => {
    expect(totemTile(0, 1)).toEqual({ x: 0, z: -4 })
  })
  it('spaces four totems on the axes', () => {
    expect([0, 1, 2, 3].map((s) => totemTile(s, 4))).toEqual([
      { x: 0, z: -4 },
      { x: 4, z: 0 },
      { x: 0, z: 4 },
      { x: -4, z: 0 },
    ])
  })
  it('keeps every slot inside the plaza', () => {
    for (let n = 1; n <= 64; n++) for (let s = 0; s < n; s++) expect(inPlaza(totemTile(s, n))).toBe(true)
  })
})

describe('enum codes mirror the contract', () => {
  it('covers every on-chain job status, 1-based, plus Expired', () => {
    for (const s of JOB_STATUS) expect(BOUNTY_STATUS_CODE[s], s).toBeGreaterThan(0)
    expect(BOUNTY_STATUS_CODE.Expired).toBe(8)
    expect(new Set(Object.values(BOUNTY_STATUS_CODE)).size).toBe(Object.keys(BOUNTY_STATUS_CODE).length)
    expect(Object.values(BOUNTY_STATUS_CODE)).not.toContain(0)
  })
  it('gives every verification method a code', () => {
    expect(VERIFICATION_CODE).toEqual({ manual_review: 1, auto_graded_tests: 2, independent_grader: 3, ci_checks: 4 })
  })
  it('the plaza push stays inside the world', () => {
    expect(FRONTIER_LAYOUT.plazaRadius * 3 + 2).toBeLessThan(FRONTIER_LAYOUT.worldRadius)
  })
})

const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: '42',
  kind: 'paid_job',
  title: 'Implement count_vowels(s)',
  description: 'Write it.',
  acceptanceCriteria: null,
  rewardUsd: 12.5,
  minScore: 0,
  difficulty: null,
  status: 'Open',
  requesterAgentId: null,
  requesterLabel: '0xcfd3…Cf4d',
  requesterName: 'Architect',
  workerAgentId: null,
  workerLabel: null,
  workerName: null,
  verification: 'auto_graded_tests',
  repo: null,
  createdAt: null,
  ...over,
})

describe('toBeacon', () => {
  it('carries the numbers the contract stores and the text the client reads', () => {
    const b = toBeacon(task(), 'https://example.test/guest')
    expect(b).toMatchObject({
      jobId: '42',
      statusCode: 1,
      verificationCode: 2,
      rewardCents: 1250,
      title: 'Implement count_vowels(s)',
      tile: { x: -2, z: -15 },
      url: 'https://example.test/guest',
    })
  })
  it('refuses what cannot stand on this map', () => {
    expect(toBeacon(task({ kind: 'verified_task' }), 'u')).toBeNull()
    expect(toBeacon(task({ chain: 'solana:devnet' }), 'u')).toBeNull()
    expect(toBeacon(task({ status: 'Weird' }), 'u')).toBeNull()
    expect(toBeacon(task({ id: 'abc' }), 'u')).toBeNull()
  })
  it('never lets a negative bounty through as negative cents', () => {
    expect(toBeacon(task({ rewardUsd: -3 }), 'u')?.rewardCents).toBe(0)
  })
})

describe('toTotems / buildFrontier', () => {
  it('ranks in the order given and converts to cents', () => {
    const t = toTotems([
      { name: 'Architect', creditScore: 640.4, creditRating: 'A', jobsDone: 9, earnedUsd: 42.01 },
      { name: 'Red Team', creditScore: 120, creditRating: 'unrated', jobsDone: 0, earnedUsd: 0 },
    ])
    expect(t[0]).toEqual({ slot: 0, name: 'Architect', creditScore: 640, creditRating: 'A', jobsDone: 9, earnedUsd: 42.01, earnedCents: 4201, tile: { x: 0, z: -4 } })
    expect(t[1].tile).toEqual({ x: 0, z: 4 })
  })
  it('builds an empty map from an empty market rather than inventing one', () => {
    expect(buildFrontier([], [], 'u')).toEqual({ layout: FRONTIER_LAYOUT, beacons: [], totems: [] })
  })
})
