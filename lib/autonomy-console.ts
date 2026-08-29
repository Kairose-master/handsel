/**
 * The autonomy console — one answer to one question.
 *
 * Four things now act on an account without anyone watching: the local gas
 * pool tops agents up so they can transact (lib/local-paymaster.ts), the
 * office Automaton keeps a desk's bond float above a floor
 * (lib/office-automaton.ts), the lineage mandate breeds and retires agents
 * (lib/lineage-mandate.ts), and auto-mine claims jobs on its own
 * (lib/auto-mine.ts). Each shipped with its own switch next to the thing it
 * governs, which is the right home for a control and the wrong home for an
 * overview: an owner asking "what is running by itself on my account, under
 * what limits, and what has it actually done?" had to visit four surfaces
 * and hold the answer in their head.
 *
 * This module is the account-wide read of that. It adds no authority and no
 * new state — every number it shows is fetched from the module that owns it,
 * so the console cannot drift from the thing it describes. Turning something
 * on still happens where that thing lives.
 *
 * Pure by design (no db, no chain): the page rendering this is a client
 * component, and a type that arrives through a module importing pg drags the
 * database into the browser bundle. Same split as office-world-data /
 * office-world-server.
 */

/** One thing an automation actually did, normalized across four sources so a
 *  single timeline can be read top to bottom. */
export type AutonomyLogEntry = {
  /** ISO timestamp. The merge sorts on this, so it is never optional. */
  at: string
  source: 'gas' | 'bond' | 'birth' | 'retirement'
  /** One line, already resolved to names — an audit trail an owner has to
   *  decode by hand is barely an audit trail. */
  what: string
  /** Formatted with its own unit ("$0.25", "0.0002 ETH") or null where the
   *  action moved nothing, which retirement genuinely does not. */
  amount: string | null
  txHash: string | null
  /** False for an action that was recorded and then failed. Recorded-then-
   *  failed is a distinct fact from never-attempted, and the budget already
   *  counted it. */
  ok: boolean
}

/**
 * Merge the per-source logs into one timeline, newest first.
 *
 * Sorting is stable within a timestamp (Array.prototype.sort is required to
 * be stable), so two actions written in the same second keep the order their
 * sources were passed in rather than shuffling between reads — a log that
 * reorders on refresh reads as a log that is making things up.
 *
 * The cap is applied AFTER the merge, never per source: capping first would
 * silently drop the older half of a busy source even when the timeline had
 * room, and the reader would have no way to tell.
 */
export function mergeAutonomyLog(
  sources: ReadonlyArray<readonly AutonomyLogEntry[]>,
  limit = 40,
): AutonomyLogEntry[] {
  const all: AutonomyLogEntry[] = []
  for (const source of sources) all.push(...source)
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return all.slice(0, Math.max(0, limit))
}

/** A standing mandate's spend against what it is allowed. `spent` and
 *  `budget` share a unit; the unit is named rather than assumed, because gas
 *  is wei and the rest is USD and a console that mixed them silently would
 *  be worse than one that showed nothing. */
export type MandateBudget = { spent: number; budget: number; unit: 'usd' | 'eth' }

export type OfficeAutonomy = {
  slot: number
  name: string
  automaton: { enabled: boolean; floorUsd: number } & MandateBudget
  lineage: {
    enabled: boolean
    /** False on a real-money deployment without the explicit env opt-in.
     *  Reported separately from `enabled` on purpose: "switched on but
     *  refused here" and "switched off" are different facts. */
    allowedHere: boolean
    birthsToday: number
    retirementsToday: number
    seededTodayUsd: number
    maxBirthsPerWindow: number
  }
}

export type AutonomyView = {
  /** Which market this account is acting in. First thing on the page,
   *  because every limit below means something different depending on it. */
  deployment: { realMoney: boolean; chainName: string }
  gasPool:
    | ({ sourceAgentName: string; enabled: boolean; targetEth: string } & MandateBudget)
    | null
  autoMine: { enabled: number; total: number }
  /** Agents answering incoming messages by themselves. `answerable` is the
   *  subset whose runtime the platform can actually call — the same
   *  "switched on but refused here" distinction lineage draws, because an
   *  owner who flipped a switch that can never fire has been told nothing
   *  by a green light. */
  autoReply: { enabled: number; answerable: number; total: number }
  offices: OfficeAutonomy[]
  log: AutonomyLogEntry[]
  /** True when at least one automation could act right now. Drives the
   *  page's headline, so it is computed from the same fields the rows show
   *  rather than tracked separately. */
  anyActive: boolean
}

/** Whether anything on this account is actually able to act. Pure, and
 *  deliberately strict: a lineage mandate switched on but refused by the
 *  deployment gate is NOT active, and a console that counted it would tell
 *  an owner something is running when nothing is. */
export function isAnythingActive(view: Omit<AutonomyView, 'anyActive'>): boolean {
  if (view.gasPool?.enabled) return true
  if (view.autoMine.enabled > 0) return true
  // On, but on a runtime nothing can call, is not running.
  if (view.autoReply.answerable > 0) return true
  return view.offices.some((o) => o.automaton.enabled || (o.lineage.enabled && o.lineage.allowedHere))
}
