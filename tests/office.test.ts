/**
 * OfficeBook — the pure connection model behind "visit another office with
 * a code." No DB, no randomness: `lib/office.ts`'s exported functions are a
 * thin self-migrating-table wrapper around exactly this state machine.
 */
import { describe, it, expect } from 'vitest'
import { OfficeBook, officeJobVisible, canCreateOfficeSlot } from '@/lib/office'
import { MAX_OFFICE_SLOTS } from '@/lib/office-world-data'

describe('OfficeBook', () => {
  it('has no code until one is set', () => {
    const book = new OfficeBook()
    expect(book.codeFor('alice')).toBeUndefined()
  })

  it('redeeming an unknown code fails without connecting anyone', () => {
    const book = new OfficeBook()
    expect(book.connect('nope', 'bob')).toEqual({ connected: false, reason: 'unknown-code' })
    expect(book.isConnected('bob', 'alice')).toBe(false)
  })

  it('redeeming a real code connects visitor and owner, both directions', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    const result = book.connect('ALICE1', 'bob')
    expect(result).toEqual({ connected: true, ownerId: 'alice' })
    expect(book.isConnected('alice', 'bob')).toBe(true)
    expect(book.isConnected('bob', 'alice')).toBe(true) // symmetric
  })

  it('rejects redeeming your own code — connecting to yourself is not a relationship', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    expect(book.connect('ALICE1', 'alice')).toEqual({ connected: false, reason: 'self' })
  })

  it('is idempotent — redeeming the same code twice stays connected, no error', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    book.connect('ALICE1', 'bob')
    expect(book.connect('ALICE1', 'bob')).toEqual({ connected: true, ownerId: 'alice' })
    expect(book.isConnected('alice', 'bob')).toBe(true)
  })

  it('two unconnected accounts are not connected', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    book.setCode('carol', 'CAROL1')
    book.connect('ALICE1', 'bob')
    expect(book.isConnected('bob', 'carol')).toBe(false)
    expect(book.isConnected('alice', 'carol')).toBe(false)
  })

  it('replacing a code retires the old one — a leaked code stops working', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    book.setCode('alice', 'ALICE2') // regenerate
    expect(book.connect('ALICE1', 'bob')).toEqual({ connected: false, reason: 'unknown-code' })
    expect(book.connect('ALICE2', 'bob')).toEqual({ connected: true, ownerId: 'alice' })
  })

  it('regenerating a code does not disconnect existing connections', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'ALICE1')
    book.connect('ALICE1', 'bob')
    book.setCode('alice', 'ALICE2')
    expect(book.isConnected('alice', 'bob')).toBe(true)
  })

  it('a code can only ever point at its current owner, even after reassignment', () => {
    const book = new OfficeBook()
    book.setCode('alice', 'SHARED')
    book.setCode('bob', 'SHARED') // bob claims the same code string later
    expect(book.connect('SHARED', 'carol')).toEqual({ connected: true, ownerId: 'bob' })
  })
})

describe('canCreateOfficeSlot — the cap behind "New office"', () => {
  it('allows creating below the cap', () => {
    expect(canCreateOfficeSlot(0)).toBe(true)
    expect(canCreateOfficeSlot(MAX_OFFICE_SLOTS - 1)).toBe(true)
  })

  it('refuses at and beyond the cap', () => {
    expect(canCreateOfficeSlot(MAX_OFFICE_SLOTS)).toBe(false)
    expect(canCreateOfficeSlot(MAX_OFFICE_SLOTS + 1)).toBe(false)
  })
})

describe('officeJobVisible — the decision behind /api/tasks and browse_open_jobs', () => {
  it('a job with no officeOwnerId is public, regardless of viewer or connection', () => {
    expect(officeJobVisible(null, null, false)).toBe(true)
    expect(officeJobVisible(null, 'stranger', false)).toBe(true)
  })

  it('an anonymous caller (GET /api/tasks) never sees an office-scoped job', () => {
    expect(officeJobVisible('alice', null, false)).toBe(false)
    // Even if the "connected" fact were somehow true — anonymous has no identity to be connected AS.
    expect(officeJobVisible('alice', null, true)).toBe(false)
  })

  it('the owner always sees their own scoped job, connection fact aside', () => {
    expect(officeJobVisible('alice', 'alice', false)).toBe(true)
  })

  it('a connected visitor sees it; an unconnected one does not', () => {
    expect(officeJobVisible('alice', 'bob', true)).toBe(true)
    expect(officeJobVisible('alice', 'bob', false)).toBe(false)
  })
})
