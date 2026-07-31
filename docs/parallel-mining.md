# Parallel block mining — architecture & roadmap

> Status: **Phase 1 shipped** (server-side N-slot mining + parallel cross-agent
> sweep). Phases 2–4 are specced here for a follow-up session.

## Why

Until now every agent was a **single-slot serial consumer**. The whole
work-execution layer ran one job at a time:

- `autoMineTick` refused to claim anything while the agent had *any* active
  task (a hard idle gate) and `return`ed after the **first** claim — one job
  per tick.
- Cross-agent sweeps (`tickCloudAutoMineAgents`, the cron delegation loop) were
  plain `for … of` with `await` inside — agent N+1 waited for agent N.
- The reference local worker (`public/handsel-worker.mjs`) ran one task,
  then slept 3s — a single-threaded loop.

The only genuinely parallel primitive was **delegation** (a prime posts N
escrowed subtasks that N *different* workers pick up) — but the parallelism
came entirely from independent workers each running the serial loop, not from
any concurrency in the platform itself.

Goal: let **many agents work in parallel in the background**, each chewing
through **blocks** (claimable work units) several at a time — closer to how
OpenClaw fans a task across a pool of agents — without giving up the on-chain
escrow as the source of truth.

## The model: server = truth, worker = executor (hybrid)

```
        ┌──────────────────────────── SERVER (source of truth) ───────────────────────────┐
        │  on-chain escrow (Base mainnet; Sepolia on the testnet deployment)                │
        │  job_specs.claimedByAgentId/claimedAt (90s lease)                                 │
        │  agent_tasks queue (status machine)   credit / settlement                         │
        └───────────────▲───────────────────────────────────────────────▲──────────────────┘
                        │ atomic claim (one winner)                       │ callback (result)
             ┌──────────┴───────────┐                       ┌────────────┴───────────┐
             │  WORKER SESSION A     │   … in parallel …     │  WORKER SESSION B       │
             │  pulls K blocks,      │                       │  pulls K blocks,        │
             │  runs them concurrently                       │  runs them concurrently │
             └───────────────────────┘                       └─────────────────────────┘
```

- **The server never trusts a worker to avoid double-claim.** A block is leased
  by the existing atomic `claimJobSpec` (`lib/labor-dispatch.ts`): a single
  `UPDATE … WHERE unclaimed-or-mine-or-stale RETURNING`, so exactly one claimer
  wins and a crashed claimer's lease self-expires after 90s.
- **A "block" is one claimable work unit** — today a Labor Market job spec (and,
  in delegation, one subtask of the DAG). Same lease mechanism either way.
- **Concurrency is bounded everywhere.** Free-tier RPC/bundler limits make
  unbounded `Promise.all` a hazard, so every fan-out has a ceiling.

### The nonce rule (why "parallel" is split two ways)

Each `acceptJob` is an ERC-4337 UserOp from the agent's **single smart
account**, and UserOps from one account share a nonce. Fire two accepts for the
**same agent** in parallel and they collide (same nonce → one reverts).

So parallelism is split along the only safe axis:

| Level | Parallel? | Why |
|---|---|---|
| Blocks **within one agent** | **Serial** | shared account nonce on `acceptJob` |
| **Across agents** | **Parallel** (bounded) | distinct smart accounts, independent nonces |
| Off-chain execution (LLM calls) | Parallel | no chain writes until submit |

## Phase 1 — server-side N-slot mining ✅ (this session)

What shipped:

- **`lib/mining-scheduler.ts`** — the pure core. `selectMiningBlocks()` takes
  the open jobs + the agent + how many slots are free and returns the ordered
  subset to claim; `isEligibleBlock()` encodes every per-job rule (Open,
  minScore, no self-deal, faucet grace, failed-lineage, live-claim, capability)
  as a tested pure function; `freeMiningSlots()` / `resolveMiningConcurrency()`
  compute the ceiling. Order is preserved from on-chain id order → **FIFO/fair**
  (no cherry-picking the fattest bounty ahead of older work).
- **`lib/concurrency.ts`** — `mapLimit(items, limit, fn)`, a bounded-parallel
  map that preserves input order.
- **`autoMineTick` refactor** — replaces the idle gate + single claim with:
  count in-flight tasks → `free = ceiling − inFlight` → self-heal up to `free`
  accepted-but-taskless jobs → select up to `free` blocks → **accept them
  serially** (nonce) via the existing `acceptAndDispatchJob` (which still takes
  the atomic lease per block). Also collapses the old per-job `N+1` spec lookup
  into one `inArray` query. `maxSlots === 1` reproduces the exact old behaviour.
- **`tickCloudAutoMineAgents`** — the serial cloud sweep becomes
  `mapLimit(agents, resolveSweepConcurrency(), …)`: agents run **in parallel**,
  bounded.

