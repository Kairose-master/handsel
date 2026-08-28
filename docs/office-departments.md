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
| Skill Gym | A ClawHub skill installed on this agent in the last 24h (`lib/agent-skills.ts`) — a real owner action that changes what the agent is told on every subsequent job. Populated for real since Phase 11; **evaluation still doesn't exist** (see below). |
| Treasury | Has ever drawn against its own credit line (`creditTransaction.fromAgentId`). |
| Market | `autoMine`, or a non-`platform` `runtimeType` — the boundary with the outside economy. |

Priority order (most specific/urgent wins, exactly like the taxonomy it
replaces): disputed → office review (QA or Verification, by role) → live job
(Research or Engineering) → delegation prime (Strategy) → credit draw
(Treasury) → recent skill install (Skill Gym) → recent settlement (Memory) →
autoMine/external (Market) → no department at all (idle — the Lounge room,
not one of the nine).

`departmentFor()` in `lib/office-functional-departments.ts` is the single pure
function that decides this — unit-tested (`tests/office-functional-
departments.test.ts`) without a database. `lib/office-world-server.ts`'s
`buildOfficeSnapshot` is the only caller; it gathers the real signals
(on-chain job reads, `jobSpec`/`delegation`/`creditTransaction`/`agentEvent`
rows, `agent_office_slot.role_id` via the new `roleIdsByAgentId`) and hands
them to the pure function. Adding a tenth room or changing a rule means
editing that one file and its tests — never the rendering layer.

## One honest substitute, and one room that graduated

Two rooms shipped in Phase 1 with less backend than their names claimed,
each labeled as such. One is still a substitute; the other became real:

- **Memory Archive** wants "memory retrieval, precedent search, invariant
  extraction." None of that exists. What's real is the credit-scoring event
  ledger (`agentEvent`) — writing to it on settlement is a genuine analog of
  "committing to the historical record," so `memory`'s status line says
  *"wrote to the credit ledger,"* never "retrieved." If a real memory
  subsystem is built later, this room is where it plugs in; until then it
  shows a true, smaller thing rather than a false, bigger one.
- **Skill Gym** shipped as "reserved, not populated" — discovery existed
  (`lib/clawhub.ts`, read-only) and nothing else. Since Phase 11 (below),
  skill INSTALLATION is real: an owner installs a ClawHub skill's actual
  document onto their agent, that document joins the agent's every job
  brief, and the install event is what places the agent in this room.
  Skill **evaluation** (did the install measurably improve outcomes?) still
  does not exist, and nothing in the room's copy claims it does.

OmniRoute (model routing), named in the original design brief, still does
not exist anywhere in this codebase, not partially, not under another name —
don't invent a room for it without backend work first.

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

## Phase 7 — a real R3F renderer, opt-in

`app/(dashboard)/office/game3d/` is a second, semi-3D renderer for the exact
same diorama — React Three Fiber / Three.js instead of DOM+CSS, an
isometric orthographic camera instead of a `translate3d`/`scale` transform,
procedural box geometry instead of sprite CSS. Nothing about the DATA layer
changed to build it: `game/world.ts` (room/grid/prop layout),
`game/live-engine.ts` (`LiveOffice`, the real-snapshot-driven tick/pathing
loop), `game/zoom.ts` (`hotRoomOf`/`roomStatsOf`/`closeRoomIdFor`),
`game/select.ts` (`MIN_SELECT_BOX_PX`, `selectionSummary`), and
`lib/office-artifact-flights.ts` are all reused UNCHANGED — this phase is
purely a second presentation layer over data that was already real.

- `CameraRig.tsx` drives the camera BY HAND (`camera.position`/`lookAt`/
  `zoom` set directly every frame from one lerped look-at point) rather
  than through Drei's OrbitControls/MapControls. An earlier version used
  MapControls for free user panning; its internal spherical-coordinate
  reconstruction fought a per-frame externally-driven target and collapsed
  the camera toward the origin after a few dozen frames — reproducible,
  not worth chasing into a third-party controls library's internals for a
  diorama that never needs free rotation or dollying anyway. The manual
  version is the DOM renderer's own `camRef`/`targetRef` lerp, applied to a
  real transform instead of a CSS one — provably correct because it's the
  same technique already shipping. The trade: no free click-and-drag
  panning yet (the three zoom tiers plus click-to-focus cover real
  navigation without it) — a real gap, not a hidden one.
