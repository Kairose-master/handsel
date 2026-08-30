/**
 * Escalation — the promise the Mail Desk already made and never kept.
 *
 * "The operator can see this order and will make it right" — that line has
 * been sent to a customer since the desk shipped, on every commission
 * failure. Nobody was ever actually told. The operator "seeing" an order
 * meant opening the dashboard and noticing, unprompted, that one row among
 * many carried a `note` column starting with `COMMISSION FAILED:`. This is
 * the fix: a real email to the account owner, for the two cases where a
 * human, not the counter, is actually who the moment calls for.
 *
 * 1. **A system failure** (`escalateSystemFailure`) — the pipeline could
 *    not be escrowed after a real payment arrived. Unconditional: no
 *    classification needed, a payment stuck between "received" and
 *    "working" is always the owner's problem to look at.
 * 2. **A customer who needs a person** (`escalateCustomerNeed`) — flagged
 *    by the same intent-classification call `extractIntent` already makes
 *    on every inbound email (one LLM call doing double duty, not a second
 *    one), when the sender explicitly asks for a human, is clearly upset,
 *    or is complaining about something already paid for or delivered. The
 *    counter's own instructions can tell it to "apologize and offer to
 *    have the owner follow up" — this is what makes that promise real
 *    rather than decorative.
 *
 * Neither case changes what the CUSTOMER sees. The counter/catalogue/quote
 * reply goes out exactly as it would otherwise; escalation is a purely
 * additional channel to the owner, and every send point wraps it so a
 * failure to notify never blocks or breaks the customer-facing flow.
 *
 * Pure module: validation and email composition only. lib/mail-desk.ts
 * holds the table, the rate limit, and the actual `sendEmail` call.
 */

/** An LLM's escalation reason, one line an operator can scan without
 *  opening the thread. Capped well below a paragraph — this is a flag, not
 *  a case file. */
export const MAX_ESCALATION_REASON_CHARS = 300

/** Rejects an empty, non-string, or junk reason rather than emailing an
 *  owner "Escalated: undefined" — a notification that says nothing wasted
 *  is worse than no notification, because it teaches the owner to ignore
 *  the next one. */
export function normalizeEscalationReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.length > MAX_ESCALATION_REASON_CHARS ? `${trimmed.slice(0, MAX_ESCALATION_REASON_CHARS - 1)}…` : trimmed
}

export type EscalationEmail = { subject: string; title: string; bodyLines: string[] }

/**
 * A system failure — payment landed, the pipeline didn't. Always sent;
 * there is no tone decision here, just the facts an owner needs to act:
 * which order, which customer, what broke.
 */
export function buildSystemFailureEmail(input: { orderId: string; templateId: string; error: string }): EscalationEmail {
  return {
    subject: `Action needed — HS-${input.orderId} paid but not escrowed`,
    title: 'A customer paid; the pipeline could not start',
    bodyLines: [
      `Order HS-${input.orderId} (${input.templateId}) was paid, but commissioning it failed:`,
      input.error,
      'The customer was told you can see this and will make it right — check the order, or reply to them directly.',
    ],
  }
}

/**
 * A customer the counter judged needs an actual person — asked for one,
 * is upset, or is complaining about paid or delivered work. The reason is
 * the classifier's own one-line summary, not the customer's raw email —
 * an owner scanning a dozen of these wants "wants a refund, says the logo
 * doesn't match spec", not the full thread pasted in.
 */
export function buildCustomerNeedEmail(input: { fromEmail: string; subject: string; reason: string }): EscalationEmail {
  return {
    subject: `A customer wants a person — ${input.subject.slice(0, 80)}`,
    title: 'Flagged for you, not the counter',
    bodyLines: [
      `${input.fromEmail} wrote in, and the desk thinks this needs you rather than an automated reply:`,
      input.reason,
      `Original subject: "${input.subject}"`,
      'The customer still got the desk\'s normal reply — this is in addition to it, not instead of it.',
    ],
  }
}
