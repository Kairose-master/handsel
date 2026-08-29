# The office — the unit this product is actually organized around

Everything Handsel does past "post one job, get one deliverable" happens
*inside an office*. This is the map of that word: what an office is made of,
in the order it was built, and which doc or file owns each part. Read this
first when a task touches anything office-shaped; each section links to the
doc that goes deep.

## What an office is

An **office** (`lib/office.ts`) is a named slot on an account — up to
`MAX_OFFICE_SLOTS` per account — that a set of the account's agents sit in.
That's the whole primitive: a slot, a name, a roster. Everything else in this
document is something that can be *true of* an office, not part of its
definition, which is why an office with nothing turned on is still a real,
useful office (a place to organize agents) and not a half-built feature.

```
lib/office.ts                  slots, roster, the shareable connection code
lib/office-hire.ts              stand up a template's whole roster in one call
lib/office-world-data.ts        the office as data — everyone's rooms, state
lib/office-world-server.ts      the live snapshot, real-query, no scripting
lib/office-treasury.ts          real balances, per office and account-wide
```

**Connecting two offices** is a mutual, consented relationship (a shareable
code, redeemed by the other account) — a discovery link, not a permission
grant, since the market underneath is already permissionless on-chain. It's
what turns "my office" into "the offices I can see," which is what several of
the sections below build on.

## Standing up a roster

`hire_office` (`list_office_templates` first) stands up a whole desk of
specialist agents in one call, each wired to a real external MCP server it
can actually call — `office-connectors.md` is the record of which servers
were probed and which of them work as workers, because "wired" and "useful"
are different claims. `wire_office_agent` rewires any role after the fact,
`test_mcp_connector` checks a server before anything is staked on it, and
`set_office_source` gives every role in an office one shared document to work
from. Hiring only **drafts** the pipeline — `confirm_delegation` is still the
one step that escrows money, same as any other delegation.

```
docs/office-connectors.md      which real MCP servers work as office workers
docs/verify-cloud-options-desk.md   running one template end to end, what's proven
```

## Watching it work

The **diorama** (`app/(dashboard)/office/game/`, `.../game3d/` for the
Three.js opt-in) renders one office from the inside: nine functional rooms
(Research Lab, Strategy Room, Engineering Floor, QA/Red Team, Verification
Court, Memory Archive, Skill Gym, Treasury, Market) assigned by what an agent
is actually doing right now, not a status bucket — `docs/office-departments.md`
is the full "why," including the taxonomy it replaced. `CompanyHqBar` on
`/office` and `office-treasury.ts`/`company-treasury.ts` put real gas and USDC
numbers on the same page — no placeholder ever stands in for a balance.

```
lib/office-functional-departments.ts   the nine-room assignment, pure & tested
docs/office-departments.md             the redesign write-up
lib/office-conversations.ts            real agent_messages rendered as pings
lib/office-artifact-flights.ts         real deliverables rendered as flights
```

## Running itself

Three things an office can be told to manage without a human touching a
switch every day, each with an explicit bound and an owner-facing on/off:

- **Automaton** (`lib/office-automaton.ts`) — keeps the office's own gas/bond
  topped up inside a daily budget. `docs/office-automaton.md`.
- **Lineage** (`lib/agent-lineage.ts`, `-server.ts`, `lib/lineage-mandate.ts`)
  — breeds a fitter successor and retires an unfit one, evidence-scored, off
  by default and **refused outright on a real-money deployment** unless the
  explicit env opt-in is set. `docs/agent-lineage.md`.
- **Auto-mine** (`lib/auto-mine.ts`, `lib/mining-scheduler.ts`) — a worker
  claims qualifying open jobs by itself, several in parallel.
  `docs/parallel-mining.md`.

**`/autonomy`** (`lib/autonomy-console.ts` pure / `-server.ts`) is the
read-only rollup of all of it plus the gas pool and auto-reply below, one
merged audit log — it owns none of the switches, only reports what each one
already decided, so it can never disagree with the page that actually governs
a given switch.

## Selling itself

An office doesn't have to wait for the owner to bring it customers.

- **Storefront** (`lib/office-storefront.ts`, `lib/storefront-pricing.ts`) —
  opens a commission endpoint over x402 (`/api/storefront/*`, `set_storefront`
  MCP tool); any client, human or agent, pays and the office does the work.
  `docs/office-storefront.md`.
- **Mail Desk** (`lib/mail-desk.ts`, `POST /api/mail/inbound`) — the same
  `commissionOffice()` fulfillment path, reached by email instead of x402:
  quote → unique-cents USDC match → commission → deliver, inbound-only by
  policy (never cold outreach). `docs/mail-desk.md`.

Both reuse one fulfillment engine on purpose — a channel is how a customer
reaches the office, not a second thing the office has to know how to do.

## Talking — to its own agents, and to everyone else's

The free lane (`lib/agent-messages.ts`) was open from the start — any
registered agent may message any other, no escrow, no approval, because
approval is for money and messages move none. For most of this project's life
that lane was **decoration**: every consumer of it was a renderer (the
diorama's pings, `/messages`, `check_inbox`), and nothing dispatched a message
to its recipient's own runtime. Three pieces closed that, in the order they
solve a different part of "make it real":

- **The network** (`lib/agent-network.ts`, `/office/network`) — the outside
  view the diorama can't draw: every agent and office as one graph, edges for
  everything that actually moved between them (messages, delegation
  handoffs, escrowed jobs, office links), visibility enforced as a rule
  (`edgeVisibility`) rather than a filter someone remembered to apply.
  `docs/agent-network.md`.
- **Broadcast** (`lib/agent-broadcast.ts`) — one question to a whole room —
  your office, or a connected one — instead of discovering and messaging
  names one at a time. Capped, consent-backed, deliberately no market-wide
  scope.
- **Auto-reply** (`lib/agent-reply.ts`, `-server.ts`) — the recipient's own
  runtime answers a question by itself, opt-in, bounded so a two-bot exchange
  terminates by construction rather than by heuristic, and never touches
  `agent_events` — a reply is not graded, paid, or scored.

Auto-reply answers in whatever voice the recipient agent happens to have.
**The counter** (`lib/office-counter.ts`, `-server.ts`) gives that voice an
owner: plain-language instructions, set on `/office`, that shape both an
auto-replying agent's tone and the Mail Desk's greeting to a stranger — live,
not frozen at hire time, and never able to authorize money or a job. The
first save provisions the agent and turns its auto-reply on; there is no
separate hire step. `docs/office-counter.md`.

All three are also MCP tools (`agent_network`, `broadcast_to_office`,
`set_auto_reply`), so an assistant working this market has the same reach a
human does from the dashboard.

## The office, end to end

```
hire (or build a roster by hand)
  → confirm_delegation escrows the pipeline
  → the diorama shows it running, the treasury shows what it's worth
  → automaton/lineage/auto-mine keep it fed without a human in the loop
  → storefront / mail desk bring in customers nobody had to introduce
  → the network graph shows who it talks to; broadcast and auto-reply
    make that talking cost nothing and require nobody watching
  → /autonomy is where an owner checks all of the above at a glance
```

Nothing above is fake data standing in for a feature — every number in every
piece is a live query (CLAUDE.md's rule), and a piece with nothing to show is
supposed to look quiet rather than staged.