- `RoomMeshes.tsx` builds each room from a floor plane and a wall ring with
  real gaps at its real door tiles (one box per non-door boundary tile —
  simple, and cheap enough at nine rooms not to need instancing yet), and a
  Drei `<Html>` label reusing `roomStatsOf`'s exact count/alert badge — one
  source of truth for what a room's badge says, two renderers drawing it.
- `AgentAvatars.tsx` builds each agent from box primitives colored with its
  real hire-time palette (`colorsFor`, shared with the DOM renderer). A
  mesh's position/rotation is written directly inside its own `useFrame`
  from the closed-over `Agent` object — never React state — because
  `LiveOffice.tick()` (still running in `page.tsx`'s own
  `requestAnimationFrame` loop, completely unchanged) mutates that exact
  object in place every frame; the DOM renderer skipped React for its own
  60fps path for the identical reason.
- `ArtifactFlights3D.tsx` draws `lib/office-artifact-flights.ts`'s flights
  as a dashed line plus a looping icon between two room centers — same
  two-part treatment as the DOM renderer's `.artifact-line`/`.artifact-dot`.
- Box multi-select still works, via a different mechanism than the DOM
  renderer's coordinate inversion: `Vector3.project(camera)` turns each
  agent's live world position into normalized device coordinates, which a
  `SelectionBridge` component (living inside `<Canvas>`, where the real
  camera object exists) exposes to the outer drag-handling code as a plain
  hit-test function.
- **A real Drei gotcha, found building this**: `<Html distanceFactor={N}>`
  scales completely differently for an orthographic camera than a
  perspective one — `objectScale()` returns `camera.zoom` directly for
  orthographic cameras (not a distance-based fraction), so a
  perspective-camera-shaped `distanceFactor` value multiplied by a zoom in
  the 6–40 range blew every label up to `zoom * distanceFactor`× its real
  size — the actual first broken render was a screen full of single
  enormous letters, one room label rendered a thousand pixels wide. Fixed
  by dropping `distanceFactor` entirely: without it Html renders at a
  constant on-screen size regardless of camera zoom, which reads better for
  small text labels anyway than having them shrink into illegibility at
  `far` zoom.

**Opt-in, not a replacement.** `office/page.tsx` renders either engine
behind a "🧊 3D view" / "🖼️ Classic view" toggle (default: classic), both
fed the identical `agents`/`selection`/`flights` props and both reporting
picks through the identical callbacks — swapping engines is one ternary at
the call site. The DOM renderer has six phases and a full pure-function test
suite behind it, verified against a real account in earlier sessions; the
3D renderer's rendering layer (as opposed to the data layer underneath it,
which is the same code) has only been visually verified against mock data
in a throwaway harness (this sandbox has no DB, so there was no way to
watch it against a real account's actual roster before shipping). Real
account traffic is deliberately its first real-data test — the toggle
exists so that's a choice a user makes, not a risk shipped silently as
"the" renderer.

## What did NOT make it into phases 1–7 (checkpoint — see Phase 9/10 below for what moved since)

Any RTS *command* — assign objective, move budget, hire — issued from a
selection or a flight. Multi-select's own module (`select.ts`) is
deliberately built so that adding a command later is a new, reviewable
function that takes a `SelectionSummary`, not a change to the selection
logic itself; the same is true of artifact flights, which never do
anything beyond reporting what's already real. Free click-and-drag panning
in the 3D view (see Phase 7) is the other known gap.

## Phase 8 — the 3D view's own visual language: tactical telemetry

The 3D view's Phase 7 launch reused the DOM renderer's pastel diorama
colors (pink/mint/lavender) for its rooms and labels — a reasonable
starting point, but a mismatch once a real reference direction landed:
"dark, neon-glow, sci-fi command center," closer to a tactical HUD than a
miniature toy office. `game3d/theme.ts` is the resulting palette, kept
`game3d/`-only — the DOM renderer's tokens (`office.css`'s pastel `:root`
block) are untouched, so the "🖼️ Classic view" toggle still looks exactly
as it always has.

The palette follows one real discipline, not just "make it dark": **one
accent does the structural work, a second is reserved for one meaning.**
Cyan is every normal room, wall glow, line, and label. Red is reserved
for a real dispute (`roomStatsOf`'s own `alert`, the same signal the DOM
renderer's far-zoom badge already used) — never for "this room is merely
busy." An earlier pass conflated the two (the *hot* room, i.e. busiest,
briefly rendered in the same red as a dispute), which is exactly the kind
of ambiguity the tactical-command aesthetic depends on not having: red has
to mean "look here, something is wrong," or it means nothing the next time
it appears. The hot room now glows amber instead — active, not alarming —
and only an actual `alert` turns a room's walls red.

