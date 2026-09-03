# The Notion desk — run a fleet of agents that can all pay, from Notion

*2026-09-02. The positioning turn: Handsel is not pushed as a place to shop
for agents. It is the rail under a fleet you already run — and the surface
you run it from is a Notion database, with Claude Code as the hands.*

## Where this comes from

A reel by a Notion operator (June 2026, ~4k likes, ~650 comments): the whole
business drawn as one map on one screen — marketing, sales, customer admin,
operations, finance, taxes in the middle; funnels, the social system, content,
ads, sales and lead flows, SMS and email around it. The line that carries it:
*the most important part is having nothing live inside my head; I want to
scale with a clear path and review everything that happened last month and
adjust.*

Two things are true about that map. Every box is a role somebody has to
fill, every month. And the people who built one already think in rows and
statuses, not in "hire an agent". So:

> **Each row of a Notion database is one of those boxes, worked by an agent
> that has a wallet.** The map stays in Notion. The money and the
> verification are on the rail.

## What it does

The owner connects a Notion integration token and one database. Every ops
tick, the desk:

1. reads rows whose **Status is `Ready`**;
2. turns each into an **escrowed job posted by the owner's own agent**
   (`postSpecJob`) — `Brief` is the task, `Criteria` is what the escrow
   releases against, `Bounty` is the price; `Agent` names one of the owner's
   agents to reserve it for (a Claude Code worker running
   `handsel-worker.mjs --harness claude`, or any of them); empty `Agent` means
   the market;
3. moves the row to `Posted` **before** money moves, writes `Job` back;
4. on later ticks follows the job: `Working` when claimed, then `Delivered`
   with `Result` (first 2000 chars in the property, the full text as blocks
   under the page) and `Proof` (the certificate page), or `Failed` with
   `Note` saying why.

`Mode = Session` opens a session (`docs/sessions.md`) and posts `Brief` as
turn 1; when the row is set back to `Ready` with `Next` filled, the desk
posts the next turn. `Session` is written back so the thread is one row.

## The database

| column | type | required | who writes it |
|---|---|---|---|
| Name | title | yes | owner |
| Status | status **or select** | yes | owner sets `Ready`; the desk sets `Posted` `Working` `Delivered` `Failed`. (Notion's API cannot create status options, so a database built by a tool uses a select with those names.) |
| Brief | rich text | yes | owner |
| Criteria | rich text | yes | owner — 10+ chars; it is what the grader checks |
| Bounty | number (USD) | yes | owner |
| Agent | rich text | no | owner — one of their agents, by name |
| Mode | select `Job` / `Session` | no | owner |
| Next | rich text | no | owner — a session's next turn |
| Job, Session, Result, Proof, Note | number, rich text, rich text, url, rich text | no | the desk |

Column names match case-insensitively; types must match. `connect_notion_desk`
checks the schema and lists what is missing; the desk does not post until
the five required columns exist. Patches name only columns the database has.

## Bounds — because a shared sheet is a shared wallet

| rule | figure | enforced by |
|---|---|---|
| per row | `Bounty` ≤ the desk's cap (default $50) | `checkItem` |
| per tick / per day | 5 / 25 posts | `MAX_POSTS_PER_TICK`, `MAX_POSTS_PER_DAY` |
| once | a row is moved off `Ready` before it is posted; the status write failing means no post | `tickNotionDesks` |
| who pays | one of the owner's provisioned agents, chosen at connect | `connectNotionDesk` |
| the token | AES-256-GCM at rest, decrypted per call, echoed last-4 | `notion_desk` table |
| cron only | never on visitor traffic: it spends money and calls a third party | the ops step is not `fast` |

## Why this is the positioning

"Agent marketplace" sells to people who want to *buy* an agent. The reel's
audience already *runs* a business as a system of boxes and wants each box
filled reliably and reviewably. What they lack is not agents — Claude Code
is one command away — it is a way for many agents to spend, get paid, and be
checked without the owner in every loop. That is the rail: escrow, an
independent grade, a proof per deliverable, a credit history per agent. The
Notion desk puts the rail under the map they already have.

## What is not built

- **A settings page.** Connect and status are MCP tools (`connect_notion_desk`,
  `notion_desk_status`); the dashboard does not show the desk yet.
- **Relation-typed `Agent`.** Text matched against the owner's agent names.
- **Two-way status.** The owner's edits to a `Posted` row are not read; cancel
  the job on the platform.
- ~~**A public template link.**~~ Two things replaced it. `connect_notion_desk`
  with `create_under_page` **creates the table** under any page the owner
  shares with their integration — every column typed, one example row in
  Draft — so nobody needs a link. And the operator published the "Handsel
  Desk" table from Notion by hand on 2026-09-03 (Share → Publish → allow
  duplicating; there is no API for it): `https://skitter-hardboard-af3.notion.site/be3f1fed20c640aab03eb1ed9ae4b633?v=ff784327299f4673be6a364e90c491b9`
  is the default link on `/fleet` step one; `NEXT_PUBLIC_NOTION_DESK_TEMPLATE_URL`
  overrides it (empty string → the create path instead).
