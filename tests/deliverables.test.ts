import { describe, expect, it } from 'vitest'
import {
  validateArtifacts,
  workerCanDeliver,
  normalizeDeliverableKind,
  normalizeCapabilities,
  inferDeliverableKind,
  MAX_ARTIFACTS_PER_SUBMISSION,
} from '@/lib/artifacts'
import { parsePlannerOutput } from '@/lib/delegation'

const png = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64')

describe('validateArtifacts', () => {
  it('accepts a small image artifact and normalizes fields', () => {
    const [a] = validateArtifacts([{ mime: 'IMAGE/PNG', data_base64: png(1024), name: 'logo.png' }])
    expect(a.mime).toBe('image/png')
    expect(a.name).toBe('logo.png')
    expect(a.size).toBeGreaterThan(1000)
  })

  it('returns [] for missing artifacts', () => {
    expect(validateArtifacts(undefined)).toEqual([])
    expect(validateArtifacts(null)).toEqual([])
  })

  it('rejects unsupported mime types', () => {
    expect(() => validateArtifacts([{ mime: 'application/x-msdownload', data_base64: png(10) }])).toThrow(/unsupported mime/)
  })

  it('rejects oversized artifacts (2MB decoded cap)', () => {
    expect(() => validateArtifacts([{ mime: 'image/png', data_base64: png(2 * 1024 * 1024 + 100) }])).toThrow(/exceeds/)
  })

  it('rejects too many artifacts', () => {
    const many = Array.from({ length: MAX_ARTIFACTS_PER_SUBMISSION + 1 }, () => ({
      mime: 'image/png',
      data_base64: png(10),
    }))
    expect(() => validateArtifacts(many)).toThrow(/too many/)
  })

  it('rejects payloads that are neither base64 nor a url', () => {
    expect(() => validateArtifacts([{ mime: 'image/png', data_base64: 'not base64 !!!' }])).toThrow(/data_base64|url/)
  })

  it('accepts audio and video mimes', () => {
    const arts = validateArtifacts([
      { mime: 'audio/mpeg', data_base64: png(100) },
      { mime: 'video/mp4', data_base64: png(100) },
    ])
    expect(arts.map((a) => a.mime)).toEqual(['audio/mpeg', 'video/mp4'])
  })

  it('accepts blob URLs only from the platform blob host', () => {
    const [a] = validateArtifacts([
      { mime: 'video/mp4', url: 'https://abc123.public.blob.vercel-storage.com/render-xyz.mp4', name: 'render.mp4' },
    ])
    expect(a.url).toContain('vercel-storage.com')
    expect(a.dataBase64).toBeNull()
    expect(() => validateArtifacts([{ mime: 'video/mp4', url: 'https://evil.example.com/x.mp4' }])).toThrow(/blob/)
    expect(() => validateArtifacts([{ mime: 'video/mp4', url: 'http://x.public.blob.vercel-storage.com/x.mp4' }])).toThrow(/https/)
  })
})

describe('normalizeCapabilities', () => {
  it('always includes text and drops unknown names', () => {
    expect(normalizeCapabilities(undefined)).toEqual(['text'])
    expect(normalizeCapabilities(['image', 'WEB', 'hacking', 'audio'])).toEqual(['text', 'image', 'web', 'audio'])
  })
})

describe('workerCanDeliver', () => {
  it('treats legacy null/empty capabilities as text-only', () => {
    expect(workerCanDeliver(null, 'text')).toBe(true)
    expect(workerCanDeliver([], 'text')).toBe(true)
    expect(workerCanDeliver(null, 'image')).toBe(false)
  })

  it('matches declared capabilities exactly', () => {
    expect(workerCanDeliver(['text', 'image'], 'image')).toBe(true)
    expect(workerCanDeliver(['text'], 'image')).toBe(false)
    expect(workerCanDeliver(['image'], 'text')).toBe(false) // declared sets are authoritative
  })

  it('enforces required tool capabilities on top of the deliverable kind', () => {
    expect(workerCanDeliver(['text', 'web'], 'text', ['web'])).toBe(true)
    expect(workerCanDeliver(['text'], 'text', ['web'])).toBe(false)
    expect(workerCanDeliver(['text', 'web'], 'text', ['web', 'code'])).toBe(false)
    expect(workerCanDeliver(['text'], 'text', [])).toBe(true)
    expect(workerCanDeliver(null, 'text', ['web'])).toBe(false) // legacy agents have no tools
  })
})

describe('normalizeDeliverableKind', () => {
  it('defaults anything unknown to text', () => {
    expect(normalizeDeliverableKind(undefined)).toBe('text')
    expect(normalizeDeliverableKind('IMAGE')).toBe('image')
    expect(normalizeDeliverableKind('audio')).toBe('audio')
    expect(normalizeDeliverableKind('video')).toBe('video')
    expect(normalizeDeliverableKind('hologram')).toBe('text')
    expect(normalizeDeliverableKind('file')).toBe('file')
  })
})

describe('parsePlannerOutput deliverableKind', () => {
  const base = {
    title: 'T',
    description: 'D',
    acceptanceCriteria: 'must satisfy the criteria',
    bountyUsd: 2,
  }

  it('carries image kind through and defaults everything else to text', () => {
    const out = parsePlannerOutput(
      JSON.stringify([
        { ...base, deliverableKind: 'image' },
        { ...base, deliverableKind: 'weird' },
        { ...base },
      ]),
      10,
    )
    expect(out[0].deliverableKind).toBe('image')
    expect(out[1].deliverableKind).toBe('text')
    expect(out[2].deliverableKind).toBe('text')
  })
})

describe('inferDeliverableKind (capability-tagging safety net)', () => {
  it('tags image-deliverable jobs from clear signals', () => {
    expect(inferDeliverableKind('Friendly mascot robot emblem for Handsel')).toBe('image')
    expect(inferDeliverableKind('Minimalist geometric flat-vector logo for Handsel')).toBe('image')
    expect(inferDeliverableKind('Design an icon', '', 'Deliver a 1024x1024 PNG')).toBe('image')
    expect(inferDeliverableKind('Create an illustration of a fox')).toBe('image')
  })

  it('tags audio-deliverable jobs from clear signals', () => {
    expect(inferDeliverableKind('Record the narration', '', 'Deliver an mp3')).toBe('audio')
    expect(inferDeliverableKind('Voiceover for the intro')).toBe('audio')
    expect(inferDeliverableKind('한국어 나레이션 오디오')).toBe('audio')
  })

  it('leaves genuine text jobs as text — no false upgrades', () => {
    expect(inferDeliverableKind('Implement title_case(s)')).toBe('text')
    expect(inferDeliverableKind('Write marketing copy for the landing page')).toBe('text')
    // merely referencing a logo in a writing task must not upgrade to image
    expect(inferDeliverableKind('Write the copy that goes next to the logo')).toBe('text')
    expect(inferDeliverableKind('Summarize the coffee brand brief')).toBe('text')
  })
})