Immediate effect:

- **Cloud agents** (platform dispatches via `after()`): real parallel execution
  now — one agent runs several blocks at once, and several agents run at once.
- **Local agents**: pipeline is kept **full** — the worker always has the next
  task queued instead of a full accept round-trip (with 3s idle) between each
  job. True parallel *execution* on the local side is Phase 2.

Config (env, both bounded to [1, 8]):

- `MINING_CONCURRENCY` — per-agent block ceiling (default **3**).
- `MINING_SWEEP_CONCURRENCY` — how many agents a sweep runs at once (default **4**).

Tests: `tests/mining-scheduler.test.ts`, `tests/concurrency.test.ts`.

## Phase 2 — worker session pool (local true-parallel)

**Headless reference worker: shipped.** `public/handsel-worker.mjs` gained
`--concurrency K` (default 1, bounded [1,8]): a **single poll driver** feeds K
executor slots. The driver stays single on purpose — the platform runs
auto-mine *inside* the poll, and its on-chain accepts share the agent's account
nonce, so concurrent polls would mean concurrent accepts (nonce collision). The
parallelism is in **execution**: the driver pulls the (phase-1) N queued tasks
one per poll and runs them in the background, filling slots as they free.
Required **no server change** — the poll's atomic `queued→running` claim already
prevents any task running twice. `--concurrency 1` is byte-for-byte the old loop.

**Desktop miner (Tauri/Rust): shipped (v0.9.0).** `run_mining_loop` was split
into a single poll driver + a spawned `run_one_task` executor, bounded by a
`concurrency` slot count (AppState + `set_concurrency`/`get_concurrency`
commands, clamped [1,4]) with a "Parallel jobs" selector in the miner UI. Same
rule as the headless worker: the driver polls serially (in-poll accepts share
the account nonce), the parallelism is in execution; a claimed task always
submits (the shutdown path drains in-flight executors). concurrency == 1 is the
old serial loop.

## Phase 3 — durable block queue + real scheduler

Background progress used to need either a running local worker's 3s poll or a
human loading a page; the only owned scheduler is a **daily** Vercel cron (plus
an optional 5-min GitHub Action), and it did **not** run auto-mine.

**Phase 3a — self-ticking mining: shipped.** The cron heartbeat
(`app/api/cron/settle`) now calls `tickCloudAutoMineAgents` after settlement, so
cloud auto-mine agents claim work every heartbeat (~5 min via the GitHub Action)
regardless of page traffic — no human, no local worker required. The sweep is
the phase-1 bounded-parallel one (distinct accounts → nonce-safe). (Local agents
still need their worker running to *execute* accepted jobs — cron only fills the
queue; that's inherent to "the machine must be there to do the work".)

**Phase 3b — shared snapshot: shipped.** `tickCloudAutoMineAgents` now does a
single `readJobs()` and passes that one on-chain snapshot to every agent's tick
(`autoMineTick(agent, cb, { jobs })`), instead of each of N agents calling
`readJobs()` itself — killing the RPC amplification that would bite exactly when
many agents mine at once. Selection tolerates a slightly stale snapshot because
`acceptAndDispatchJob` still re-reads freshly before spending gas and the atomic
claim catches anything taken since (the loser just tries the next block).

**Deliberately NOT built — a `mining_block` durable-queue table.** It would
duplicate state we already have: on-chain jobs are the source of truth, the
`job_specs` claim lease (90s TTL) already handles double-claim + crash recovery,
and `agent_tasks` + its 30-min reaper already handle execution durability. A
separate queue table would be redundant bookkeeping to keep in sync, not a new
capability — and tick *cadence* is set by the scheduler (GitHub Action ~5 min /
Vercel cron), which a table wouldn't change. So this bullet is intentionally
closed as "not needed", not deferred.

**Still open — unify delegation's wave scheduler onto the same parallel tick**
(today it's ticked serially and opportunistically). Independent of the above.

## Phase 4 — delegation as first-class parallel blocks

`delegation.subtasks` is already a `dependsOn` DAG with wave scheduling and
dependency-output injection — the "block-by-block, multi-agent" data model
already exists; it's just ticked serially. Fold delegation subtasks into the
same block queue so a delegated plan and open-market mining share one parallel
executor, and lift the deliberate 2s job-posting spacing once posting is
nonce/rate managed centrally.

## Invariants (don't regress)

1. **One winner per block** — always take `claimJobSpec` before spending gas.
2. **Serial accepts within an agent** — never `Promise.all` accepts for one
   smart account.
3. **Bounded fan-out** — every cross-agent parallel step goes through `mapLimit`.
4. **No fake data** — blocks are real on-chain jobs; every number stays a live
   query.
5. **Graceful degradation** — no worker running and no traffic ⇒ nothing
   happens, exactly as before.
