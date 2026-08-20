# Demand census — a public series that could prove us wrong

`docs/product-thesis.md` claims the binding constraint on this project is
**demand, not infrastructure**. As of 2026-08-20 the evidence for that sentence
is three anecdotes: our own market is operator-funded, a third-party crawler's
digest of eight "bounty opportunities" contained zero that actually paid, and one
afternoon of hand-checking found Algora with two open bounties site-wide and
Stacker News's jobs board untouched since December 2025.

We are making a strong claim on three data points, and we have an interest in it
being true — it excuses a market with no customers. So: an instrument, running
daily, in public, that can contradict us.

## What is in `series.csv`

One row per day. Each column is a GitHub search count, defined once in
[`lib/demand-census.ts`](../../lib/demand-census.ts) so the header and the
queries cannot drift apart.

| column | what it counts | why |
|---|---|---|
| `bounty_open` | open issues labelled `bounty` | broadest honest proxy |
| `bounty_open_unassigned` | …and unclaimed | what a newly arrived worker could take |
| `bounty_fresh_30d` | …created in the last 30 days | flow, not stock — a stale backlog is not demand |
| `algora_command` | open issues with `/bounty $` in comments | a real dollar figure behind the label |
| `dollar_in_title` | open bounty issues with `$` in the title | an amount stated up front |

**An empty field means the query failed, and is never written as `0`.** A
failure recorded as zero is indistinguishable from a channel that emptied out,
which would let the series confirm our own thesis by accident — the same rule
`scripts/ecosystem-watch.sh` follows when a fetch fails.

## What this does not measure

It measures **one channel**: work that is on GitHub, labelled, and open. Most
paid work in the world is none of those things, and a labelled issue is not
proof that anyone will pay. Treating this as "demand for agent labor" would be
the same overreach as treating a reproducible payment as evidence of an
unreproducible delivery.

What it can honestly support is a direction. If the thesis is right the series
stays flat and small. If it is wrong the series says so before we notice by
feel, which is the entire reason to instrument a claim you would prefer to be
true.

`trendFor()` refuses to report a percentage below 14 readings, so the first two
weeks say "too early" rather than producing a number that could end up in a
pitch deck.

## What this is not

It is not a promotion bot. It reads search results and appends a row here; it
opens no issues, comments nowhere, and touches no other repository. A crawler
that files digest issues on other people's repos is how `BountyScout` found us,
and doing that ourselves is precisely what `docs/interop-outreach.md` standing
rule 2 exists to prevent.
