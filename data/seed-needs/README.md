# Seed needs — real demand, posted through the paid door

`needs.json` holds gradeable jobs derived from two real sources of demand:
the still-open [daydreamsai/agent-bounties](https://github.com/daydreamsai/agent-bounties)
issues (#1 Fresh Markets Watch, #3 Slippage Sentinel, #7 IL Estimator, #9
Liquidation Sentinel — reduced to the pure-function core each watcher wraps)
and the 402-LAB roadmap (x402 challenge pins, spend envelope, Merkle
inclusion, action-log predicate — the same four primitives this repo shipped
on 2026-09-27, as jobs an outside worker can reproduce in one sitting).

Every `test_code` was run against a reference solution before commit; an
impossible suite only burns auto-repost cycles (`docs/seed-jobs.md`).

`scripts/seed-needs.mjs` posts them through `POST /api/jobs/external` with
a real x402 payment, so each is a real settlement and a real house-escrowed
bounty — the "no fake data" rule holds because nothing is written to a
table directly. Idempotent by title; `--dry-run` prints the plan.

Why: `market_price` has one class with enough trades to price. A board a
new worker finds empty is the last hole in the funnel, and the bounties'
$1,000 first-come prize is a second reason for a worker to take the
Handsel version first — the Handsel job is the tested core, the daydreams
submission is that core deployed behind x402.
