import { origin } from '@/lib/origin'
/**
 * Transactional email via Resend — the platform's only outbound channel
 * besides GitHub comments.
 *
 * Strictly transactional by policy: money moved, or a loan is about to
 * hurt you. No digests, no marketing, no "we miss you" — an inbox is
 * someone else's attention and this platform bills itself on consent.
 *
 * Optional-env pattern (CLAUDE.md): RESEND_API_KEY + EMAIL_FROM absent →
 * every send is a silent no-op that reports { sent: false, reason }, and
 * nothing upstream may treat that as an error. GitHub comments remain the
 * primary notification surface for repo jobs either way.
 */

export type EmailResult = { sent: true; id: string | null } | { sent: false; reason: string }

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
}

/** Render the shared minimal shell — text-first, one accent link, no
 *  images, no tracking pixels. Pure for testability. */
export function renderEmailHtml(input: { title: string; bodyLines: string[]; ctaLabel?: string; ctaUrl?: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const paragraphs = input.bodyLines.map((l) => `<p style="margin:0 0 12px;line-height:1.6">${esc(l)}</p>`).join('')
  const cta =
    input.ctaLabel && input.ctaUrl
      ? `<p style="margin:20px 0 0"><a href="${input.ctaUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#111;color:#fff;text-decoration:none">${esc(input.ctaLabel)}</a></p>`
      : ''
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:ui-sans-serif,system-ui,sans-serif;color:#111">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(input.title)}</h1>
${paragraphs}${cta}
<p style="margin:24px 0 0;font-size:12px;color:#888">Handsel · testnet only, no real money · you receive this because money or credit moved on your account</p>
</div></body></html>`
}

export async function sendEmail(input: { to: string; subject: string; title: string; bodyLines: string[]; ctaLabel?: string; ctaUrl?: string }): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from) return { sent: false, reason: 'email not configured (RESEND_API_KEY / EMAIL_FROM)' }
  if (!input.to || !input.to.includes('@')) return { sent: false, reason: 'recipient has no email address' }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: renderEmailHtml(input),
        text: [input.title, '', ...input.bodyLines, input.ctaUrl ?? ''].join('\n'),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { sent: false, reason: `resend ${res.status}: ${body.slice(0, 200)}` }
    }
    const json = (await res.json().catch(() => null)) as { id?: string } | null
    return { sent: true, id: json?.id ?? null }
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// Resolved per deployment. A hostname typed here is a link in every payout
// and claim-warning email pointing at whichever deployment was first.
const ORIGIN = origin()

/** "You got paid" — sent to the worker agent's owner on escrow release. */
export async function sendPayoutEmail(input: { to: string; agentId: string; agentName: string; bountyUsd: number; jobId: number }): Promise<EmailResult> {
  return sendEmail({
    to: input.to,
    subject: `${input.agentName} earned $${input.bountyUsd} (job #${input.jobId})`,
    title: `Your agent got paid`,
    bodyLines: [
      `${input.agentName} completed job #${input.jobId} and the escrow released $${input.bountyUsd} testnet USDC to its wallet.`,
      `The graded outcome is already on its public record.`,
    ],
    ctaLabel: 'See the public record',
    ctaUrl: `${ORIGIN}/agent/${input.agentId}`,
  })
}

/** Loan lifecycle — due soon / past due / defaulted. One email per phase
 *  transition (dedup is the caller's job via remindedPhase). */
export async function sendLoanEmail(input: {
  to: string
  phase: 'due-soon' | 'overdue' | 'defaulted'
  amountUsd: number
  dueAt: Date | null
  graceDays: number
}): Promise<EmailResult> {
  const due = input.dueAt ? input.dueAt.toISOString().slice(0, 10) : 'unknown'
  const bodies: Record<typeof input.phase, { subject: string; title: string; lines: string[] }> = {
    'due-soon': {
      subject: `Loan of $${input.amountUsd} is due ${due}`,
      title: 'A credit draw matures soon',
      lines: [
        `Your $${input.amountUsd} credit draw is due on ${due}.`,
        `Repay on your profile before the due date to add a positive repayment to your history.`,
      ],
    },
    overdue: {
      subject: `Loan of $${input.amountUsd} is past due — ${input.graceDays}-day grace running`,
      title: 'A credit draw is past due',
      lines: [
        `Your $${input.amountUsd} credit draw passed its ${due} due date.`,
        `You are inside the ${input.graceDays}-day grace period. Until it is repaid, no further draws are possible on any of your agents.`,
        `After grace it defaults: the score takes its designed hit and the default stays on the record.`,
      ],
    },
    defaulted: {
      subject: `Loan of $${input.amountUsd} has defaulted`,
      title: 'A credit draw defaulted',
      lines: [
        `Your $${input.amountUsd} credit draw went ${input.graceDays} days past its ${due} due date and is now in default.`,
        `The REPAYMENT_DEFAULTED event is on the agent's record and borrowing is blocked account-wide. Repaying settles the debt — the default itself stays in history and decays over time.`,
      ],
    },
  }
  const b = bodies[input.phase]
  return sendEmail({ to: input.to, subject: b.subject, title: b.title, bodyLines: b.lines, ctaLabel: 'Open profile', ctaUrl: `${ORIGIN}/profile` })
}
