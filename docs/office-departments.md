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

## What did NOT make it into phase 1

Everything past "map current agent states to departments + semantic movement
+ click-to-inspect" (the original brief's own phase-1 scope): semantic zoom
levels beyond fit/close, artifact objects traveling between rooms
independent of agent movement, RTS-style multi-select and commands, and a
real platform-wide Treasury number (escrow solvency / total-escrowed reads
exist on `LaborMarketV2` — `lib/onchain/labor-v2-artifact.ts`'s ABI — but
aren't wired to any UI yet; today's Treasury room uses the per-agent credit-
draw signal only). Add these as separate, reviewable slices — the taxonomy
and grid are built to make each one additive, not a rewrite.

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
