# Funding channels — batching escrow opens (shipped) and a deposit channel (designed, not built)

*2026-09-27.* Every job on `LaborMarketV2` is its own escrow: `postJob` pulls
`bounty + fee` from the requester's smart account and one ERC-4337 UserOp
carries `approve` + `postJob`. At the bounties this market actually clears
(`market_price`: text median $1.14 across 46 trades) the UserOp overhead is
the largest line in a job's cost — `docs/v2-plan.md` already says so, and the
Sep-2026 x402 settlement measurements (ethresear.ch, "Atomic ZK-Proof-Gated
Settlement for x402") found the same thing from the other side: the escrow
*open* dominates, verification does not, and batching opens saved ≈84%.

## Increment 1 — shipped: one UserOp per payer per wave

`postJobsV2Batch` (`lib/onchain/labor-v2.ts`) posts N jobs from one requester
in ONE UserOp: a single `approve` for the sum of every `postCost`, then N
`postJob` calls. `postDelegationJobs` groups the root wave by payer
(`lib/funding-plan.ts`) and posts one batch per payer; `tickDelegation`'s
later waves still post per job (they are usually one). Nothing changes
on-chain: same contract, same per-job escrow, same ids (resolved by
`specHash` as before). A batch that fails reverts whole, which beats N−1
posted and one stranded.

| Wave | Before | After |
| --- | --- | --- |
| 5-step desk, one payer | 5 UserOps, 5 approvals | 1 UserOp, 1 approval |
| 9-step securities floor, one payer | 9 / 9 | 1 / 1 |
| 3 steps across 2 payers | 3 / 3 | 2 / 2 |

The free-tier bundler rate-limits back-to-back UserOps (the 2 s spacing in
`postOneSubtask`), so the wall-clock saving on a confirm is larger than the
gas saving.

## Increment 2 — designed: a requester deposit channel

Increment 1 removes the per-job *UserOp*; the per-job *`transferFrom`* and
escrow write remain. A deposit channel removes those too:

```
RequesterDeposit (new contract, or LaborMarketV3)
  deposit(uint256 amount)                     // one transferFrom, many jobs
  postFromDeposit(bounty, minScore, specHash, window)
                                              // debits the requester's balance,
                                              // no token transfer; job state as today
  withdrawDeposit(uint256 amount)             // only what is not escrowed
  balances(address) → (deposited, escrowed)
```

Settlement is unchanged: `approveJob` credits `withdrawable[worker]` from the
escrowed amount as it does now. What changes is that a desk that posts fifty
jobs a day makes ONE deposit and fifty balance debits instead of fifty
`transferFrom`s.

Why it is a design and not a diff: it is a mainnet contract change on a
market that has moved real USDC since 2026-07-30 and whose bytes are
verified against the rehearsal deployment. The order is the one
`docs/v2-plan.md` set: V2 rehearsal first, byte-verify, then mainnet. Gate
it on a measurement: Increment 1 in production for two weeks, then compare
gas per job on batched waves against the per-job baseline; build Increment 2
only if the remaining per-job cost is still a top-three line.

Interaction with the spend envelope (`lib/spend-envelope.ts`): a deposit is
one large transfer and grades as one — set the requester's envelope with the
deposit size in mind, not the job size.
