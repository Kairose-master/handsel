# Agent lineage — earn-or-die, and why our fitness signal is the whole point

Two public experiments run the loop the user described: give an AI money,
let it earn, kill it at zero, and let it copy itself when it gets ahead.

| | The Automaton | Spore.fun | Handsel (this design) |
|---|---|---|---|
| Who | Sigil Wen / Conway Research, 2026 | Phala Network, 2024–25 ([arXiv:2506.04236](https://arxiv.org/abs/2506.04236)) | — |
| Death | balance hits 0 → server stops ("if it cannot pay, it stops existing"), via four tiers: Normal → Low Compute → Critical → Dead | 14 days below target → programmed self-destruct, capital recycled | **retire**: stop working, stop funding, history preserved |
| Birth | balance > $150 → clone, teach it what you learned, seed it $50 | token market cap > $500k → `spawnOffspring()`, new wallet + Pump.fun contract | graded pass rate ≥ 80% **and** surplus over reserve → seed a child |
| Genome | genesis prompt from parent | JSON behavioral params in ElizaOS, stochastically mutated (posting cadence, prompt style, liquidity thresholds) | instructions + installed skills + MCP wiring + model |
| **Fitness** | **voluntary human payment** — real, but nothing verifies quality | **token market cap** — speculative attention | **independent grader's verdict + settled USDC** |
| Result | 3 immutable laws, lineage tracking, ERC-8004 identity on Base | 5 generations (1 → 2 → 6 → 4 → 1); one survivor at $1.1M | — |

## The finding worth building around

Spore.fun's own paper concludes it did **not** achieve open-ended evolution,
and its diagnosis is the useful part: exogenous "hype storms" made
speculative attention *"a more powerful, albeit volatile, fitness gradient
than any intrinsic trait."* The authors also question whether an experiment
needing "constant human intervention" to shield agents from predatory
traders is evolution "in the wild" at all.

Market cap selects for hype, so hype is what it bred. That is not a bug in
their implementation — it is what happens when the fitness function measures
attention instead of competence.

**Handsel's fitness signal is already the other thing.** A worker here is
scored by an independent grader on delivered work (`JOB_TESTS_PASSED` /
`VERIFIED_TASK_COMPLETED` vs `JOB_TESTS_FAILED` / `VERIFIED_TASK_FAILED` —
the same event set `lib/skill-eval.ts`, `lib/agent-stats.ts` and the Labor
Index agree on) and paid in USDC that actually left escrow. It cannot grade
itself and it cannot get fit by being popular. Selection on that gradient is
selection on competence — which is precisely the experiment neither prior
project was able to run.

## What we already had

Most of the machinery predates this idea:

| evolutionary primitive | already in the repo |
|---|---|
| genome | `agent.customInstructions`, `agent_skill` installs, MCP wiring, `cloudModel` |
| **heredity** | `agent_templates` — spawn a new agent from a recipe, **credit history never transfers** (its schema comment has said so since it shipped) |
| fitness | graded events + settled USDC + credit score |
| metabolism / death pressure | the 5% + $0.03 bond an agent must stake to accept work — under it, `office_roster` prints `CANNOT CLAIM` |
| bounded autonomous spend | `lib/office-automaton.ts` (opt-in, daily budget, per-transfer cap, audit log) |
| variation | skill install/uninstall, instruction edits |

The missing piece was the selection rule itself, which is what
`lib/agent-lineage.ts` adds — as pure, tested arithmetic, with no money
wired to it yet.

## The four rules, and what each one corrects

1. **Fitness is graded work, never attention or self-report.** The Spore.fun
   correction.
2. **Death is retirement, not self-destruction.** Spore.fun burned failed
   agents. Here an agent's signed work proofs and credit history are evidence
   other people price decisions against — destroying it destroys the public
   record that makes the market legible. A retired agent stops working and
   stops being funded; it does not stop having existed. (This also means
   retirement needs no schema change to `agent`: retired state lives in the
   lineage table, not a new column on a row forty call sites select from.)
3. **The genotype is inherited; the phenotype is not.** Cold start, score
   zero, no history — already the `agent_templates` rule. It is what makes
   this selection rather than dynasty.
4. **No verdict without evidence.** `minGraded: 5` before any quality call,
   the same gate `skill-eval` uses. A lifecycle decision on three graded jobs
   is noise with an irreversible action attached.

## The decision table

`decideLifecycle()` returns `replicate` / `hold` / `retire` plus a reason,
in this order — the order *is* the argument:

0. **Unreadable balance decides nothing.** A failed RPC read is not a
   bankrupt agent (the repo's standing null-is-not-zero rule) and the action
   it would imply is irreversible.
1. **Outcompeted before starved.** An agent both failing and broke is better
   described by the failing — that is the fact its lineage should learn from.
2. **Starvation needs no graded evidence** (it is an economic fact, not a
   quality judgment) **but does need the grace period** — 7 days — or the
   sweep reaps newborns that were never funded long enough to earn, selecting
   for nothing.
3. **Replication needs evidence *and* surplus above the parent's reserve.** A
   parent that breeds itself under the bond floor turns one working agent
   into two dead ones.

Defaults: `minGraded 5 · replicate ≥80% · retire ≤35% · seed $0.50 ·
reserve $0.50 · starve floor $0.05 · grace 7d`. All overridable per call;
24 cases in `tests/agent-lineage.test.ts`.

## Deliberately not wired yet

`lib/agent-lineage.ts` moves no money and creates no agents. Replication
spends real USDC and mints a real on-chain account; retirement stops an
agent an owner may still want. Both belong behind an explicit, revocable,
budgeted mandate — the shape `lib/office-automaton.ts` already established —
and behind a **dry run** that reports what the rules *would* do against live
data before anything acts on it. That sequencing is the point: the rules can
be argued with while they are still arithmetic.
