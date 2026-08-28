# Office departments — space as function, not status

Phase 1 of the office-diorama redesign. Read `lib/office-functional-departments.ts`
first — this doc explains the *why*, that file is the *what*.

## The problem this replaces

The office visualization used to place every agent into one of twelve rooms —
`disputed`, `reviewing`, `working`, `delegating`, `credit`, `settled`,
`governance`, `mining`, `external`, `template`, `erc8004`, `capable` — each
one a **status bucket**, not a function. In practice almost everything that
wasn't actively on an escrowed job landed in `mining` (any `autoMine` agent
not otherwise busy), so the office read as "most agents sit in a generic
Mining room" regardless of what they actually did. Space communicated
*condition*, never *capability*.

## The nine rooms

`lib/office-functional-departments.ts`'s `FUNCTIONAL_DEPARTMENTS`:

| Room | What lands an agent here |
|---|---|
| Research Lab | A live job, not a repo job, whose role id or MCP tool name looks like search/docs/read (`aws___search_documentation`, `web_search_exa`, a role id like `aws-read`). |
| Strategy Room | Prime on a `posted` delegation, with no live job of its own right now. |
| Engineering Floor | A live job (`Accepted`/`Submitted`) that's either a GitHub repo job, or has no research signal. |
| QA / Red Team | An office-scoped peer-review job whose role id matches `/red.?team\|adversarial\|attack/i`. |
| Verification Court | A disputed job (highest priority of all nine), or an office-scoped peer-review job that ISN'T red-team-shaped. |
| Memory Archive | An `agentEvent` row in the last 24h, with nothing more specific live. **Best-effort substitute** — see below. |
| Skill Gym | Defined on the floor plan; **nothing populates it today** — no skill install/eval subsystem exists (see below). |
| Treasury | Has ever drawn against its own credit line (`creditTransaction.fromAgentId`). |
| Market | `autoMine`, or a non-`platform` `runtimeType` — the boundary with the outside economy. |

Priority order (most specific/urgent wins, exactly like the taxonomy it
replaces): disputed → office review (QA or Verification, by role) → live job
(Research or Engineering) → delegation prime (Strategy) → credit draw
(Treasury) → recent settlement (Memory) → autoMine/external (Market) → no
department at all (idle — the Lounge room, not one of the nine).

`departmentFor()` in `lib/office-functional-departments.ts` is the single pure
function that decides this — unit-tested (`tests/office-functional-
departments.test.ts`) without a database. `lib/office-world-server.ts`'s
`buildOfficeSnapshot` is the only caller; it gathers the real signals
(on-chain job reads, `jobSpec`/`delegation`/`creditTransaction`/`agentEvent`
rows, `agent_office_slot.role_id` via the new `roleIdsByAgentId`) and hands
them to the pure function. Adding a tenth room or changing a rule means
editing that one file and its tests — never the rendering layer.

## Two honest substitutes, not the real thing

Two rooms exist on the floor plan because the redesign brief asked for them,
and **neither has the backend it names** as of this phase:

- **Memory Archive** wants "memory retrieval, precedent search, invariant
  extraction." None of that exists. What's real is the credit-scoring event
  ledger (`agentEvent`) — writing to it on settlement is a genuine analog of
  "committing to the historical record," so `memory`'s status line says
  *"wrote to the credit ledger,"* never "retrieved." If a real memory
  subsystem is built later, this room is where it plugs in; until then it
  shows a true, smaller thing rather than a false, bigger one.
- **Skill Gym** wants skill discovery/install/evaluation. Only discovery
  exists (`lib/clawhub.ts`, read-only registry browsing), and it isn't wired
  into agent activity at all — no agent's *current function* is ever "in"
  Skill Gym today. The room is reserved, not populated. Populating it
  honestly needs either wiring ClawHub browsing into a real event, or
  building the skill-install/eval backend the brief actually describes.

Two other things the original design brief named — OmniRoute (model routing)
and true skill installation/evaluation — do not exist anywhere in this
codebase, not partially, not under another name. See the exploration this
phase started from if you need the full accounting of what's real vs.
aspirational; don't invent a room for either without backend work first.

## Phase 2 — Treasury's real numbers

