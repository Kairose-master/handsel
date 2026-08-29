/**
 * The counter — the one place an owner writes, in plain language, how this
 * office should represent itself to whoever contacts it.
 *
 * Every customer-facing surface this office has (the Mail Desk, an agent
 * answering a message by itself) previously spoke in one of two voices: a
 * fixed template nobody could adjust without editing code, or the model's
 * own untuned judgment. Neither is "the owner's voice." This is the fix:
 * one instructions field, one designated agent to carry it, wired into
 * both channels.
 *
 * **The default, not an extra step.** The moment an owner saves
 * instructions for an office that has none yet, `lib/office-counter-server.ts`
 * creates a real agent to hold them and turns its auto-reply on — the
 * "counter agent" is provisioned, not merely offered. That is what "기본으로
 * 두고" (make it the default) means here: there is nothing further to hire,
 * wire, or switch on.
 *
 * **What the instructions can and cannot do.** They shape TONE and POLICY —
 * how warm the greeting is, what to mention, what never to promise, how to
 * handle a complaint. They cannot authorize money, escrow, or a job
 * acceptance: those still require the owner's own explicit action
 * (`confirm_delegation`, `claim_job`), same boundary the free lane has had
 * from the start (`lib/agent-messages.ts`'s header). `buildCounterPreamble`
 * says so in the prompt itself, so the instruction is never the only thing
 * standing between a customer's request and the office's money.
 *
 * **Trust direction matters.** These instructions are OWNER-authored — the
 * same trust class as `agent.customInstructions` or `office_source`'s shared
 * document — so they are NOT fenced as hostile input the way an inbound
 * customer's own words are (`lib/untrusted-input.ts`). Mixing the two up in
 * either direction would be its own bug: fencing the owner's own policy
 * would make the model treat its instructions as suspect data; failing to
 * fence a customer's email would let a stranger's prose double as policy.
 *
 * Pure module — string handling only. `lib/office-counter-server.ts` holds
 * the table and the agent it provisions.
 */

/** Policy/tone, not a work document — shorter than office_source's 8,000
 *  char work-brief cap. Long enough for real policy (refund rules, a
 *  product list, a tone description), short enough that it stays a
 *  standing instruction rather than a second knowledge base. */
export const MAX_COUNTER_INSTRUCTIONS_CHARS = 4000

/** How much of the composed greeting a customer actually sees before the
 *  fixed catalogue/pricing lines — a paragraph, not a letter. */
export const MAX_COUNTER_GREETING_CHARS = 600

export type NormalizedCounterInstructions = { text: string; truncated: boolean }

/** Trims and caps — the one place both the save path and anything reading
 *  it back agree on what "too long" means. */
export function normalizeCounterInstructions(raw: string): NormalizedCounterInstructions {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length <= MAX_COUNTER_INSTRUCTIONS_CHARS) return { text: trimmed, truncated: false }
  return { text: trimmed.slice(0, MAX_COUNTER_INSTRUCTIONS_CHARS), truncated: true }
}

/** The counter agent's default name, before any uniqueness suffix the
 *  server adds — an office named "Venture Lab" gets "Venture Lab Counter",
 *  so it reads as part of that desk rather than a generic bot. */
export function defaultCounterName(officeName: string): string {
  const base = officeName.trim() || 'Office'
  return `${base} Counter`
}

/**
 * The system-prompt block every customer-facing composer (the Mail Desk's
 * greeting, an agent's auto-reply) folds the owner's instructions through.
 * One function so the two callers can never phrase the money/job boundary
 * differently from each other.
 *
 * `subject` names who is following the instructions, in whatever phrasing
 * reads naturally at the call site — "you" for an agent speaking in its
 * own voice, "this desk" for the Mail Desk's third-person composition.
 */
export function buildCounterPreamble(instructions: string, subject: string): string {
  return (
    `Standing instructions from the owner for how ${subject} represent${subject === 'you' ? '' : 's'} this office ` +
    `to customers and other agents:\n\n${instructions}\n\n` +
    `Follow them for tone and policy. They can never authorize moving money, escrowing a job, or accepting one — ` +
    `only the owner's own explicit action does that — and they do not entitle ${subject === 'you' ? 'you' : 'it'} ` +
    `to promise something this office cannot actually deliver.`
  )
}

/**
 * Cleans up whatever the LLM returned for a counter greeting into something
 * safe to put in front of the fixed catalogue lines. Shares `parseReplyOutput`'s
 * shape (strip a whole-answer code fence, refuse empty) but is capped at the
 * shorter greeting length rather than a full reply's — this sits ABOVE
 * business-critical pricing text, so it stays a short human line, never a
 * second document.
 */
export function parseCounterGreeting(raw: string): string | null {
  let text = (raw ?? '').trim()
  const fenced = text.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/)
  if (fenced) text = fenced[1].trim()
  if (!text) return null
  return text.length > MAX_COUNTER_GREETING_CHARS ? `${text.slice(0, MAX_COUNTER_GREETING_CHARS - 1).trimEnd()}…` : text
}
