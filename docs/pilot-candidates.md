# Pilot candidates — the sales-side ledger for the two-week test

`docs/positioning.md` §8 set the bar: ten pilot offers, three real workflow
interviews, one $500 pilot sold, three real pieces of work finished, under
ten minutes of the customer's attention per task, one stated intention to
keep paying monthly. That test needs candidates before it needs anything
else, and a candidate list that lives only in someone's head is a list that
gets re-done from scratch every week — same failure mode `docs/interop-
outreach.md` was written to stop for external threads. This is that file's
counterpart for sales.

**What this file is not**: an outreach log. Sending the DM, running the
interview, and closing the pilot are the operator's own job — see
`docs/go-to-market.md` and `docs/positioning.md` §9's Korean sales-DM
templates (not committed verbatim here; they are the operator's own copy).
This file only answers *who to contact next* and *why they fit*, so that
research does not get re-run cold every week.

## The profile (ICP), stated once so it does not drift per entry

A candidate is a 1–10 person operation that:

1. **Already bills clients** for software or automation work — an agency,
   not a hobby project or an internal team.
2. **Already uses GitHub** (and ideally Notion) as its actual workflow, not
   as an experiment.
3. **Already runs Claude Code, Cursor, Copilot, or an equivalent coding
   agent** — the pitch is "carry it further," not "adopt AI for the first
   time."
4. Has a **principal who currently reads every result themselves** — the
   person whose hours Repo Care is sold against. Public signal: they post
   client work, review PRs personally, or describe themselves as a
   solo/small-team founder-operator.

A row that fails (2) or (3) is not a candidate yet, however good (1) and (4)
look — Repo Care's own trigger is a GitHub backlog; without one there is
nothing to diagnose with `/repo-care`'s free tool.

## Candidates

| # | Name / org | Signal (public, falsifiable) | Source | Found | Status | Next move |
|---|---|---|---|---|---|---|
| — | *(none yet — first pass not run)* | | | | | |

**Status values**: `not contacted` → `contacted` → `interview` → `pilot
offered` → `pilot sold` → `declined` (with a one-line reason) →
`unresponsive` (after a reasonable wait, per `docs/interop-outreach.md`'s
"verify, offer the exit, then wait" discipline — no re-pinging).

## Scoreboard

*(updated by each weekly pass — see below)*

- Candidates found: 0
- Contacted: 0 — **contacting is manual; this file does not send anything**
- Interviews: 0
- Pilots sold: 0
- Against the two-week test: 0/10 offers, 0/3 interviews, 0/1 pilot sold

## How a weekly pass works

A scheduled pass (Routine, weekly) does exactly this and nothing more:

1. Search publicly for agencies/operators matching the ICP above — GitHub
   organizations with client-shaped repo names, Twitter/X or LinkedIn posts
   about running a small dev/automation shop with Claude Code or Cursor,
   directories of AI automation consultancies, etc. `WebSearch`/`WebFetch`
   only — no scraping that needs credentials, no cold DM sent by the pass
   itself.
2. For each plausible candidate, write down the **falsifiable signal** — a
   URL and a sentence, not a vibe. A row with no source is not added.
3. Append new rows to the table above (never delete or "clean up" a row —
   status changes happen in place; the row is the record of when and why a
   candidate was found).
4. Update the scoreboard's `Candidates found` count and the two-week-test
   line.
5. Commit the file update (feature branch → fast-forward `main`, same
   workflow as everything else in this repo) and leave a one-line summary
   for the operator: how many new candidates, and whether the running
   total against the two-week test moved.

**What a weekly pass never does**: send an email, post a DM, open an issue
on someone else's repo, or mark a row `contacted` — those require the
operator to have actually done it. If the operator does contact someone,
update that row's status by hand (or tell the next pass, in the session, to
do it) so the ledger stays true.
