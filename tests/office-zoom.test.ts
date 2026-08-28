import { describe, it, expect } from 'vitest'
import { hotRoomOf, roomStatsOf, closeRoomIdFor } from '@/app/(dashboard)/office/game/zoom'

describe('hotRoomOf', () => {
  it('is null when nobody occupies a real room', () => {
    expect(hotRoomOf([{ deptId: 'lounge' }, { deptId: 'ceo' }])).toBeNull()
  })

  it('is null with no agents at all', () => {
    expect(hotRoomOf([])).toBeNull()
  })

  it('picks the room with the most people, ignoring lounge and ceo', () => {
    const agents = [
      { deptId: 'research' }, { deptId: 'research' }, { deptId: 'research' },
      { deptId: 'treasury' }, { deptId: 'treasury' },
      { deptId: 'lounge' }, { deptId: 'lounge' }, { deptId: 'lounge' }, { deptId: 'lounge' },
      { deptId: 'ceo' },
    ]
    expect(hotRoomOf(agents)).toBe('research')
  })

  it('a single occupied room wins even with just one person', () => {
    expect(hotRoomOf([{ deptId: 'market' }])).toBe('market')
  })
})

describe('roomStatsOf', () => {
  it('counts occupants per real room, excluding lounge/ceo', () => {
    const stats = roomStatsOf([
      { deptId: 'engineering', status: 'On a job.' },
      { deptId: 'engineering', status: 'On a job.' },
      { deptId: 'lounge', status: 'Idle.' },
    ])
    expect(stats.get('engineering')).toEqual({ count: 2, alert: false })
    expect(stats.has('lounge')).toBe(false)
  })

  it('flags alert only from the real dispute status line, never from any other wording', () => {
    const stats = roomStatsOf([
      { deptId: 'verification', status: 'A job is in dispute — under adjudication.' },
      { deptId: 'verification', status: "Reviewing a peer's work." },
    ])
    expect(stats.get('verification')).toEqual({ count: 2, alert: true })
  })

  it('a room with people but nothing disputed is never flagged', () => {
    const stats = roomStatsOf([{ deptId: 'engineering', status: 'On a job — accepted.' }])
    expect(stats.get('engineering')?.alert).toBe(false)
  })

  it('is case-insensitive on the word "dispute"', () => {
    const stats = roomStatsOf([{ deptId: 'verification', status: 'DISPUTE pending.' }])
    expect(stats.get('verification')?.alert).toBe(true)
  })

  it('empty roster produces an empty map, not a map of zeros', () => {
    expect(roomStatsOf([]).size).toBe(0)
  })
})

describe('closeRoomIdFor', () => {
  const agents = [
    { id: 'a1', deptId: 'research' },
    { id: 'a2', deptId: 'treasury' },
  ]

  it('a selected agent wins — its CURRENT room, not a stale one', () => {
    expect(closeRoomIdFor({ selectedId: 'a1', selectedRoomId: 'market', agents, hotRoom: 'engineering' })).toBe('research')
  })

  it('a selected room is used when no agent is selected', () => {
    expect(closeRoomIdFor({ selectedId: null, selectedRoomId: 'market', agents, hotRoom: 'engineering' })).toBe('market')
  })

  it('falls back to the hot room when nothing is selected', () => {
    expect(closeRoomIdFor({ selectedId: null, selectedRoomId: null, agents, hotRoom: 'engineering' })).toBe('engineering')
  })

  it('a selected agent id that no longer exists on the roster falls through to the room/hot-room chain', () => {
    // The agent could have left (deleted, moved account) between selection
    // and this render — stale selection must not throw or freeze on a room
    // that no longer has anyone in it.
    expect(closeRoomIdFor({ selectedId: 'ghost', selectedRoomId: 'market', agents, hotRoom: 'engineering' })).toBe('market')
  })

  it('is null when there is truly nothing to point at', () => {
    expect(closeRoomIdFor({ selectedId: null, selectedRoomId: null, agents: [], hotRoom: null })).toBeNull()
  })
})
