import { describe, it, expect } from 'vitest'
import { DEFAULT_LINKS, FORBIDDEN, discussionLink, mailtoLink, pilotBody, pilotSubject, problemsWith, sendAction, type PilotTarget } from '@/lib/pilot-outreach'
import { POSTING_FEE_BPS, POSTING_FEE_FLAT_USD, REPO_JOB_TEMPLATES, SILENCE_FORFEIT_BPS } from '@/lib/repo-job-templates'

const email: PilotTarget = {
  id: 'acme',
  org: 'Acme',
  repo: 'acme/widget',
  because: 'You have paid $5,100 across 7 bounties on merge through Algora.',
  evidenceUrl: 'https://algora.io/acme/home',
  channel: { kind: 'email', to: 'hello@acme.dev' },
  fit: 'pays on merge already',
}
const discussion: PilotTarget = { ...email, id: 'acme-d', channel: { kind: 'discussion', repo: 'acme/widget', category: 'general' } }

describe('the message says the true money terms and nothing the doc forbids', () => {
  it('opens with the sentence that is true about them', () => {
    expect(pilotBody(email).startsWith(`Hi Acme team,\n\n${email.because}`)).toBe(true)
  })
  it('carries every enforced figure: menu prices, fee, silence forfeit, dispute', () => {
    const b = pilotBody(email)
    for (const m of REPO_JOB_TEMPLATES) expect(b).toContain(`($${m.bountyUsd})`)
    expect(b).toContain(`${POSTING_FEE_BPS / 100}% + $${POSTING_FEE_FLAT_USD.toFixed(2)}`)
    expect(b).toContain(`${100 - SILENCE_FORFEIT_BPS / 100}% of the escrow returns`)
    expect(b).toContain('a dispute you win returns 100%')
    expect(b).toContain(DEFAULT_LINKS.terms)
    expect(b).toContain(DEFAULT_LINKS.menu)
    expect(b).toContain(DEFAULT_LINKS.fleet)
  })
  it('never says "you pay nothing" — the fee is never refunded', () => {
    const text = `${pilotSubject(email)}\n${pilotBody(email)}`
    for (const re of FORBIDDEN) expect(text, String(re)).not.toMatch(re)
    expect(text).toMatch(/your cost is zero unless you merge/)
    expect(problemsWith(email)).toEqual([])
  })
  it('refuses a claim with nothing to click, and a non-sentence', () => {
    expect(problemsWith({ ...email, evidenceUrl: 'algora' })).toContain('evidence is not a URL')
    expect(problemsWith({ ...email, because: 'paid on merge' })).toContain('the true sentence must be a sentence')
    expect(problemsWith({ ...email, channel: { kind: 'email', to: 'nope' } })).toContain('email address malformed')
  })
})

describe('one click', () => {
  it('a mailto with subject and body filled', () => {
    const href = mailtoLink(email)!
    expect(href.startsWith('mailto:hello@acme.dev?subject=three%20issues%20on%20acme%2Fwidget')).toBe(true)
    expect(decodeURIComponent(href.split('&body=')[1])).toBe(pilotBody(email))
    // Long for a mailto, and known: webmail takes it, some desktop clients cut
    // near 2k. The page offers copy for those; the composer stays under 4k.
    expect(href.length).toBeLessThan(4000)
  })
  it('a GitHub new-discussion URL with category, title and body filled', () => {
    const href = discussionLink(discussion)!
    expect(href.startsWith('https://github.com/acme/widget/discussions/new?category=general&title=')).toBe(true)
    expect(decodeURIComponent(href.split('&body=')[1])).toBe(pilotBody(discussion))
  })
  it('channels with no link to carry text say so', () => {
    const slack = sendAction({ ...email, channel: { kind: 'slack', inviteUrl: 'https://acme.dev/join-slack' } })
    expect(slack.pasteAfter).toBe(true)
    expect(slack.href).toBe('https://acme.dev/join-slack')
    expect(sendAction(email).pasteAfter).toBe(false)
    expect(mailtoLink(discussion)).toBeNull()
    expect(discussionLink(email)).toBeNull()
  })
})
