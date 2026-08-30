/**
 * Auto-mine scope — how far from home an autonomous worker is allowed to go.
 *
 * `set_auto_mine` used to be one boolean per agent: on, and the agent bid on
 * the entire public board. That is the right default for a rig somebody
 * deliberately pointed at the open market. It is the wrong default for the
 * fourteen specialists an office template hires, and the difference is real
 * money:
 *
 *   A "Due Diligence Desk" was hired, which turns auto-mine on for every
 *   role that appears as a pipeline step (lib/office-hire.ts) so the desk can
 *   work its OWN pipeline without the owner clicking Accept fourteen times.
 *   Nothing in that gesture says "and also go bid on strangers' jobs" — but
 *   that is what it did. One of those workers claimed an unrelated third
 *   party's job, staked a USDC bond and its credit score on it, and failed
 *   the grading. The owner approved none of it and was told none of it.
 *
 * So scope is separate from the on/off switch, and its default is derived
 * from WHY auto-mine was turned on rather than stored at the moment it was:
 *
 *   - hired into an office role  → `own`    (work this account posted)
 *   - switched on by its owner   → `market` (the whole board, unchanged)
 *
 * Derived, not backfilled, because the accounts already holding this defect
 * were hired before any of this existed; a stored default would have to be
 * migrated onto them and would silently miss anyone the migration skipped.
 * An explicit choice always wins over the derived one — see resolveMineScope.
 *
 * `own` is deliberately about the REQUESTER, not the office slot: an office's
 * pipeline steps, a delegation's subtasks and a storefront commission are all
 * posted by one of the account's own agents, so one rule covers all three.
 */

export type MineScope =
  /** Only jobs posted by an agent on this same account. */
  | 'own'
  /** Every open job on the public board, including strangers'. */
  | 'market'

export const MINE_SCOPES: readonly MineScope[] = ['own', 'market']

/** Parse a caller-supplied scope. Returns null for anything unrecognised so
 *  the caller can say what it did not understand, rather than silently
 *  widening a worker's mandate to the whole market. */
export function normalizeMineScope(value: unknown): MineScope | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === 'own' || v === 'own_office' || v === 'office') return 'own'
  if (v === 'market' || v === 'open' || v === 'open_market') return 'market'
  return null
}

/**
 * The scope an agent has when nobody has chosen one.
 *
 * `hiredForOfficeRole` is true when the agent holds a template role
 * (`agent_office_slot.role_id`) — i.e. auto-mine was switched on for it by
 * hire_office rather than by a person deciding this worker should compete.
 */
export function defaultMineScope(input: { hiredForOfficeRole: boolean }): MineScope {
  return input.hiredForOfficeRole ? 'own' : 'market'
}

/** The scope actually in force: an explicit choice, else the derived default. */
export function resolveMineScope(input: {
  stored: MineScope | null
  hiredForOfficeRole: boolean
}): MineScope {
  return input.stored ?? defaultMineScope({ hiredForOfficeRole: input.hiredForOfficeRole })
}

/** May a worker at this scope take a job with this requester? */
export function scopeAllows(scope: MineScope, isOwnAccountJob: boolean): boolean {
  return scope === 'market' || isOwnAccountJob
}

/** One line an operator can act on: what this worker will and will not take,
 *  and — when it is the derived default — that it was not their choice, so
 *  they know it can be widened. */
export function describeMineScope(scope: MineScope, explicit: boolean): string {
  const rule =
    scope === 'own'
      ? 'It will only claim work posted by your own agents (office pipeline steps, delegation subtasks, storefront commissions) — never a stranger\'s job.'
      : 'It will claim any qualifying job on the open board, including ones posted by other accounts — each stakes a USDC bond and its credit score.'
  const how = explicit
    ? ''
    : scope === 'own'
      ? ' (default for a worker hired into an office role; pass scope:"market" to let it bid on the open board.)'
      : ' (default for a worker you switched on yourself; pass scope:"own" to keep it on your own work only.)'
  return `scope: ${scope}. ${rule}${how}`
}
