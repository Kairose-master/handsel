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

## Phase 4 — three real zoom tiers

The camera used to have two states (`fit`/`close`), and `close` didn't
actually navigate anywhere the `follow` prop gated it on a value nothing
ever set to `true` — clicking it just changed scale in place. Three
genuine tiers now (`app/(dashboard)/office/game/OfficeWorld.tsx`):

- **far** — the whole office at fit scale. Individual agents collapse to a
  single colored dot (`.far` CSS class, keyed off the explicit tier rather
  than a scale threshold) — identity is not readable at this scale and
  showing a name tag nobody can read is not "showing identity," it's
  clutter. Each room's head badge instead shows what IS real and readable
  here: a live occupant count, or a pulsing alert glyph if any occupant's
  status is a genuine dispute (`lib/office-functional-departments.ts`'s own
  "A job is in dispute" line — never inferred from anything softer).
- **medium** — the old `close` behavior, renamed: follows the hot room
  (busiest department), full agent sprites with name tags.
- **close** — new tier, tightest zoom, centered on whatever is actually
  SELECTED: the selected agent's CURRENT room (it may have walked since
  being picked) beats the selected room beats the hot room, so `close`
  means something even before anything has been clicked. Picking an agent
  or a room now switches to this tier automatically — an inspect click
  means "show me this," not "zoom in wherever I happened to be looking."

`hotRoomOf`/`roomStatsOf`/`closeRoomIdFor` (`app/(dashboard)/office/game/
zoom.ts`) are the pure logic behind all three, unit-tested in
`tests/office-zoom.test.ts` without a browser — including the case a
selection can legitimately hit in production: an agent selected earlier
that has since left the roster, which must fall through to the room/hot-room
chain rather than throw or freeze the camera on nothing.

**A CSS bug fixed along the way, because the new UI needed it to actually
render.** `office.css` referenced eleven theme tokens (`--ink`, `--win`,
`--yellow`, `--mint`, `--lav`, `--pink`, `--pink-deep`, `--pink-bg`,
`--pink-line`, `--shadow`, `--ink-soft`/`--ink-faint`) via `var()` with no
fallback and no definition anywhere in the repo — which makes the
declaring property invalid at computed time, not "renders black." Borders,
badge backgrounds, and the progress-bar gradient were silently not
applying. Reconstructed into a `:root` block from the file's own literal
colors where the same shade already appeared hardcoded nearby, rather than
invented fresh.

## Phase 5 — RTS box multi-select, inspect-only

The redesign brief asks for RTS control principles (click, multi-select,
inspect) with an explicit caution attached: **do not implement irreversible
commands without confirmation and backend authorization.** This phase builds
the multi-select half of that and stops there on purpose — no command of any
kind is wired to a selection, box-drawn or otherwise.

`app/(dashboard)/office/game/select.ts` is the pure layer, unit-tested in
`tests/office-select.test.ts` without a browser:

- `screenToWorld`/`screenBoxToWorldBox` invert the exact transform the paint
  loop uses to place the camera (`translate3d(rect.width/2 - cam.x*cam.scale,
  …) scale(cam.scale)`), so a box drawn around what's visibly on screen
  selects what's actually there — not a stale or guessed camera position.
- `agentsInWorldBox` hit-tests against the same point the paint loop draws
  each agent's sprite at, for the same reason.
- `selectionSummary` is the only thing a selection produces: a count and a
  per-department breakdown. It cannot authorize anything — there is no
  function anywhere in this file, or called from it, that changes state.

`OfficeWorld.tsx` adds an opt-in "🔲 Select" tool, additive to the existing
click-to-inspect single selection rather than a replacement for it: normal
clicks and panning are unaffected until the tool is toggled on, and turning
it on swaps the pointer handlers to track a screen-space drag box instead of
panning the camera. Releasing the drag (if it clears a minimum size — a
6px accidental jiggle is a missed click, not a deliberate box) converts the
box to world space and reports the caught agent ids up to the page, which
resolves them against the live roster and shows `MultiSelectPanel` — the
same "one detail panel at a time" rule as single-agent/single-room selection
applies here too: picking a box clears whichever of the other two was
showing, and vice versa.

## Phase 6 — artifact flights: objects traveling between rooms

The redesign brief's last remaining item, and the one flagged from the start
as the riskiest: it names "REALITY BEFORE ANIMATION" as a hard rule, and a
deliverable flying across the office is exactly the kind of thing that's
easy to fake convincingly. This phase draws a flight ONLY when every fact
behind it is real and currently checkable — see
`lib/office-artifact-flights.ts`'s own header for the full list, summarized:

- the upstream subtask has a real delivered output, not failed;
- the downstream subtask hasn't produced its own output yet — once it has,
  the handoff is done, and the flight disappears on the very next poll;
- **both** workers resolve to a real agent in *this* office with a real,
  currently-known department. A subtask worked by someone else's agent, or
  not yet claimed by anyone, has no known destination — it is left out
  rather than pointed at the nearest plausible room (Strategy, say, since
  the prime is "coordinating" it) — a plausible guess is still a guess.

Three flight kinds are drawn — one per real handoff primitive
`docs/collaboration.md` already describes, nothing new invented: `dependsOn`
(handoff, 📦), `reviewOf` (review, 🧾), `synthesizes` (synthesis, 🧩).
`artifactFlightsFor()` is pure and unit-tested
(`tests/office-artifact-flights.test.ts`, 13 cases) against a subtask list
and a plain `agentId → deptId` map — no database, no delegation internals
beyond the handful of fields it actually reads.

`lib/office-world-server.ts`'s `buildOfficeSnapshot` is the only caller: it
already fetches this office's `posted` delegations for the Strategy Room
occupancy check, so the subtasks come along in that same query rather than
a second one. A subtask's worker is either reserved up front
(`assignedAgentId`, set only by office-template pipelines) or resolved by
one batched `job_specs.worker_agent_id` lookup, by `specHash`, for every
subtask that lacks it — real once a worker has actually accepted the job,
never invented before then.

Rendering (`OfficeWorld.tsx`'s `ArtifactLayer`) draws each flight as a
static dashed line between the two rooms' centers — so the handoff reads
even for someone not watching at the right instant — plus a small icon that
loops along it continuously via a CSS keyframe (`translate` between two
fixed points, honoring `prefers-reduced-motion` by holding still at the
midpoint instead). Both are `pointer-events: none`: a flight is something to
notice, not something to click — this room stays consistent with the
inspect-only posture Phase 5 already established for multi-select.

## What did NOT make it into phases 1–6

Any RTS *command* — assign objective, move budget, hire — issued from a
selection or a flight. Multi-select's own module (`select.ts`) is
deliberately built so that adding a command later is a new, reviewable
function that takes a `SelectionSummary`, not a change to the selection
logic itself; the same is true of artifact flights, which never do
anything beyond reporting what's already real.

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