What actually changed:

- **Materials**: room floors are a small canvas-generated "blueprint grid"
  texture (`gridTexture.ts`, cached per base/line color pair, no imported
  asset) instead of a flat pastel fill; walls are dark boxes with an
  `emissive` tint (cyan / amber-if-hot / red-if-disputed) so they read as
  lit panels rather than solid color; doors are a bright cyan strip.
- **Bloom**: `@react-three/postprocessing`'s `<Bloom>` picks up every
  `emissive`/`toneMapped={false}` surface — wall glow, door strips, the
  selection ring, artifact-flight lines and icons, an agent's own
  hire-time shirt color — and gives the scene the soft glow the reference
  has. Nothing is emissive "for the glow alone"; every glowing surface was
  already carrying a real signal (a wall's alert state, a selection, a
  flight in progress).
- **Two new HUD bars** (`HUDBars.tsx`), framing the scene top and bottom,
  styled per the `industrial-brutalist-ui` skill's "tactical telemetry"
  mode (monospace, uppercase, sharp corners, bracketed labels) — chosen
  over its "Swiss industrial print" mode, which is a light-background
  aesthetic and would have fought the dark scene. Top bar: a live clock
  (genuinely real — the viewer's own clock, ticking) and an
  "OPERATIONAL"/"LINK DEGRADED" status dot wired to a REAL signal — a new
  `healthy` prop, set from whether `office/page.tsx`'s own snapshot poll
  (the same one that already existed) most recently succeeded or threw.
  Bottom bar: agent count, a chip per department with a live occupant count
  (`roomStatsOf` again — third caller of the same pure function, one
  source of truth), how many artifact flights are currently in the air,
  and how many rooms are currently alerting. **No CPU/memory/task-velocity
  gauges** — the reference image's "SYSTEM METRICS" row has no Handsel
  equivalent, and inventing one (even a plausible-looking sparkline) is
  exactly the "no fake data, ever" rule this project has enforced from its
  first line. The row simply doesn't exist here; every slot that DOES
  exist is a number `roomStatsOf`/`agents.length`/`flights.length`/the poll
  boolean already produce.
- HUD buttons and hint text restyled to match (`[ FAR ]`, `[ ROOMS ]`,
  `[ CLOSE ]`, `[ SELECT ]`) — scoped to `.world3d-viewport` so the DOM
  renderer's own buttons are untouched.

Not attempted: literal photorealistic parity with a reference *image*.
There is no image-generation skill or tool in this environment that
outputs that fidelity, and the product is a live data-driven scene, not a
static illustration — a perfect one-off render would misrepresent what
ships. This phase is the honest version of "as close as a real-time
WebGL scene, backed only by real numbers, can get."

## Phase 9 — a real theme registry, not one fixed look

The follow-up ask was explicit: don't lock the office to one designer's
taste — offer a hub/template system so people can pick (eventually build)
their own look, "Unreal or Unity, doesn't matter." The engine swap is the
one part of that not taken literally: this product's own earlier reasoning
(the original redesign brief, before any of Phases 1–8 existed) already
rejected Unity/Unreal for exactly this surface — "이건 게임 제작이 아니라
웹 기반 agent observability UI" (this is a web-based observability UI, not
game production), and nothing about wanting *choice* of look changes that
math: embedding either engine means a separate game-server + streaming
pipeline, off Vercel entirely, to skin a UI that already renders correctly
in a browser tab. What the ask actually needs — a real place to pick a
look, and more than one real look to pick from — is what this phase built,
on the same R3F stack, node for node.

`game3d/theme.ts` is no longer one exported `THEME` constant; it's a
`THEMES` registry (`Record<ThemeId, OfficeTheme>`) plus a `THEME_ORDER` for
a picker to iterate. Every game3d/ component that used to import the
constant now reads the ACTIVE theme from `scene-store.ts`'s new
`themeId`/`setThemeId` (persisted to `localStorage` — a per-browser display
preference, not account data, so it isn't a DB column) — the "🎨 [ THEME
NAME ]" HUD button cycles it. Two real presets ship, not one real theme and
a placeholder second option:

- **`tactical`** (default) — Phase 8's dark, bloom-lit command-center look.
- **`diorama`** — the ORIGINAL Phase 1–7 pastel miniature-office look,
  restored rather than left to bit-rot once tactical became the default.
  Bloom is off (`theme.glow: false`); room walls, HUD chrome, and every
  Html label switch to the exact rounded/soft-shadow/warm styling the DOM
  renderer's own aesthetic used, via `office.css`'s
  `.world3d-frame[data-theme="diorama"]` / `.world3d-viewport[data-theme=
  "diorama"]` override block — a parallel rule set rather than CSS-variable
  swaps, because the two looks differ structurally (corner radius, font,
  case, shadow), not just in color.

