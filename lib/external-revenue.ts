/**
 * Revenue that came from outside, counted so that inside can never leak in.
 *
 * The owner's 30-day plan, item 6: *record revenue separately; never mix
 * internal faucet jobs with external paid jobs; watch only external requester
 * count, completed amount, repeat rate, and cost per success.*
 *
 * The reason it has to be its own module is the history. docs/product-thesis.md
 * reports 322 jobs and a 62.3% settlement rate, then admits most of that
 * demand was a house faucet the operator funds — and that the Sybil metric's
 * first finding was the market being a star centred on the operator. A
 * revenue number that includes those rows is not optimistic, it is false, and
 * this project has spent a year deleting exactly that kind of number.
 *
 * ## What counts as external
 *
 * A settled job is EXTERNAL when its requester is none of:
 *   - the job faucet (`lib/job-faucet.ts`, `FAUCET_EMAIL`),
 *   - an agent owned by an operator account (`ADMIN_EMAIL`, or any user id
 *     the caller names as internal),
 *   - unresolvable — a requester the ledger cannot attribute is counted as
 *     UNKNOWN, reported on its own line, and never promoted to external.
 *
 * The input rows are `JOB_COMPLETED` events, which `creditWorkerForJob`
 * writes only when requester and worker have DIFFERENT owners — so
 * self-dealing between one account's own agents is already absent before
 * this file sees anything. That rule lives in app/actions/labor.ts and is not
 * duplicated here; this file adds the operator and faucet exclusions on top.
 *
 * ## Cost per success is null on purpose
 *
 * The plan asks for it. Nothing in the ledger records what a job cost to
 * produce — model spend is not stamped on the settlement event — so the
 * field is present, null, and labelled, rather than approximated from a
 * bounty. When cost is recorded it will be a real number here; until then a
 * dash is the honest value.
 *
 * Pure. `scripts/external-revenue.mjs` reads the rows.
 */

export type SettledJob = {
  jobId: number
  bountyUsd: number
  requesterAgentId: string | null
  /** Owner of the requester agent, resolved by the caller. Null = unknown. */
  requesterUserId: string | null
  settledAt: Date
}

export type Origin = 'external' | 'faucet' | 'operator' | 'unknown'

export function originOf(job: SettledJob, ctx: { faucetAgentId: string | null; internalUserIds: ReadonlySet<string> }): Origin {
  if (!job.requesterAgentId) return 'unknown'
  if (ctx.faucetAgentId && job.requesterAgentId === ctx.faucetAgentId) return 'faucet'
  if (!job.requesterUserId) return 'unknown'
  if (ctx.internalUserIds.has(job.requesterUserId)) return 'operator'
  return 'external'
}

export type ExternalRevenue = {
  /** Distinct external requester accounts (owners, not agents — one company
   *  running five agents is one customer). */
  externalRequesters: number
  externalJobs: number
  /** Bounty actually released on external jobs. Null with no external jobs. */
  externalCompletedUsd: number | null
  /** Share of external requesters that bought more than once. Null with no
   *  external requesters — "0% repeat" and "nobody to repeat" differ. */
  repeatRate: number | null
  /** Always null until the ledger records production cost. Present so the
   *  gap is visible, not so a bounty can stand in for it. */
  costPerSuccessUsd: null
  /** What was excluded, so the number above can be checked against the raw
   *  count rather than taken on faith. */
  excluded: { faucet: number; operator: number; unknown: number }
  from: Date | null
  to: Date | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function externalRevenue(
  jobs: readonly SettledJob[],
  ctx: { faucetAgentId: string | null; internalUserIds: ReadonlySet<string> },
): ExternalRevenue {
  const excluded = { faucet: 0, operator: 0, unknown: 0 }
  const external: SettledJob[] = []
  for (const j of jobs) {
    const o = originOf(j, ctx)
    if (o === 'external') external.push(j)
    else excluded[o] += 1
  }

  const byOwner = new Map<string, number>()
  for (const j of external) byOwner.set(j.requesterUserId!, (byOwner.get(j.requesterUserId!) ?? 0) + 1)
  const repeaters = [...byOwner.values()].filter((n) => n > 1).length
  const times = external.map((j) => j.settledAt.getTime())

  return {
    externalRequesters: byOwner.size,
    externalJobs: external.length,
    externalCompletedUsd: external.length === 0 ? null : round2(external.reduce((s, j) => s + j.bountyUsd, 0)),
    repeatRate: byOwner.size === 0 ? null : round2(repeaters / byOwner.size),
    costPerSuccessUsd: null,
    excluded,
    from: times.length ? new Date(Math.min(...times)) : null,
    to: times.length ? new Date(Math.max(...times)) : null,
  }
}

export function renderExternalRevenue(r: ExternalRevenue): string {
  const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—')
  return [
    '# External revenue',
    '',
    `Settled jobs whose requester is neither the faucet nor an operator account, ${day(r.from)} to ${day(r.to)}.`,
    '',
    `- External requesters (accounts): **${r.externalRequesters}**`,
    `- External jobs settled: **${r.externalJobs}**`,
    `- Bounty released on them: **${usd(r.externalCompletedUsd)}**`,
    `- Repeat rate: **${pct(r.repeatRate)}**`,
    `- Cost per success: **—** (production cost is not recorded on the ledger yet)`,
    '',
    `Excluded: ${r.excluded.faucet} faucet, ${r.excluded.operator} operator, ${r.excluded.unknown} unattributable.`,
    '',
    'A dash is a figure that could not be sourced. It is never zero.',
  ].join('\n')
}
