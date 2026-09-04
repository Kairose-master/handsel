# Repo Care — the first complete vertical

> Overnight, the office reads a repository's backlog, works the tests, docs
> and low-risk bugs in your own checkout, verifies each change, and opens a
> pull request. Anything production-shaped, secret-shaped, dependency-shaped
> or money-shaped is left for you, with the reason written down.

This is the first thing in the repo that is a *product* rather than a
capability: one sentence a customer can buy, one screen to set it up, one
artifact to read in the morning. It is also, deliberately, **a
configuration of the office-session runtime rather than a second runtime** —
same state machine, same approval policy, same grants, same audit log
(`docs/office-sessions.md`). If Repo Care needed its own engine, the engine
would be wrong.

## What it is made of

| piece | where |
|---|---|
| Which issues get worked, and which are left for a person | `lib/repo-care.ts` (pure) — `triageIssues` |
| The backlog itself | `listOpenIssues` in `lib/github-app.ts`, through the GitHub App's installation |
| The session | an ordinary `scheduled` session; `startRepoCareSession` in `lib/office-session-server.ts` |
| The plan | `planSession` reads the settings and plans from the backlog instead of the goal |
| Landing the work | `SessionTask.deliverPr` → the loop's `open_pr` command → `openPrFromDiff` |
| The morning report | `morningReport` (pure), assembled per read by `repoCareReport` |
| Setting it up | the Repo Care card on `/office/sessions` (en/ko), or `start_repo_care` over MCP |
| The free, no-account diagnostic (any public repo, before signing in) | `lib/repo-diagnose-server.ts` — the same `triageIssues` rules, but read via GitHub's public REST API instead of the App's installation, and reduced to three honest counts by `summarizeTriage` (`lib/repo-care.ts`) |
| The sales package: landing copy, pricing, the diagnostic | `/repo-care` (`app/repo-care/page.tsx`, `components/repo-diagnostic.tsx`) — public, Korean, `docs/billing.md` |
| The guided onboarding (worker connect → posture → pay) | `/office/repo-care` (`app/(dashboard)/office/repo-care/`) — the customer-facing wizard onto the same `startRepoCare` action the `/office/sessions` card uses |

## The triage, and why it is boring on purpose

The asymmetry that decides every rule in `lib/repo-care.ts`:

- A **wrong skip** costs the customer one issue that stays open — which
  they were living with anyway.
- A **wrong pick-up** costs them a night's work producing a pull request
  that a person then has to read, judge and close. That is the exact cost
  the product claims to remove.

So triage is a fixed list, not a model's opinion:

| left for a person | rule |
|---|---|
| a human-only label | `needs-human`, `security`, `production`, `infra`, `deploy`, `release`, `breaking`, `billing`, `payment`, `legal`, `design`, `discussion`, `question`, `blocked`, … — matched as whole labels, so `securely-store-tokens` is not `security` |
| a title that names the dangerous thing | `production`, `prod`, `deploy`, `migration`, `secret`, `credential`, `token`, `api key`, `payment`, `refund`, `rotate`, `drop table`, … — whole words, **title only**, because a stack trace mentioning `production.log` is not a production change |
| nothing to work from | a description under 40 characters |
| not an issue | a pull request |
| outside the filter | when the owner named labels, anything without one |
| past tonight's cap | default 3 per run, hard maximum 10 |

Order is GitHub's own (oldest-updated first), so *what it will do tonight*
is answerable before it runs rather than after. A docs-shaped issue is
`E1` and needs no shell; everything else is `E2` and runs the repo's own
verify command.

**The skip list is recorded as an artifact** (`left-for-a-person-w<n>.md`)
on the session's timeline. An office that quietly ignored half a backlog
would look better than it is; this is the product's honesty, and it is on
the same page as the work.

## What lands, and when

A pull request is opened **only after the task settles** — verified, and
past the approval policy. Nothing reaches a repository that the office
would not have paid for. It goes through the same `openPrFromDiff` the
market's repo lane uses, which validates every hunk against the *current*
base before it opens anything, so a stale diff fails loudly instead of
landing badly. The PR URL becomes an artifact; a failure to land becomes
`SESSION_ESCALATED` with the reason, because a PR that silently did not
appear is worse than one that did not.

The morning report leads with what costs the owner attention — decisions
waiting, then landed, then failed, then left for a person — and is
assembled per read, so it cannot go stale.

## What it needs from the customer

1. A **local worker with a working directory** (`/office/sessions` →
   connect). Repo Care works in the owner's checkout; the platform never
   holds their code.
2. The **GitHub App installed on that repository** — the backlog read and
   the pull request both go through it (`docs/github-jobs.md`).
3. A **verify command** that decides a change is done. The worker's own is
   used when the session does not name one.

No wallet, no USDC: every Repo Care task settles as `internal`, so no
escrow is posted and nothing touches a chain.

## What is not built

- **No pilot has run it.** The triage, the plan, the PR path and the report
  are unit-tested (`tests/repo-care.test.ts`, `tests/office-session-wiring.test.ts`),
  and every piece underneath has run live (`docs/office-sessions.md`), but
  no repository has been cared for end to end by a customer.
- **CI is not read back.** A PR's checks are not folded into the session; a
  human reads the PR. The machinery exists in the market's repo lane
  (`lib/repo-jobs.ts`) and connecting it is the obvious next increment.
- **One repository per session.** An agency looking after twelve client
  repositories runs twelve sessions today.
- **Issue comments are not answered.** Repo Care reads the backlog; it does
  not talk back on the issue.
