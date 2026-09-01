/**
 * Pure-function tests for the comment-triggered DM layer (lib/social/
 * instagram/dm.ts): webhook parsing, signature verification, triage routing,
 * freshness, dedupe and the template linter. The send path is one igFetch
 * call, covered by the client tests; every anti-spam decision lives in the
 * pure module where it is pinnable.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  dmDedupeKey,
  isCommentFresh,
  MAX_COMMENT_AGE_MS,
  parseCommentWebhook,
  renderDmTemplate,
  triageComment,
  verifyWebhookSignature,
  type CommentEvent,
  type DmCampaign,
} from '@/lib/social/instagram/dm'

const event = (over: Partial<CommentEvent> = {}): CommentEvent => ({
  commentId: 'cm-1',
  mediaId: 'm-1',
  text: 'proof please',
  fromId: 'u-9',
  fromUsername: 'dev_kim',
  timestampMs: Date.now(),
  ...over,
})

const campaign = (over: Partial<DmCampaign> = {}): DmCampaign => ({
  id: 'hs024-proof-link',
  triggers: ['proof'],
  template:
    'Hey {{username}} — Handsel team here. You asked for the receipts: {{link}} If this isn’t for you, ignore this and we won’t message again.',
  link: 'https://handsel-main.vercel.app/proof/2',
  ...over,
})

describe('webhook parsing', () => {
  const body = {
    object: 'instagram',
    entry: [
      {
        time: 1_756_000_000,
        changes: [
          {
            field: 'comments',
            value: {
              id: 'cm-77',
              media: { id: 'm-5' },
              text: 'PROOF',
              from: { id: 'u-1', username: 'alice' },
              timestamp: '2026-08-31T12:00:00+0000',
            },
          },
          { field: 'mentions', value: { id: 'x' } },
        ],
      },
    ],
  }
  it('extracts comment events and ignores other fields', () => {
    const events = parseCommentWebhook(body)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ commentId: 'cm-77', mediaId: 'm-5', fromId: 'u-1', fromUsername: 'alice' })
    expect(events[0].timestampMs).toBe(Date.parse('2026-08-31T12:00:00+0000'))
  })
  it('never throws on junk', () => {
    expect(parseCommentWebhook(null)).toEqual([])
    expect(parseCommentWebhook({ object: 'page' })).toEqual([])
    expect(parseCommentWebhook({ object: 'instagram', entry: [{ changes: [{ field: 'comments', value: {} }] }] })).toEqual([])
  })
})

describe('webhook signature', () => {
  const secret = 'app-secret'
  const raw = '{"object":"instagram"}'
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  it('accepts a valid signature and rejects everything else', () => {
    expect(verifyWebhookSignature(secret, raw, sig)).toBe(true)
    expect(verifyWebhookSignature(secret, raw + ' ', sig)).toBe(false)
    expect(verifyWebhookSignature(secret, raw, 'sha256=deadbeef')).toBe(false)
    expect(verifyWebhookSignature(secret, raw, null)).toBe(false)
    expect(verifyWebhookSignature(secret, raw, 'md5=abc')).toBe(false)
  })
})

describe('triage', () => {
  const self = 'acct-1'
  it('matches whole-word triggers case-insensitively', () => {
    expect(triageComment(event({ text: 'PROOF pls' }), [campaign()], self).verdict).toBe('reply')
    expect(triageComment(event({ text: 'bulletproof' }), [campaign()], self).verdict).toBe('ignore')
  })
  it('routes complaints to a human even when the trigger matches', () => {
    const t = triageComment(event({ text: 'proof? this is a scam' }), [campaign()], self)
    expect(t.verdict).toBe('human')
  })
  it('ignores own echoes and empty comments', () => {
    expect(triageComment(event({ fromId: self }), [campaign()], self).verdict).toBe('ignore')
    expect(triageComment(event({ text: '   ' }), [campaign()], self).verdict).toBe('ignore')
  })
  it('anyComment campaigns accept unmatched text but respect media scoping', () => {
    const scoped = campaign({ anyComment: true, mediaIds: ['m-2'] })
    expect(triageComment(event({ text: 'nice!' }), [scoped], self).verdict).toBe('ignore')
    expect(triageComment(event({ text: 'nice!', mediaId: 'm-2' }), [scoped], self).verdict).toBe('reply')
  })
})

describe('freshness + dedupe', () => {
  it('stops a day before the 7-day API boundary', () => {
    const now = Date.now()
    expect(isCommentFresh(event({ timestampMs: now - MAX_COMMENT_AGE_MS + 1000 }), now)).toBe(true)
    expect(isCommentFresh(event({ timestampMs: now - MAX_COMMENT_AGE_MS - 1000 }), now)).toBe(false)
  })
  it('one key per person per campaign', () => {
    expect(dmDedupeKey('u-9', 'c-1')).toBe('c-1:u-9')
    expect(dmDedupeKey('u-9', 'c-1')).toBe(dmDedupeKey('u-9', 'c-1'))
  })
})

describe('template linting', () => {
  it('renders variables and passes an honest template', () => {
    const { text, problems } = renderDmTemplate(campaign(), event())
    expect(problems).toEqual([])
    expect(text).toContain('dev_kim')
    expect(text).toContain('https://handsel-main.vercel.app/proof/2')
  })
  it('rejects unknown variables, over-length, and missing self-identification', () => {
    expect(renderDmTemplate(campaign({ template: 'hi {{who}} from Handsel' }), event()).problems.join(' ')).toMatch(/unknown variable/)
    expect(renderDmTemplate(campaign({ template: 'Handsel ' + 'x'.repeat(1200) }), event()).problems.join(' ')).toMatch(/chars/)
    expect(renderDmTemplate(campaign({ template: 'hey {{username}} check {{link}}' }), event()).problems.join(' ')).toMatch(/self-identify/)
  })
  it('falls back to a neutral greeting when username is missing', () => {
    const { text } = renderDmTemplate(campaign(), event({ fromUsername: '' }))
    expect(text).toContain('Hey there')
  })
})