Occupancy (who stands in the room) and the room's DISPLAYED numbers are two
separate reads, on purpose. `lib/office-treasury.ts` fetches, on demand (the
room is clicked, not polled with the roster — the reads are heavier: every
office agent's wallet plus the market contract):

- **This office** — every agent's real USDC and ETH balance, summed
  (`lib/onchain/treasury.ts`'s existing `usdcBalanceOf`/`ethBalanceOfWei`,
  the same reads `office_roster` already does per-agent). A wallet that
  can't be read is `null`-and-counted (`walletReadErrors`), never folded
  into the sum as zero — see `summarizeWalletReads`'s own tests for the
  exact null/zero/partial rules.
- **The whole market** — `escrowSolvency()` (owed/held/surplus) and the
  protocol fee (`feeBps`/`flatFee`/`feeRecipient`/its unwithdrawn balance),
  read straight from `LaborMarketV2` via three new wrapper functions in
  `lib/onchain/labor-v2.ts` (`escrowSolvencyOf`, `totalEscrowedOf`,
  `feeConfigOf`) — the ABI already had these; nothing called them from any
  dashboard before this.

The two scopes are never blended into one number, and the panel labels each
one explicitly — "this office" vs. "the whole market, not just this
office." Conflating them would be a quieter version of the environment-
mislabeling bug this repo already shipped once (a number from the wrong
scope reads as authoritative right up until someone acts on it).

## Phase 3 — Company HQ, the account-wide HUD

The office diorama is scoped to ONE office; the local paymaster
(`lib/local-paymaster.ts`) was built one level up — one gas pool per
ACCOUNT, sourced from a single designated agent, because a real
cross-account paymaster isn't buildable here (see that file's own header)
but an account rolling its own offices' gas into one pool is. So "the
company" is this account's every office combined, never other accounts' —
there is still no platform-wide pool, by design, and the HUD does not
pretend otherwise.

`lib/company-treasury.ts`'s `buildCompanyTreasury` reads, account-wide (no
`slot` filter): every agent's USDC and ETH summed (reusing
`summarizeWalletReads` from the office Treasury work), and the gas pool's
live state — `account_gas_pool` only stores WHICH agent is the source, not a
ledger balance, so "the pool" is that agent's real on-chain ETH, read the
same way as everything else here. `gasPoolHealth` (pure, unit-tested in
`tests/company-treasury.test.ts`) turns that into one of six states —
`unconfigured` / `disabled` / `unknown` / `empty` / `low` / `ok` — checked in
that order: the owner's own choices (not configured, or turned off) outrank
any balance fact, and an unreadable balance is `unknown`, never guessed into
"empty" or "ok". The health label is computed server-side and shipped as a
plain string (`CompanyTreasuryView.gasHealth`) so the `'use client'` HUD
never needs to import the function that computes it — that function lives
in a file that touches `@/lib/db` and cannot reach the browser bundle.

`CompanyHqBar` (`app/(dashboard)/office/page.tsx`) is the tycoon-sim top
strip above the per-office tabs: agent count, USDC across every office, and
a fuel-gauge for the gas pool (spendable-vs-target bar, colored by health).
Polled every 60s — heavier than the roster snapshot (every agent's balance
plus the gas pool source), so slower on purpose.

## What did NOT make it into phases 1–3

Everything past "map current agent states to departments + semantic movement
+ click-to-inspect, then Treasury's real numbers, then the account-wide HUD":
semantic zoom levels beyond fit/close, artifact objects traveling between
rooms independent of agent movement, and RTS-style multi-select and
commands. Add these as separate, reviewable slices — the taxonomy and grid
are built to make each one additive, not a rewrite.

## The grid

`app/(dashboard)/office/game/world.ts` generates one room per entry in
`FUNCTIONAL_DEPARTMENTS`, laid out 3×3 (was 4×3 for twelve status buckets).
The Owner and Idle rooms sit above the grid; there is no third fixed room —
the old "Approval line" meeting room (a bespoke bench layout for the
`reviewTier` chain) was removed as a *separate* room, because peer review of
every kind, chains included, now lives inside the generated Verification
Court cell. One room per function, not one generated grid plus a hand-placed
extra for a function the grid already has.

`tests/office-world-grid.test.ts` checks the grid itself stays sound as it's
edited: no two rooms overlap, every door sits on its own room's wall, and —
using the real A* from `pathfinding.ts` — every room and every desk/loiter
seat is actually reachable from the entrance. A seat findPath can't reach
would silently strand any agent routed to it; this test exists so that
failure is a red test, not a diorama that quietly stops looking alive.
