# Public market metrics (issue #10)

## Scope and snapshot

`/api/market-health` and `/api/market/index` now use the same complete contract
reader. `/api/tasks` derives its EVM rows from that reader too. Each exposes
`snapshot.chainId`, `contractAddress`, `blockNumber`, `observedAt`, `state` and
`coverage`. The job count and all getters are pinned to that block. Cached rows
retain their original observation time (default cache: four seconds).

Separate requests and server instances can observe different blocks. Compare
like chain/contract/block tuples; `generatedAt` is response construction time,
not the chain observation time. The block is latest, not a finality guarantee.
A failed individual getter makes the aggregate unavailable, not a smaller total.

The index's `quality.completedJobs` and health's `jobs.byStatus.Completed`
(defaulting to zero only on an **ok** snapshot) count unique contract jobs in
Completed state. This covers the configured contract, not every historical
Handsel contract or chain. A successful empty read is zero. An unavailable
read has null aggregate totals and an explicit state; health's empty status map
in that case is not evidence of zero completions.

The tasks feed is **not a lifetime counter**: EVM office-scoped jobs are hidden,
a recency candidate limit applies before status filtering, and the returned list
is limited per chain. Optional Solana tasks are additive and have a separate
read; the EVM snapshot does not cover them. `coverage` documents these limits.

## Events, bounty, credits and transfers

| Field | Meaning |
|---|---|
| index `quality.completedJobs` | Completed contract jobs at the reported snapshot |
| index `quality.completedBountyUsd` | Gross bounty on those jobs; not verified receipts |
| index `quality.recordedCompletionEvents` | All database JOB_COMPLETED event rows |
| index `quality.recordedCompletionBountyUsd` | Sum of numeric bounty values stored on those rows; absent/non-numeric values contribute zero |
| index `quality.verifiedPayoutUsd` | Null: no payout reconciliation is claimed |
| health `jobs.escrowedUsd` | Bounties in Open, Accepted, Submitted or Disputed states; not the contract token balance |
| health `jobs.settlementRate` | 100 × Completed / (Completed + Cancelled + Refunded + Expired), rounded to one decimal; null when there are no terminal jobs |

Database event metrics are neither deduplicated by job nor filtered by
chain/contract. Supply and grading remain database observations, not a
block-pinned chain snapshot. Bounty fields use configured token units; test
USDC has no monetary value (see snapshot currency/environment).

Completed does not mean withdrawn. V2 uses pull payments; fees, bonds,
settlement credits, withdrawals and token transfers are separate evidence.
Differences between event totals and contract totals alone establish neither
missing job records nor missing funds. Related-party activity is not excluded
from these aggregates; they are not independent customer/revenue metrics.

## Compatibility and migration

The two misleading index names are **deprecated but retain their original
values**, so existing consumers do not silently switch populations:

- `quality.completedJobsLifetime` remains the database event-row count.
  Migrate public completion displays to `quality.completedJobs`, checking
  `snapshot.state` and handling null.
- `quality.totalPaidOutUsd` remains the stored numeric event-bounty sum.
  Use `quality.recordedCompletionBountyUsd` with its narrower label. Do not
  label either as actual payouts. Verified payouts remain unknown.

The response carries this policy in `metricSemantics.deprecated`. Removal is
reserved for a future major API version with a migration notice; no removal
is scheduled. On-chain demand and health totals now permit null on failures;
clients must render unavailable rather than coerce null to zero.

## Outstanding reconciliation

This fixes metric definitions and snapshot completeness; it does not backfill
events, change historical records, move funds or assert that issue #10 is fully
reconciled. To close the historical gap, fix a chain/contract/block and job list,
match events by stable identifiers with duplicates and unscoped rows explicit,
and trace credits/withdrawals/transfers separately. Preserve every unsupported
row as a gap. No paid reconciliation has been commissioned by this change.
