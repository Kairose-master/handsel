/**
 * Spend envelope — the policy layer that sits in front of every path that
 * moves an agent's money OUT of its wallet, evaluated immediately before the
 * transfer is signed and nowhere else.
 *
 * Why this exists. `lib/approval-policy.ts` governs escrow RELEASES inside an
 * office session, the gas paymaster and the Automaton have per-window caps,
 * but the four paths an operator (or a connector) can reach directly —
 * `fund_agent_usdc`, `fund_agent_eth`, `withdraw_agent_eth` and auto-mine's
 * bond stake — had no per-transaction ceiling, no daily ceiling and no
 * recipient rule beyond "same owner". A prompt-injected connector could drain
 * a desk in one call. The Sep-2026 ecosystem converged on the same shape for
 * this (FlashyLabs wdk-policy-guard, Totem session wallets, Lucid outgoing
 * policies): a per-agent envelope graded to ALLOW / ESCALATE / DENY, with a
 * closed list of denial codes so two implementations can agree on a verdict.
 *
 * This file is PURE: it knows nothing about the database or the chain. The
 * 24-hour ledger read and the audit row are `lib/spend-envelope-server.ts`.
 * Amounts are USD numbers rounded to 6 places (USDC precision); ETH is priced
 * by the caller into USD before it gets here, because the envelope is about
 * value at risk, not which token carried it.
 */

export type SpendKind = 'fund_usdc' | 'fund_eth' | 'withdraw_eth' | 'bond' | 'x402_tool'

export type SpendEnvelope = {
  /** Largest single transfer the agent may make without an owner override. */
  perTxMaxUsd: number
  /** Largest sum of transfers in any rolling 24h window. */
  dailyMaxUsd: number
  /** At or under this, ALLOW. Over it (but under the ceilings), ESCALATE:
   *  the caller must come back with an explicit owner approval. */
  autoApproveMaxUsd: number
  /** Kinds this agent may perform at all. Empty = every kind. */
  kinds?: readonly SpendKind[]
  /** Destination addresses (lowercased) this agent may send to. Empty =
   *  whatever the calling path already allows (same-owner agents, the saved
   *  payout address). A bond stake has no destination and skips this. */
  destinations?: readonly string[]
}

export type SpendVerdict = 'ALLOW' | 'ESCALATE' | 'DENY'

/** Closed list. Add a code here and in `DENIAL_CODES` or the conformance
 *  test refuses it — a verdict a reader cannot look up is not a verdict. */
export type SpendDenialCode =
  | 'INVALID_AMOUNT'
  | 'KIND_NOT_ALLOWED'
  | 'DESTINATION_NOT_ALLOWED'
  | 'OVER_PER_TX_MAX'
  | 'OVER_DAILY_MAX'

export const DENIAL_CODES: readonly SpendDenialCode[] = [
  'INVALID_AMOUNT',
  'KIND_NOT_ALLOWED',
  'DESTINATION_NOT_ALLOWED',
  'OVER_PER_TX_MAX',
  'OVER_DAILY_MAX',
]

export type SpendGrade =
  | { verdict: 'ALLOW'; remainingTodayUsd: number }
  | { verdict: 'ESCALATE'; reason: 'OVER_AUTO_APPROVE'; remainingTodayUsd: number }
  | { verdict: 'DENY'; code: SpendDenialCode; detail: string }

export type SpendRequest = {
  kind: SpendKind
  amountUsd: number
  /** Lowercase hex, when the transfer has a destination. */
  destination?: string
  /** Sum of this agent's spends in the trailing 24h, from the ledger. */
  spentTodayUsd: number
  /** The owner said yes to THIS transfer over the auto-approve line. Never
   *  lifts a ceiling — an override is not a bigger envelope. */
  ownerApproved?: boolean
}

/**
 * Platform defaults. Real money is deliberately tight: an office of five
 * workers each bonding a few $1 jobs stays well under them, and anything an
 * operator wants past them is one explicit approval away. On the testnet the
 * same shape applies with looser numbers so the ESCALATE path is exercised
 * in rehearsal rather than met for the first time on mainnet.
 */
export const DEFAULT_ENVELOPE_REAL_MONEY: SpendEnvelope = {
  perTxMaxUsd: 5,
  dailyMaxUsd: 20,
  autoApproveMaxUsd: 1,
}

