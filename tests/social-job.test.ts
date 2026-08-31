import { describe, expect, it } from 'vitest'
import {
  approvalStillValid,
  canTransition,
  isDue,
  nextAfterFailure,
  payloadFingerprint,
  validatePayload,
  ALLOWED_TRANSITIONS,
  CLAIMABLE_STATUSES,
  MAX_PUBLISH_ATTEMPTS,
  type SocialJobStatus,
} from '@/lib/social/social-job'

describe('the approval boundary', () => {
  it('no editorial state reaches QUEUED without passing approval', () => {
    // The only doors into the executable states are READY/SCHEDULED, and
    // those are only reachable from APPROVAL_REQUIRED. Generation finishing
    // is never publication.
    expect(canTransition('DRAFT', 'QUEUED')).toBe(false)
    expect(canTransition('DRAFT', 'READY')).toBe(false)
    expect(canTransition('APPROVAL_REQUIRED', 'QUEUED')).toBe(false)
    expect(canTransition('APPROVAL_REQUIRED', 'READY')).toBe(true)
    expect(canTransition('READY', 'QUEUED')).toBe(true)
  })

  it('PUBLISHED is truly terminal', () => {
    expect(ALLOWED_TRANSITIONS.PUBLISHED).toEqual([])
  })

  it('claimable statuses are exactly the approved, due-to-run ones', () => {
    expect(CLAIMABLE_STATUSES.sort()).toEqual(['QUEUED', 'READY', 'SCHEDULED'])
  })

  it('failure parks (FAILED/EXPIRED/NEEDS_AUTH) only reopen to QUEUED', () => {
    for (const s of ['FAILED', 'EXPIRED', 'NEEDS_AUTH'] as SocialJobStatus[]) {
      expect(ALLOWED_TRANSITIONS[s]).toEqual(['QUEUED'])
    }
  })
})

describe('validatePayload', () => {
  it('accepts a well-formed post and rejects a missing image', () => {
    expect(validatePayload('post', { imageUrl: 'https://cdn.example/x.png' })).toBeNull()
    expect(validatePayload('post', { caption: 'no media' })).toMatch(/imageUrl/)
  })

  it('refuses non-https media URLs — Instagram fetches server-side', () => {
    expect(validatePayload('post', { imageUrl: 'http://cdn.example/x.png' })).toMatch(/https/)
    expect(validatePayload('reel', { videoUrl: 'data:video/mp4;base64,AAAA' })).toMatch(/https/)
  })

  it('bounds carousels at 2–10 items and requires media on every slide', () => {
    const img = { imageUrl: 'https://cdn.example/a.png' }
    expect(validatePayload('carousel', { items: [img] })).toMatch(/2–10/)
    expect(validatePayload('carousel', { items: Array(11).fill(img) })).toMatch(/2–10/)
    expect(validatePayload('carousel', { items: [img, {}] })).toMatch(/needs imageUrl or videoUrl/)
    expect(validatePayload('carousel', { items: [img, img] })).toBeNull()
  })

  it('a story is one image XOR one video', () => {
    expect(validatePayload('story', {})).toMatch(/needs/)
    expect(
      validatePayload('story', { imageUrl: 'https://cdn.example/a.png', videoUrl: 'https://cdn.example/a.mp4' }),
    ).toMatch(/not both/)
    expect(validatePayload('story', { imageUrl: 'https://cdn.example/a.png' })).toBeNull()
  })
})

describe('the approval fingerprint', () => {
  const payload = { imageUrl: 'https://cdn.example/a.png', caption: 'hello' }

  it('is stable for an unchanged payload', () => {
    expect(payloadFingerprint({ ...payload })).toBe(payloadFingerprint({ ...payload }))
  })

  it('changes when the media OR the words change — silent swap is detectable', () => {
    const approved = payloadFingerprint(payload)
    expect(payloadFingerprint({ ...payload, imageUrl: 'https://cdn.example/b.png' })).not.toBe(approved)
    expect(payloadFingerprint({ ...payload, caption: 'changed' })).not.toBe(approved)
  })

  it('approvalStillValid fails without a fingerprint and after drift', () => {
    expect(approvalStillValid({ payload, approvedFingerprint: null })).toBe(false)
    expect(approvalStillValid({ payload, approvedFingerprint: payloadFingerprint(payload) })).toBe(true)
    expect(
      approvalStillValid({
        payload: { ...payload, caption: 'edited later' },
        approvedFingerprint: payloadFingerprint(payload),
      }),
    ).toBe(false)
  })
})

describe('isDue', () => {
  const now = new Date('2026-08-31T12:00:00Z')

  it('READY and QUEUED are always due; SCHEDULED honours its time', () => {
    expect(isDue({ status: 'READY', scheduledAt: null }, now)).toBe(true)
    expect(isDue({ status: 'QUEUED', scheduledAt: null }, now)).toBe(true)
    expect(isDue({ status: 'SCHEDULED', scheduledAt: new Date('2026-08-31T13:00:00Z') }, now)).toBe(false)
    expect(isDue({ status: 'SCHEDULED', scheduledAt: new Date('2026-08-31T11:00:00Z') }, now)).toBe(true)
    expect(isDue({ status: 'SCHEDULED', scheduledAt: null }, now)).toBe(false)
  })

  it('editorial and terminal states are never due', () => {
    for (const status of ['DRAFT', 'APPROVAL_REQUIRED', 'PUBLISHED', 'FAILED', 'PUBLISHING'] as SocialJobStatus[]) {
      expect(isDue({ status, scheduledAt: null }, now)).toBe(false)
    }
  })
})

describe('nextAfterFailure — the one retry rule', () => {
  it('a dead token parks at NEEDS_AUTH immediately, keeping the checkpoint', () => {
    const next = nextAfterFailure({ attempts: 0 }, { error: 'OAuth 190', retryable: false, needsAuth: true })
    expect(next).toEqual({ status: 'NEEDS_AUTH', attempts: 1, clearContainer: false })
  })

  it('an expired container parks at EXPIRED and discards the dead checkpoint', () => {
    const next = nextAfterFailure({ attempts: 1 }, { error: 'expired', retryable: false, containerExpired: true })
    expect(next).toEqual({ status: 'EXPIRED', attempts: 2, clearContainer: true })
  })

  it('transient failures requeue until the budget, then FAIL', () => {
    const transient = { error: '503', retryable: true }
    expect(nextAfterFailure({ attempts: 0 }, transient).status).toBe('QUEUED')
    expect(nextAfterFailure({ attempts: MAX_PUBLISH_ATTEMPTS - 2 }, transient).status).toBe('QUEUED')
    expect(nextAfterFailure({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }, transient).status).toBe('FAILED')
  })

  it('a permanent error fails on the first strike — no blind replay', () => {
    const next = nextAfterFailure({ attempts: 0 }, { error: 'invalid media', retryable: false })
    expect(next.status).toBe('FAILED')
    expect(next.attempts).toBe(1)
  })

  it('a deferral (e.g. full quota) requeues WITHOUT burning an attempt', () => {
    const next = nextAfterFailure({ attempts: 2 }, { error: 'quota', retryable: true, deferred: true })
    expect(next).toEqual({ status: 'QUEUED', attempts: 2, clearContainer: false })
  })
})
