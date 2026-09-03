/**
 * The pilot offer, per target, as something one click can send.
 *
 * docs/verified-work-pilot-offer.md holds message A once, generically. A
 * real send is to one organisation, and the sentence that earns the reply is
 * the one that is true about *them*: "you have already paid $5,100 on merge
 * through Algora". This module composes that message from a target record —
 * the organisation, the true sentence, the evidence link, the channel — and
 * turns it into the link a browser opens: a mailto: with subject and body
 * filled, or a GitHub Discussions "new" URL with title and body filled.
 *
 * Nothing here sends. The owner clicks, reads, and presses send in their own
 * client — the doc's rule ("the owner sends; nothing here is sent by code")
 * is kept, only the typing is removed.
 *
 * What is refused, by test: the sentences the doc forbids ("you pay
 * nothing", pooled settlement rates, a proof as quality), and any target
 * without an evidence URL — a claim about a stranger's money that cannot be
 * clicked is not a sentence this market sends.
 */
import { POSTING_FEE_BPS, POSTING_FEE_FLAT_USD, SILENCE_FORFEIT_BPS, REPO_JOB_TEMPLATES } from '@/lib/repo-job-templates'

export type Channel =
  | { kind: 'email'; to: string }
  | { kind: 'discussion'; repo: string; category: string }
  | { kind: 'slack'; inviteUrl: string }
  | { kind: 'telegram'; url: string }
  | { kind: 'form'; url: string }

export type PilotTarget = {
  id: string
  org: string
  /** The repository the three issues would come from. */
  repo: string
  /** One true sentence about them, from the evidence. Goes first in the body. */
  because: string
  evidenceUrl: string
  channel: Channel
  /** Why they are on the list, for the sender — not sent. */
  fit: string
}

export type PilotLinks = {
  menu: string
  terms: string
  fleet: string
}

export const DEFAULT_LINKS: PilotLinks = {
  menu: 'https://github.com/Kairose-master/handsel/blob/main/docs/verified-work-menu.md',
  terms: 'https://github.com/Kairose-master/handsel/blob/main/docs/worker-terms.md',
  fleet: 'https://handsel-main.vercel.app/fleet',
}

/** The doc's "must never say" list, as patterns. */
export const FORBIDDEN: readonly RegExp[] = [
  /you pay nothing/i,
  /pay nothing/i,
  /free of charge/i,
  /\d+%\s*(settlement|pass) rate/i,
  /proof (establishes|proves|guarantees) quality/i,
]

const pct = (bps: number) => `${bps / 100}%`

export function pilotSubject(t: PilotTarget): string {
  return `three issues on ${t.repo}, you pay only what merges`
}

export function pilotBody(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): string {
  const prices = REPO_JOB_TEMPLATES.map((m) => `${m.label.toLowerCase()} ($${m.bountyUsd})`).join(', ')
  return [
    `Hi ${t.org} team,`,
    '',
    `${t.because} That is the only reason I am writing: I run Handsel, a market where an AI agent takes a GitHub issue, opens a PR, your own CI grades it, and your merge is what releases payment. If you do not merge, you do not pay the bounty.`,
    '',
    `I would like to do three of ${t.repo}'s open issues as a pilot. The menu is fixed scope: ${prices}. 24-hour delivery, one PR each, no refactors, no scope creep. The exact brief and acceptance criteria are public: ${links.menu}`,
    '',
    `What happens with the money, exactly: the bounty is escrowed on Base in USDC when the job is posted, plus a ${pct(POSTING_FEE_BPS)} + $${POSTING_FEE_FLAT_USD.toFixed(2)} posting fee that is not refunded on any path. If you merge, the worker is paid. If you close the PR unmerged, ${100 - SILENCE_FORFEIT_BPS / 100}% of the escrow returns at the 24-hour review deadline and ${pct(SILENCE_FORFEIT_BPS)} goes to the worker under the contract's silence rule; a dispute you win returns 100%. Every rule with the contract function behind it: ${links.terms}`,
    '',
    'For the pilot I will front the escrow and the fee myself, so your cost is zero unless you merge; if you merge, you pay me the bounty by whatever means you already use. I am not asking you to touch a wallet for three issues. What I want back is three honest outcomes I can publish: merged, closed, or declined, with your reason.',
    '',
    `Pick three, or say the word and I will propose three from ${t.repo}'s labelled backlog. What this is part of, in one page: ${links.fleet}`,
    '',
    'Thanks,',
  ].join('\n')
}

/** The text a person pastes where no link can carry it (Slack, a form). */
export function pilotPlain(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): string {
  return `${pilotSubject(t)}\n\n${pilotBody(t, links)}`
}

const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '%20')

/** mailto: with subject and body filled. Webmail takes a URL this long;
 *  some desktop clients cut near 2k characters, so the page also offers
 *  copy. Kept under 4k by test. */
export function mailtoLink(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): string | null {
  if (t.channel.kind !== 'email') return null
  return `mailto:${t.channel.to}?subject=${enc(pilotSubject(t))}&body=${enc(pilotBody(t, links))}`
}

/** GitHub's "new discussion" page with the category, title and body filled. */
export function discussionLink(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): string | null {
  if (t.channel.kind !== 'discussion') return null
  return `https://github.com/${t.channel.repo}/discussions/new?category=${enc(t.channel.category)}&title=${enc(pilotSubject(t))}&body=${enc(pilotBody(t, links))}`
}

/** The one-click destination for any channel, and what the click does. */
export function sendAction(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): { label: string; href: string; pasteAfter: boolean } {
  switch (t.channel.kind) {
    case 'email':
      return { label: `Open email to ${t.channel.to}`, href: mailtoLink(t, links)!, pasteAfter: false }
    case 'discussion':
      return { label: `Start a discussion on ${t.channel.repo}`, href: discussionLink(t, links)!, pasteAfter: false }
    case 'slack':
      return { label: 'Join their Slack, then paste', href: t.channel.inviteUrl, pasteAfter: true }
    case 'telegram':
      return { label: 'Open their Telegram, then paste', href: t.channel.url, pasteAfter: true }
    case 'form':
      return { label: 'Open their contact form, then paste', href: t.channel.url, pasteAfter: true }
  }
}

/** Refuses a target the doc would refuse: forbidden sentences, or a claim
 *  about them with nothing to click. Returns the problems, empty when clean. */
export function problemsWith(t: PilotTarget, links: PilotLinks = DEFAULT_LINKS): string[] {
  const out: string[] = []
  const text = pilotPlain(t, links)
  for (const re of FORBIDDEN) if (re.test(text)) out.push(`forbidden sentence: ${re}`)
  if (!/^https?:\/\//.test(t.evidenceUrl)) out.push('evidence is not a URL')
  if (!t.because.trim().endsWith('.')) out.push('the true sentence must be a sentence')
  if (t.channel.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.channel.to)) out.push('email address malformed')
  return out
}
