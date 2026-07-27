/**
 * Price discovery for the labor market — the pure core.
 *
 * ## Why there is no order book here
 *
 * A stock order book works because one share is interchangeable with any
 * other. Labor is not: "fix the bug in MY repo" and "fix the bug in YOURS"
 * are different goods, so stacking their bids and asks in one book would be
 * quoting a price for something nobody can actually deliver. A single
 * market-wide 호가창 is therefore not a thing we are choosing not to build —
 * it is a thing that would be a lie.
 *
 * Two mechanisms DO work, and both are here:
 *
 *  1. **Observed price (시세).** Jobs of the same CLASS are close enough to
 *     interchangeable — an i18n chunk of 12 keys really is much like the next
 *     one. The median of what those actually SETTLED for is a real price
 *     signal drawn from real trades. Below `MIN_TRADES_FOR_SIGNAL` we report
 *     "not enough data" rather than dressing up one sale as a market rate.
 *
 *  2. **Rising price (더치 옥션).** An unclaimed job's bounty steps up on a
 *     timer until someone takes it; the first claim IS the clearing price.
 *     This needs exactly one participant on each side, which matters in a
 *     thin market, and it fixes the failure we actually observe: a job that
 *     sits forever because the requester guessed the price wrong.
 *
 * Everything in this file is pure so the arithmetic that moves money is
 * testable without a chain or a database.
 */

// ── Job classes ─────────────────────────────────────────────────────────

export const JOB_CLASSES = ['tests', 'repo', 'image', 'audio', 'video', 'file', 'text'] as const
export type JobClass = (typeof JOB_CLASSES)[number]

/** Title prefixes the dogfood posters use. Kept as literals so this module
 *  stays dependency-free; `tests/market-price.test.ts` asserts they still
 *  match the constants they mirror, so drift fails a test rather than
 *  silently splitting one class into two. */
const CLASS_PREFIXES: Array<[JobClass, string]> = [
  ['tests', 'tests → '],
  ['repo', 'repo → '],
]
// 'i18n' and 'docs' were here. Both were translation work the house posted to
// itself, and both are gone — the operator runs `npm run i18n:translate`
// instead, which uses the same model for free. A price class for work nothing
// can produce is a class that never gets a second data point, so comparability
// within it is a number with a sample size of one.

/**
 * Which price class a job belongs to. Standardized dogfood work is
 * recognised by its title prefix; everything else falls back to what the
 * worker actually has to deliver, which is the next-best proxy for
 * comparability.
 */
export function jobClassOf(title: string | null | undefined, deliverableKind?: string | null): JobClass {
  const t = (title ?? '').trim()
  for (const [cls, prefix] of CLASS_PREFIXES) {
    if (t.startsWith(prefix)) return cls
  }
  const kind = (deliverableKind ?? 'text') as JobClass
  return (JOB_CLASSES as readonly string[]).includes(kind) ? kind : 'text'
}

// ── Observed price (시세) ───────────────────────────────────────────────

/** One trade is one job that actually settled — escrow released to a worker. */
export type Trade = { jobClass: JobClass; bountyUsd: number }

/** Below this, one lucky sale would masquerade as a market rate. */
export const MIN_TRADES_FOR_SIGNAL = 3

