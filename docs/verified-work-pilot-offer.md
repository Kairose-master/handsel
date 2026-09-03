# Pilot offers — the two messages, ready to send

30-day plan items 3 and 4. The owner sends these; nothing here is sent by
code. Every figure is the one the contract enforces (`docs/worker-terms.md`),
and every "if it fails" sentence is the true one, because the pitch is that
our sentences are true.

## A. Three paid pilots — maintainers and small teams

Send to: an open-source maintainer with a labelled backlog (the daily
`data/demand-census/leads.csv` ranks candidates, one per repository, with the
reasons written out), an AI startup's small dev team, an indie hacker, or an
agent builder who wants an outside worker attached.

> Subject: three issues on <repo>, you pay only what merges
>
> I run Handsel — a market where an AI agent takes a GitHub issue, opens a
> PR, your own CI grades it, and your merge is what releases payment. If you
> don't merge, you don't pay the bounty.
>
> I'd like to do three of your open issues as a pilot. The menu is fixed
> scope — a bug fix ($40), a test file ($30), or a documentation update
> ($25) — 24-hour delivery, one PR each, no refactors, no scope creep; the
> exact brief and acceptance criteria are public
> (`docs/verified-work-menu.md`).
>
> What happens with the money, exactly: the bounty is escrowed on Base in
> USDC when the job is posted, plus a 5% + $0.03 posting fee that is not
> refunded on any path. If you merge, the worker is paid. If you close the
> PR unmerged, 90% of the escrow returns to you at the 24-hour review
> deadline and 10% goes to the worker under the contract's silence rule;
> a dispute you win returns 100%. Full rules, with the contract function
> behind each: `docs/worker-terms.md`.
>
> For the pilot I will front the escrow and the fee myself, so your cost is
> zero unless you merge, and if you merge you pay me the bounty by whatever
> means you already use — I am not asking you to touch a wallet for three
> issues. What I want back is three honest outcomes I can publish: merged,
> closed, or declined, with your reason.
>
> Pick three, or send me the repo and I'll propose three from the labelled
> backlog.

*Internal, before sending:* the pilot only counts as external revenue if the
requester is not the operator — post the jobs from an account the buyer
controls, or record the buyer as the requester of record, or
`scripts/external-revenue.mjs` will (correctly) exclude it. Record the outcome
per job: merged / closed / declined, attempts, and the buyer's stated reason.

## B. Issue #8 — the second bounty is the paid one

State of the thread (2026-08-31): steps 2–4 confirmed by the maintainer, one
unpaid sample bounty, grading ours, settlement theirs, next move AIPOU's
(post the bounty spec). The paid-conversion experiment is one comment, posted
*after* the sample bounty settles, whatever its outcome:

> Thanks — sample bounty settled under your criteria; the graded outcome and
> signed proof are linked above either way.
>
> Proposal for a second one, this time priced: same lane (image generation
> + independent vision grade + signed proof), one deliverable against
> criteria you publish, $25 escrowed on Base mainnet through Handsel, paid
> to the provider only on a passing grade under Handsel's rules AND your
> visual acceptance; returned to you otherwise under the contract's
> published terms (`docs/worker-terms.md`). That would make AIPOU the first
> paying external requester on this deployment, and I would record it as
> such — the same standard your side already applies to
> `provider_issued_unverified`.
>
> If a paid second bounty is not something AIPOU would do, that is a useful
> answer too, and I'd rather have it plainly than assume.

*Internal:* priced at **$25** on 2026-09-03 — the menu's lowest fixed-scope
price (`docs/verified-work-menu.md`), and above any plausible cost of one
image generation plus one vision grade; `lib/external-revenue.ts` still
leaves `costPerSuccessUsd` null until the ledger records production cost, so
this is a floor chosen by hand, not a measured margin. **Not yet posted:**
the thread's last move (2026-08-31) is ours, the sample bounty has not
settled on AIPOU's side, and `docs/interop-outreach.md` says don't bump. Post
the moment their spec or visual review lands, whatever the outcome. The
answer, including "no", goes in `docs/interop-outreach.md` as the outcome of
the pilot, not buried in the thread.

## What can and cannot be sent from a Handsel session (2026-09-03)

A session bound to this repository cannot send message A: the GitHub search
API and every third-party repository are outside its scope, and the platform's
own mailer needs the deployment's secrets. What a session *can* do is build
the list: the census workflow now commits `data/demand-census/leads.csv` and
attaches it to each run, so the owner opens the top three and pastes A. The
owner sends; nothing here is sent by code — unchanged.

## What both messages must never say

- "You pay nothing." (The fee is never refunded; unmerged returns 90%.)
- Any settlement rate or pass rate pooled across grader classes.
- That a Handsel proof establishes quality — it establishes provenance
  (issue #8 settled this precisely; keep to it).
