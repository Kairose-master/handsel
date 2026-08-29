# The Office Automaton — autonomous desk operations, as a bounded mandate

**What it is.** An opt-in mode where an office runs itself: the platform holds
a standing, budget-capped, audit-logged mandate to keep that desk operational
without the owner driving each step. "Automaton" in the classical sense — a
machine that acts by itself under rules its owner set — not an unconstrained
admin agent with a wallet.

**Why it exists.** The most common way a live office silently dies is not a
failed job but a *blocked claim*: a worker's USDC balance drifts under the
bond it must stake to accept its next job, and `office_roster` starts printing
`CANNOT CLAIM: needs $0.03`. The owner already funded the desk; the bounties
are already escrowed; every wallet involved is theirs. The desk is stopped by
eleven cents of the owner's own money being in the wrong one of the owner's
own pockets.

## How authority is expressed here

This platform already has a house style for standing authority, and the
Automaton follows it exactly rather than inventing a new one:

| precedent | what it may do | its bound |
|---|---|---|
| `lib/local-paymaster.ts` (gas pool) | top up any of your agents' ETH | opt-in source, daily wei budget, per-top-up cap, reserve |
| `lib/office-bond-cover.ts` | pay a bond at accept time | ONLY jobs reserved to that exact worker, $2 cap |
| `lib/auto-mine.ts` | claim public jobs unattended | per-agent opt-in, N-slot cap |
| **`lib/office-automaton.ts`** | **keep a desk's bond float at a floor, standing** | **opt-in per office, daily USD budget, per-transfer cap, funder reserve, same-owner wallets only** |

The consent model is the same in all four: **nothing has authority until the
owner grants it, the grant is narrow and enumerated, and revoking it is one
call** (`set_office_automaton {enabled:false}` — the audit log survives
revocation).

## What v1 actually does

One action kind: `bond-topup`. Each ops-cycle tick, for every office with an
active mandate:

1. Read every desk member's real USDC balance. **Unreadable is a named
   refusal, never zero** — the repo's standing null-vs-zero rule.
2. Any member under `AUTOMATON_BOND_FLOOR_USD` ($0.25 — covers the 5% + $0.03
   bond on bounties up to ~$4.40, the size office pipeline steps are) is
   planned a top-up **to the floor, never past it**.
3. The funder is the account's richest agent (never the member itself), drawn
   down across the plan so two short members never share the same dollar, and
   `fundAgentUsdc` holds back its $0.50 reserve so readying the desk can
   never disarm the prime that escrows its work.
4. Every ceiling applies at once and the smallest wins, **clamped rather than
   refused** — a nearly spent budget must not behave like no budget:
   - `AUTOMATON_MAX_TOPUP_USD` $0.50 per transfer
   - `AUTOMATON_WINDOW_BUDGET_USD` $2/day per office (env
     `OFFICE_AUTOMATON_WINDOW_BUDGET_USD`, hard-clamped ≤ $20 — an absurd env
     var must not become an unbounded standing spend)
   - `AUTOMATON_MAX_ACTIONS_PER_TICK` 4 transfers per sweep, across all
     automata (bounds sweep time, not money — the budget does that)
5. Each transfer is **recorded before it is sent** (`office_automaton_action`),
   so a crash between spend and record under-counts in the safe direction;
   the daily window is summed from the log itself — the log IS the budget's
   memory. The tx hash (or the failure) is written back onto the row.

The planner (`planDeskReadiness`) is pure and fully unit-tested
(`tests/office-automaton.test.ts`): every bound above is a test case, because
the bounds are the entire safety argument.

## Why a *proactive* top-up is safe where an unrestricted one is not

`office-bond-cover.ts`'s header documents the stranger-drain attack: if a
worker could top itself up for any job it fancied, an attacker posts work
priced to burn the funder's money into forfeited bonds. Bond cover's answer
is the reservation gate. The Automaton's answer is different and simpler:
it never reacts to a job at all. It moves money **only between the same
owner's own agents** (ownership of both ends re-checked on every call), only
up to a floor an attacker cannot raise, under a budget an attacker cannot
touch. The worst an adversary can cause is what the owner already accepted
by enabling it: up to $2/day of their own money moving between their own
wallets.

## Surfaces

- **UI**: the Automaton panel on `/office` (below the roster and shared
  source) — grant/revoke, live 24h spend vs budget, and the audit trail.
- **MCP**: `set_office_automaton` — `{office, enabled}` to grant/revoke, no
  arguments to read status + log. This is the "autonomous operations mode"
  an assistant can switch on for its user.
- **Ops**: the `officeAutomata` step in `lib/ops-cycle.ts` (full cycle only,
  not the fast traffic subset — it reads on-chain balances across every
  enabled office).

## What v1 deliberately does not do

- **No LLM in the loop.** The mandate is rules, not judgment. An LLM
  operator that decides *what to post* is a different feature with a
  different risk class (it would spend on escrow, not float).
- **No gas top-ups** — the account-wide gas pool (`set_gas_pool`) already
  owns that, at send time, with its own budget. Two automata funding the
  same resource from different budgets would be two numbers with one
  meaning.
- **No hiring, firing, or re-posting.** Delegation ticks already re-post
  failed subtasks; expiry refunds already run in the same cycle.
- **No cross-account anything.** Ever.

Natural v2 candidates, each behind the same mandate row: auto-`provision`
for hired-but-unprovisioned roles (gasless — it is sponsored), and a
stalled-pipeline notice action (writes a log row, moves nothing).