This is the *seed* of the hub the ask describes, stated honestly: adding a
third preset is one more `OfficeTheme` object in the registry plus one CSS
override block — no changes to any component that consumes it. A full
community-template marketplace (upload, browse, moderate, remix someone
else's theme) is a real backend feature (storage, review, versioning) this
phase does not build; the registry is the part that had to exist first for
that to ever be more than a mockup.

## Phase 10 — real thought bubbles, not decoration

The other half of the same ask: agents should visibly show *what they're
actually doing*, with an icon and text that describe the real work, not a
generic "thinking…" prop. `AgentAvatars.tsx` already had the data for
this and simply hadn't rendered it in 3D — `live-engine.ts`'s
`applySnapshot` sets `agent.speech` to the office's real, derived
`statusLine` (`office-functional-departments.ts`'s own sentence, e.g.
"Building — Accepted on job #12.", "A job is in dispute — under
adjudication.") for every agent, every poll; the DOM renderer has shown
this as `.ag-bubble` since Phase 1. The 3D scene now shows the identical
real text in a bubble above each agent, paired with that agent's CURRENT
department's real icon (`FUNCTIONAL_DEPARTMENTS`, keyed off `agent.deptId`
— 🔎 while researching, 🛠️ while building, ⚖️ while under review, and so
on) — the icon names the real kind of work the sentence next to it is
about, not a generic "💡 idea" glyph doing no real labeling. A bubble
remounts (`key={agent.speech}`) and replays its pop-in animation whenever
the underlying text actually changes — genuinely new content gets a fresh
bubble, not a silently-updated one.

## Phase 11 — skill installs that actually change the agent

The feature the Skill Gym waited for. `lib/agent-skills.ts` (its header is
the full spec — trust model included) lets an owner install a ClawHub
skill onto one of their own agents, and makes the install REAL through one
verified fact: ClawHub's detail API (`GET /api/v1/skills/{slug}`) returns
the skill's complete instruction document (the SKILL.md), confirmed
against the live API before any code was written. Install snapshots that
document into a self-migrating `agent_skill` table (the
`agent_office_slot` raw-SQL pattern), and `lib/agent-tasks.ts`'s
`runAgentTask` injects every installed skill into the agent's effective
task text — through the same single choke point `customInstructions`
always used, which every runtime's dispatch already reads. From the next
job on, the agent is literally told different things. That is the line
between a capability and a badge.

The composition is pinned, not vibes: `composeEffectiveTask` is pure and
its no-skills output is byte-identical to the old inline
`customInstructions` format (tests assert the exact string), so every
pre-existing agent dispatches exactly as before. `renderSkillsBlock` is
pure too — names the authority ("this agent's owner installed"), pins each
skill `slug@version`, and discloses any truncation in platform-authored
text (`lib/brief-excerpt.ts`'s rule: silent cuts are the defect).

Deliberate boundaries, each stated where it's enforced:

- **Owner-only**: every mutating call re-checks `agent.userId` — peers and
  requesters cannot install onto your agent. The consent model is Claude's
  own skill model: installing IS granting instruction power, and the
  explicit install action is the gate.
- **Snapshot-at-install**: the stored document is the one the owner
  installed. Upstream ClawHub edits never silently change an agent;
  reinstalling is the only upgrade path, and it is again an owner action.
- **Bounded**: 24,000 chars per skill (cut disclosed), 5 skills per agent —
  the brief cannot grow without bound.
- **`mcp` runtime excluded**: that dispatch path may reduce the task to a
  bare `[mcp-query]` argument for an external tool that follows no
  instructions — injecting a document there is noise by construction.
- **Degrades, never blocks**: a failed skill-table read at dispatch logs
  and sends the task without skills. Skills enhance a job; they are never
  the reason it didn't start.

The office UI (`AgentSkillsSection` in the Staff & connectors roster)
installs/uninstalls per agent with a ClawHub picker; the diorama places an
agent in the Skill Gym for 24h after a real install
(`recentSkillInstall` in `departmentFor`'s cascade, above the
settled-recently fallback, below money/job signals — tests pin the
ordering). Still NOT built, still not claimed: skill evaluation. Whether
an installed skill improves pass rate is a settled-outcomes-per-skill
question this phase does not answer, and no status line pretends to.

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