export type PriceStat = {
  jobClass: JobClass
  trades: number
  /** null until there are enough trades to mean anything. */
  medianUsd: number | null
  lowUsd: number | null
  highUsd: number | null
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * What each class of work has actually been paid. Classes with too few
 * trades are still returned — with a null median — because "we have one
 * data point" is itself the honest answer to "what does this go for?".
 */
export function summarizePrices(trades: Trade[]): PriceStat[] {
  const byClass = new Map<JobClass, number[]>()
  for (const t of trades) {
    if (!Number.isFinite(t.bountyUsd) || t.bountyUsd <= 0) continue
    const list = byClass.get(t.jobClass) ?? []
    list.push(t.bountyUsd)
    byClass.set(t.jobClass, list)
  }
  return [...byClass.entries()]
    .map(([jobClass, values]) => ({
      jobClass,
      trades: values.length,
      medianUsd: values.length >= MIN_TRADES_FOR_SIGNAL ? median(values) : null,
      lowUsd: values.length >= MIN_TRADES_FOR_SIGNAL ? Math.min(...values) : null,
      highUsd: values.length >= MIN_TRADES_FOR_SIGNAL ? Math.max(...values) : null,
    }))
    .sort((a, b) => b.trades - a.trades)
}

/** One line a requester can act on when pricing a new job. */
export function priceHint(stat: PriceStat | undefined): string {
  if (!stat || stat.trades === 0) return 'No settled trades in this class yet — you are setting the first price.'
  if (stat.medianUsd === null) {
    return `Only ${stat.trades} settled trade${stat.trades === 1 ? '' : 's'} in this class — not enough to quote a rate yet.`
  }
  return `Settled at a median of $${stat.medianUsd.toFixed(2)} (range $${stat.lowUsd!.toFixed(2)}–$${stat.highUsd!.toFixed(2)}) across ${stat.trades} trades.`
}

// ── Rising price (더치 옥션) ────────────────────────────────────────────

/**
 * The requester's standing instruction for an unclaimed job.
 *
 * Note what is NOT here: a "current price". The current price is always the
 * live on-chain bounty, never a number we cache — a cached price that drifts
 * from the escrow is a number that promises money the contract cannot pay.
 */
export type PricingPlan = {
  /** Never raise past this. The requester's real reservation price. */
  ceilingUsd: number
  /** How much each raise adds. */
  stepUsd: number
  /** How long a job must sit unclaimed before the next raise. */
  stepMinutes: number
  /** How many raises have already happened (for the audit trail). */
  raises?: number
  /** The price a replacement listing is supposed to be posted at, written
   *  down BEFORE the old escrow is cancelled. A raise that dies between the
   *  refund and the repost is otherwise untraceable — money back, work gone,
   *  nothing to resume from. See resumeOrphanedRaises in lib/price-raise. */
  pendingUsd?: number
  /** minScore the replacement must carry, for the same reason. */
  pendingMinScore?: number
}

export const DEFAULT_STEP_MINUTES = 60
export const MAX_RAISES = 10

export type RaiseDecision =
  | { shouldRaise: false; reason: string }
  | { shouldRaise: true; nextUsd: number; reason: string }

/**
 * Should this unclaimed job's bounty go up, and to what?
 *
 * The caller must only ask about jobs that are still OPEN. A raise is
 * implemented as cancel-and-repost (the on-chain contract pays a job's full
 * escrowed bounty and has no partial release), and cancelling is only safe
 * while nobody has committed to the work.
 */
export function nextPriceRaise(input: {
  currentUsd: number
  ageMinutes: number
  plan: PricingPlan | null | undefined
}): RaiseDecision {
  const { plan } = input
  if (!plan) return { shouldRaise: false, reason: 'fixed price — no rising-price plan on this job' }

  const ceiling = Number(plan.ceilingUsd)
  const step = Number(plan.stepUsd)
  const stepMinutes = Number(plan.stepMinutes) || DEFAULT_STEP_MINUTES
  if (!Number.isFinite(ceiling) || !Number.isFinite(step) || step <= 0) {
    return { shouldRaise: false, reason: 'invalid pricing plan' }
  }
  if ((plan.raises ?? 0) >= MAX_RAISES) {
    return { shouldRaise: false, reason: `hit the ${MAX_RAISES}-raise cap` }
  }
  if (input.currentUsd >= ceiling) {
    return { shouldRaise: false, reason: `already at the $${ceiling} ceiling` }
  }
  if (input.ageMinutes < stepMinutes) {
    return { shouldRaise: false, reason: `only ${Math.floor(input.ageMinutes)}m unclaimed; next raise at ${stepMinutes}m` }
  }

  // Round to cents so a repeated raise can't accumulate float dust into a
  // bounty the escrow has to match exactly.
  const nextUsd = Math.min(Math.round((input.currentUsd + step) * 100) / 100, ceiling)
  if (nextUsd <= input.currentUsd) return { shouldRaise: false, reason: 'step would not increase the price' }
  return {
    shouldRaise: true,
    nextUsd,
    reason: `unclaimed for ${Math.floor(input.ageMinutes)}m — raising $${input.currentUsd} → $${nextUsd} (ceiling $${ceiling})`,
  }
}

/** Validate what a requester asked for before any escrow moves. */
export function validatePricingPlan(
  startUsd: number,
  plan: Partial<PricingPlan> | null | undefined,
): { ok: true; plan: PricingPlan | null } | { ok: false; error: string } {
  if (!plan || plan.ceilingUsd === undefined || plan.ceilingUsd === null) return { ok: true, plan: null }
  const ceilingUsd = Number(plan.ceilingUsd)
  const stepUsd = Number(plan.stepUsd ?? Math.max(1, Math.round(startUsd * 0.25 * 100) / 100))
  const stepMinutes = Number(plan.stepMinutes ?? DEFAULT_STEP_MINUTES)

  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= startUsd) {
    return { ok: false, error: `The price ceiling must be above the starting bounty of $${startUsd}.` }
  }
  if (!Number.isFinite(stepUsd) || stepUsd <= 0) return { ok: false, error: 'The raise step must be positive.' }
  if (!Number.isFinite(stepMinutes) || stepMinutes < 5) {
    return { ok: false, error: 'The raise interval must be at least 5 minutes.' }
  }
  return { ok: true, plan: { ceilingUsd, stepUsd, stepMinutes, raises: 0 } }
}