export const DEFAULT_ENVELOPE_TESTNET: SpendEnvelope = {
  perTxMaxUsd: 50,
  dailyMaxUsd: 200,
  autoApproveMaxUsd: 10,
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** Validate an envelope someone typed (env, admin form, MCP tool). */
export function parseEnvelope(input: unknown): SpendEnvelope | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const perTx = num(o.perTxMaxUsd)
  const daily = num(o.dailyMaxUsd)
  const auto = num(o.autoApproveMaxUsd)
  if (perTx === null || daily === null || auto === null) return null
  if (auto > perTx || perTx > daily) return null
  const env: SpendEnvelope = { perTxMaxUsd: perTx, dailyMaxUsd: daily, autoApproveMaxUsd: auto }
  if (Array.isArray(o.kinds)) {
    const kinds = o.kinds.filter((k): k is SpendKind =>
      ['fund_usdc', 'fund_eth', 'withdraw_eth', 'bond', 'x402_tool'].includes(String(k)),
    )
    if (kinds.length !== o.kinds.length) return null
    env.kinds = kinds
  }
  if (Array.isArray(o.destinations)) {
    const dests = o.destinations.map((d) => String(d).toLowerCase())
    if (dests.some((d) => !/^0x[0-9a-f]{40}$/.test(d))) return null
    env.destinations = dests
  }
  return env
}

/**
 * Grade one spend against the envelope. Order matters and is fixed:
 * validity → kind → destination → per-tx → daily → auto-approve. A DENY is
 * final; an ESCALATE means "not without the owner", and the owner's approval
 * turns it into ALLOW without changing any ceiling.
 */
export function gradeSpend(envelope: SpendEnvelope, req: SpendRequest): SpendGrade {
  const amount = round6(req.amountUsd)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { verdict: 'DENY', code: 'INVALID_AMOUNT', detail: `amount must be a positive USD number, got ${req.amountUsd}` }
  }
  if (envelope.kinds && envelope.kinds.length > 0 && !envelope.kinds.includes(req.kind)) {
    return { verdict: 'DENY', code: 'KIND_NOT_ALLOWED', detail: `${req.kind} is not in this agent's envelope` }
  }
  if (envelope.destinations && envelope.destinations.length > 0 && req.destination !== undefined) {
    const dest = req.destination.toLowerCase()
    if (!envelope.destinations.includes(dest)) {
      return { verdict: 'DENY', code: 'DESTINATION_NOT_ALLOWED', detail: `${dest} is not an allowed destination` }
    }
  }
  if (amount > envelope.perTxMaxUsd) {
    return {
      verdict: 'DENY',
      code: 'OVER_PER_TX_MAX',
      detail: `$${amount} exceeds the $${envelope.perTxMaxUsd} per-transfer ceiling`,
    }
  }
  const spent = round6(Math.max(0, req.spentTodayUsd))
  const remaining = round6(envelope.dailyMaxUsd - spent)
  if (amount > remaining) {
    return {
      verdict: 'DENY',
      code: 'OVER_DAILY_MAX',
      detail: `$${amount} would take today's total to $${round6(spent + amount)}, over the $${envelope.dailyMaxUsd} daily ceiling ($${Math.max(0, remaining)} left)`,
    }
  }
  const remainingAfter = round6(remaining - amount)
  if (amount > envelope.autoApproveMaxUsd && !req.ownerApproved) {
    return { verdict: 'ESCALATE', reason: 'OVER_AUTO_APPROVE', remainingTodayUsd: remainingAfter }
  }
  return { verdict: 'ALLOW', remainingTodayUsd: remainingAfter }
}

/** One line for a tool reply or a log. */
export function gradeInWords(grade: SpendGrade, envelope: SpendEnvelope): string {
  switch (grade.verdict) {
    case 'ALLOW':
      return `allowed — $${grade.remainingTodayUsd} of today's $${envelope.dailyMaxUsd} envelope left afterwards`
    case 'ESCALATE':
      return `needs the owner's approval — over the $${envelope.autoApproveMaxUsd} auto-approve line (ceilings: $${envelope.perTxMaxUsd} per transfer, $${envelope.dailyMaxUsd} per day)`
    case 'DENY':
      return `refused (${grade.code}): ${grade.detail}`
  }
}

/** Sum of a window of spend rows. Pure, so the ledger query stays thin. */
export function sumWindow(rows: readonly { amountUsd: number; at: Date }[], now: Date, windowMs = 24 * 3600 * 1000): number {
  const since = now.getTime() - windowMs
  return round6(rows.filter((r) => r.at.getTime() > since).reduce((s, r) => s + r.amountUsd, 0))
}
