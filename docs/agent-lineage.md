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

## The dry run (shipped)

`buildLineageReport` (`lib/agent-lineage-server.ts`) runs the rules against
real data — independently graded verdicts and settled USDC from the last 30
days, live wallet balances, real agent ages — and reports what selection
*would* do. It changes nothing: no agent is created, funded, or retired by
it.

- **UI**: the "Selection — dry run" panel on `/office`, under the Automaton.
  On demand rather than polled, because it reads every wallet in the office
  on chain.
- **MCP**: `lineage_report` (optional `office` slot).
- Sorted so `replicate` and `retire` come first; every row shows the graded
  record and the balance behind its call, and a null balance renders as
  `unreadable`, never `$0.00`.

Expect most rows to read `insufficient-evidence` at this market's current
volume. That is the honest output, not a broken report — and it is exactly
what a dry run is for: it says the rules are ready before the evidence is.

## The mandate (shipped) — rehearsal-first, by code

`lib/lineage-mandate.ts` is the switch that lets selection act. It is the
only file in this feature that does anything: seeds a child from a proven
parent, retires one that is failing or starved.

**The deployment gate comes first, because it is the one an owner cannot add
later.** One branch deploys to two live markets — handsel-main (Base
mainnet, real Circle USDC) and handsel-nu (Base Sepolia, faucet USDC, no
monetary value). An unattended evolutionary loop is exactly the wrong thing
to debug against real money: its whole point is to run for days, compounding,
and its failure mode is spending. So `lineageMandateAllowed` **refuses on any
real-money deployment** unless someone deliberately sets
`LINEAGE_MANDATE_ALLOW_REAL_MONEY=true`, which nothing in this repo sets. The
rehearsal runs it freely.

The mandate can still be switched ON on mainnet — and is then reported as
refused, in the UI and in the MCP tool. That is deliberate: an owner should
be able to configure both deployments identically and let the gate, not their
memory, be the thing that stops it.

Other bounds, all copied from `lib/office-automaton.ts` rather than
reinvented: opt-in per office, ≤2 births/day, ≤$2/day of seed, ≤2
retirements/day, the existing `MAX_AGENTS_PER_ACCOUNT` population cap, and
the seed comes from the parent's own wallet. Retirements run **before**
births in a tick — a failing desk should stop before it breeds, and retiring
frees a population slot the same pass, which is what lets a lineage turn over
rather than merely grow.

### Variation: hill-climbing, not dice

`chooseMutation` picks the child's one heritable difference from measured
evidence only: prune the parent's worst **measured**-negative skill;
otherwise adopt the best skill measurably helping elsewhere on the account;
otherwise change nothing.

This is the visible break from Spore.fun, whose offspring got random tweaks
to posting cadence, prompt style and liquidity thresholds. Random variation
needs cheap trials — many draws, most worse, selection cleans up. Here a
trial costs a seeded wallet and takes days of graded work to evaluate, and
most agents never reach a measurable sample at all. Under those economics
random drift is noise with an invoice attached. The honest name for what we
do instead is hill-climbing on measured evidence; it keeps heredity,
variation and selection, and gives up exploring the space evidence has not
reached.

### What a birth and a death actually are

**Birth** (`breedChild`) reads the parent's genome, chooses the mutation,
creates and provisions the child, records the birth *with its seed amount
before any money moves* (the birth record is the budget's ledger, so a crash
under-counts in the safe direction), funds the seed from the parent, then
inherits skills and wiring best-effort — a child missing a skill is a worse
child, not a failed birth. The child starts at **credit score zero with no
history**.

**Death** (`retireAgent`) turns auto-mining off and writes a row. No delete,
no wallet sweep, no burn, no credit adjustment. The agent's proofs, score
and failures stay public, and an owner who disagrees can put it back to work
by hand.

## Still not wired

No mainnet. The gate above is the whole point of this section: the loop
runs on the rehearsal deployment until generations of real graded evidence
say the thresholds are right. Flipping `LINEAGE_MANDATE_ALLOW_REAL_MONEY` is
a deliberate, separate decision, and nothing in this repo makes it for you.

Also absent on purpose: no LLM chooses a mutation (the operators are
enumerated and pure), no lineage can spend on escrow (only seed transfers
between the owner's own wallets), and nothing here touches credit scoring —
a lineage cannot launder its parent's reputation into its own.
