import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { kitFor, kittedDepartments, visorEmissive } from '@/lib/office-avatar-kit'
import { FUNCTIONAL_DEPARTMENTS } from '@/lib/office-functional-departments'

describe('the kit is a readout, not a costume', () => {
  it('covers every real department', () => {
    // A new department falling through to `none` is how the readout quietly
    // stops being one: the agent still renders, just wearing nothing, and
    // nobody notices the information went missing.
    const kitted = new Set(kittedDepartments())
    for (const d of FUNCTIONAL_DEPARTMENTS) {
      expect(kitted.has(d.id), `${d.id} has no kit`).toBe(true)
      expect(kitFor(d.id).kind).not.toBe('none')
    }
  })

  it('covers the two rooms that are not departments', () => {
    // live-engine's applySnapshot can put either of world.ts's own rooms in
    // Agent.deptId, so the table has to answer for them too.
    expect(kittedDepartments()).toContain('ceo')
    expect(kittedDepartments()).toContain('lounge')
  })

  it('gives every kit a sentence explaining it', () => {
    for (const id of kittedDepartments()) {
      expect(kitFor(id).meaning.length, id).toBeGreaterThan(8)
    }
  })

  it('says nothing rather than guessing when the department is unknown', () => {
    for (const id of [null, undefined, '', 'not-a-department']) {
      expect(kitFor(id).kind).toBe('none')
    }
  })

  it('leaves the lounge unkitted — it is not work', () => {
    expect(kitFor('lounge').kind).toBe('none')
  })

  it('reads as a silhouette: no two adjacent-meaning departments share a shape and a tone', () => {
    // The whole point of the reference sheets is telling agents apart at a
    // few dozen pixels. Two departments identical in both shape and colour
    // would be exactly as unreadable as the shirt-colour-only version.
    const seen = new Map<string, string>()
    for (const id of kittedDepartments()) {
      const k = kitFor(id)
      if (k.kind === 'none') continue
      const sig = `${k.kind}/${k.tone}`
      expect(seen.has(sig), `${id} and ${seen.get(sig)} look identical (${sig})`).toBe(false)
      seen.set(sig, id)
    }
  })
})

describe('visorEmissive', () => {
  it('stays dark on the flat theme', () => {
    // An emissive band is the one element that would break the diorama's
    // paper-craft read.
    expect(visorEmissive(false, false)).toBe(0)
    expect(visorEmissive(false, true)).toBe(0)
  })

  it('lights up, and brighter when selected', () => {
    expect(visorEmissive(true, false)).toBeGreaterThan(0)
    expect(visorEmissive(true, true)).toBeGreaterThan(visorEmissive(true, false))
  })
})

describe('the avatar actually wears it', () => {
  const src = readFileSync('app/(dashboard)/office/game3d/AgentAvatars.tsx', 'utf8')

  it('builds the kit from the live department', () => {
    expect(src).toMatch(/kitFor\(agent\.deptId\)/)
  })

  it('mounts the accessory and the visor', () => {
    expect(src).toMatch(/<Accessory\b/)
    expect(src).toMatch(/visorEmissive\(/)
  })
})

describe('the desks the reference sheets drew', () => {
  const src = readFileSync('app/(dashboard)/office/game3d/RoomProps.tsx', 'utf8')

  it('puts a chair at every desk', () => {
    // Every desk in the reference sheets has one and the scene had none,
    // which is most of why the deck read as a showroom rather than a place
    // people work. Pin the MOUNT, not the declaration — a component nothing
    // renders is exactly the bug this is here to catch.
    expect(src).toMatch(/<Chair\b/)
    const deskFn = src.slice(src.indexOf('function Desk('), src.indexOf('function Chair('))
    expect(deskFn).toMatch(/<Chair\b/)
  })

  it('keeps the chair out of the collision grid', () => {
    // world.ts has no chair rows and agents path to the desk they work at,
    // so a collidable chair would block the tile an agent has to stand on.
    expect(src).not.toMatch(/kind: 'chair'/)
  })
})
