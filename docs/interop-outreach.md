# Interop outreach — every external thread, its state, and its next move

The community-contribution strategy ("become the grader others consume, don't
build more board") runs through threads on other people's repos. That state
lived in chat until 2026-08-06; now it lives here. **Update this file when a
thread moves** — a thread whose state is only in someone's memory is a thread
that gets dropped.

Discipline (from `docs/competitive-landscape.md`, third pass): outreach is
sequential and gap-verified, never sprayed. Every claim in an outbound comment
is verified by running it first. Every PR body offers the maintainer the exit
("if this was deliberate, say so and I'll close").

## Threads

**Scoreboard (2026-08-14):** 1 merged (thread 7 — SWE-AF #131), 1 substantive
technical exchange (thread 9 — ERC-8183), 1 positive maintainer response
(thread 6 — skills-market #58), 5 unanswered. The merged one took a review
round and a same-day fix; the base rate for cold PRs into other people's
repos remains what this file predicted, so the discipline stays: verify by
running, offer the maintainer the exit, then wait.

| # | Where | What | State (2026-08-06) | Next move / trigger |
|---|---|---|---|---|
| 1 | `daydreamsai/taskmarket-contracts` [PR #11](https://github.com/daydreamsai/taskmarket-contracts/pull/11) | `.gitmodules` missing — fresh clone cannot build | Open, no maintainer response | Wait. Base rate: repo is a mirror of an internal monorepo (`sync:` squashes to internal #369), 0/7 outside issues ever answered. Likely outcome: content absorbed via a `sync:` commit, PR closed — that still credits the finding |
| 2 | `daydreamsai/taskmarket-contracts` [PR #12](https://github.com/daydreamsai/taskmarket-contracts/pull/12) | Empty RewardVault blocks `claimTask` (fixes #6) — 555 tests green | Open, no response. **Reclassified 2026-08-17 (see below): this is a contested design call, not an overlooked defect** | Do **not** re-file or bump. A follow-up is only worth posting if it engages the atomicity rationale head-on; repeating the bug claim against a documented intention is how a contributor becomes noise |
| 3 | `daydreamsai/taskmarket-contracts` [#6 comment](https://github.com/daydreamsai/taskmarket-contracts/issues/6) | Root-cause + link to PR #12 + `emergencyWithdraw` flag | Posted | None — it exists to make PR #12 findable |
| 4 | `daydreamsai/taskmarket-contracts` [#10 comment](https://github.com/daydreamsai/taskmarket-contracts/issues/10) | EXT-002 egress: budget ≠ containment; destination policy; "who eats the egress cost" | Posted | Respond if the proposer (bolivian-peru) engages |
| 5 | `daydreamsai/skills-market` [#57](https://github.com/daydreamsai/skills-market/issues/57) | Our external-grading offer for Bounty-mode tasks | Open, unanswered. Known now: the evaluator slot is contract-side (`ITMPEvaluator` in taskmarket-contracts) but all state changes are relay-gated, so the integration is server-side — jihadMo's TS-layer instinct was right, the stub was the only wrong part | Follow up **only after** something merges or a maintainer engages anywhere; next content = `/api/evaluator/verdict` + `docs/taskmarket-evaluator.md` as the concrete answer to our own question |
| 6 | `daydreamsai/skills-market` [PR #58](https://github.com/daydreamsai/skills-market/pull/58) | jihadMo's bridge stub (hardcoded pass, nonexistent `handsel.dev`) — reviewed, not merged | jihadMo responded positively (2026-08-07) inviting the real implementation. `ExternalEvaluatorBridge` shipped for real (`lib/external-evaluator-bridge.ts`, `tests/external-evaluator-bridge.test.ts`, 10 tests) — `docs/external-grading.md`'s "Live" claim is now actually true. **Comment with the implementation posted on PR #58 by the operator (2026-08-07).** | Wait for jihadMo's response — fold it in himself, or ask for a follow-up PR. Answer technically if he engages |
| 7 | `Agent-Field/SWE-AF` [PR #131](https://github.com/Agent-Field/SWE-AF/pull/131) | Deterministic benchmark scorer (the evaluator their README already points at) — now 14 tests | **Review received 2026-08-10** (AbirAbbas, changes requested): 4 code items (JUNK_DIRS prune inconsistency, unhandled FileNotFoundError/TimeoutExpired, npm/git hardening flags, .gitignore substring bug) + the bigger flag that the scorer doesn't reproduce the README table (codex/haiku Structure 20/20 vs table's 10). **All 4 fixed + pushed same day** (`5b9a1be`), each pinned by a test; the reproduction divergence confirmed locally and answered per stance: split/weights are theirs, table-must-be-program-output is the non-negotiable — offered recalibrate-checks or regenerate-table, either way works. **Reply comment posted by the operator (2026-08-10)**. **MERGED 2026-08-14**, all checks passed. Verified independently of the PR page (which has read as "Open" all week): `examples/agent-comparison/evaluator/score.py` is on `main` and carries both review fixes — `JUNK_DIRS = ("node_modules", "coverage")` pruned uniformly, and `npm install --ignore-scripts` — so what merged is the reviewed revision, not an earlier one. **First contribution to land in another team's agent-benchmark repo.** | Nothing to push. The reproduction divergence is now theirs and the merge did NOT decide it: the scorer on `main` still disagrees with the README table (Structure 20/20 vs the table's 10). The non-negotiable ("the published table must be program output, not prose") is now checkable by anyone running their own repo's code — which was the point. If they regenerate the table, confirm the numbers are output; if they recalibrate the checks, ask what Structure=10 docked and encode it. Do not re-raise unprompted |
| 9 | `ethereum/ERCs` [#1931](https://github.com/ethereum/ERCs/issues/1931) | ERC-8183 review: Expired conflates no-submission with evaluator-silence; two suggestions (split taxonomy, stop equating Expired with Rejected) | **Substantive technical reply received (2026-08-09)**: correctly identifies that the taxonomy split alone imports a junk-at-deadline griefing vector; recommends two clocks. Our answer drafted: two clocks + submission-side stake + burn-not-pay are jointly required (LaborMarketV2 runs all three; cited with code-verified facts) | Operator posts the reply; then watch for the author's response — this is the highest-quality external engagement any thread has produced |
| 8 | nobulex (`nobulex.dev@gmail.com`) | Collaboration email: we consume registry records (FAIL_UNSAFE = routing data in a pay-on-pass market); our failed-job forensics feed their subject pipeline. One-directional, no ask | **Sent by the operator (2026-08-07)**, failure-story + respect framing | Wait for a reply. If reply: build our side only. If silence: consume the registry as a reader anyway — the email says so |

## Check-in 2026-08-17 — read the code, not the PR page

Two of these threads were re-checked against the upstream repositories' actual
`main` rather than against their PR pages, and the code said something the pages
did not.

**Thread 7 (SWE-AF) — no follow-up, as expected.** Our merge `dfd3157` is still
the tip of `main`; nothing under `examples/agent-comparison/` has changed since
it landed. So they have neither regenerated the README table nor recalibrated
the checks, and the divergence the merge did not decide is still undecided and
still theirs. Nothing to do, per the standing instruction not to re-raise.

**Thread 1 (`.gitmodules`) — actively skipped, not merely unanswered.** The
mirror is syncing: `sync:` commits land through 2026-08-16. `.gitmodules` is
still absent at `main`, so a fresh clone still cannot resolve `lib/`. Ten days
of upstream activity have gone past the fix without taking it. That is weaker
than "no response" — it means the predicted outcome in row 1 ("content absorbed
via a `sync:` commit") is not happening on the current evidence.

**Thread 2 (empty RewardVault) — we were arguing against a stated intention and
did not know it.** `src/hooks/TaskTokenRewardHook.sol` carries this, above the
`try`:

> *"If `vault.reserve()` itself reverts (insufficient vault balance), that
> propagates and reverts the whole claim/select-worker call — consistent with
> `epochBudget`'s consumption being rolled back too."*

`git blame` dates that sentence to **2026-07-12**, three weeks *before* we filed
PR #12 on 08-06. The 08-12 sync commit only swept the file for the `_s()`
storage-pointer refactor; `git show 985f7fb^` has the identical wording. So the
maintainers had already written down that an empty vault reverting the claim is
deliberate atomicity, and our PR argues from consistency with the `try/catch`
around `vault.release` in `_releaseReserve` without engaging that argument at
all.

Both readings are defensible, and ours is not obviously right:

- **Ours**: the reward hook is a bonus path; it must never block the USDC
  payment path, and `_releaseReserve` already swallows vault failures, so
  `reserve` propagating is an inconsistency.
- **Theirs**: `epochBudget.checkAndConsume` and `vault.reserve` are one
  reservation. Letting the vault fail while the budget consumption stands would
  leave the budget debited for a reward that was never reserved — a silent
  accounting drift, which is worse than a loud revert.

The honest correction to this file is that **thread 2's state was mis-recorded
as "unanswered"**. It was answered, in a code comment, before we asked. That
changes the merge odds and it changes what a follow-up would have to contain:
the only version worth posting shows that the budget/vault pair can be kept
atomic *and* non-blocking (release the consumed budget in the same `catch`, so
neither side stands alone), which is a different patch than the one we filed.
Not filing it now — thread 1 shows this repo is not taking outside patches at
present, so a second unengaged-with PR is cost without upside.

**Not verified:** the comment threads on issues #6 and #10 — and the reason is
worth writing down once, because every check-in otherwise rediscovers it.

The pages became readable on the 20:00 pass (they had returned 403/404 four
hours earlier), and both issues are **still Open**: #6 (fablerlabs, 2026-07-13)
is not closed by PR #12, #10 (bolivian-peru, 2026-07-31) is untouched. But the
fetch path renders **only the opening post** — on PR #11 and #12 the single
"comment" it reported was the PR description itself, and it found no reviews on
either. So it has never demonstrated that it can see a follow-up comment
anywhere, and the absence of our own posted comments on #6/#10 is evidence
about the fetcher, not about the threads.

Which means a maintainer reply on any of these four would be invisible to us.
Recorded as **unread, not unchanged** — a gap in observation is not evidence of
absence, the same distinction `lib/evidence-assurance.ts` enforces when coverage
is 0. Reading these properly needs an authenticated API path, which this session
does not have for repositories outside its scope.

**Cause pinned, 2026-08-25 — stop rediscovering this.** It is not a flaky
fetcher. The GitHub API tools are scoped to *attached* repositories; both
upstreams are third-party, so every call returns a hard `Access denied:
repository "daydreamsai/taskmarket-contracts" is not configured for this
session`. `add_repo` with `access:"read"` does **not** lift it — that grants
anonymous *git* reads only, and says so: "GitHub API tools (issues, pull
requests, the github MCP server) ... do not cover unattached repositories."
The only lever is attaching with `access:"push"`, which runs full
repository-access checks and is both likely-refused and disproportionate for
read-only observation of someone else's repo. So comments and PR open/closed
state are **permanently** unobservable from here, not intermittently.

What git-only access *does* verify — and it covers most of what we watch:
file content on `main` (did SWE-AF regenerate the README table? is
`.gitmodules` present yet?) and what each `sync:` commit actually swept in.
Those checks are reliable. Treat every "no response" line in the table above as
a statement about *absorbed content*, never about maintainer silence.

**Cadence, same date.** The 4-hourly check-in chain is retired in favour of
daily. It had fired 12+ consecutive times with no finding, against threads whose
documented next move is "wait" (thread 1: 0/7 outside issues ever answered;
thread 2: do not bump; thread 7: do not re-raise unprompted) — polling every
four hours for a signal this very section records as invisible. Nothing here
moves on a four-hour timescale: upstream `sync:` commits land every few days at
best (2026-08-01, -07, -10, -11, -12, -16).

**Verified 2026-08-26, git-only, all unchanged.** SWE-AF: nothing has touched
`examples/agent-comparison/` since our merge `dfd3157`; the README table still
reads Codex/CC-Haiku `Structure 10` against the merged scorer's 20, so the
divergence stands and they have neither regenerated nor recalibrated. Its
README *has* moved twice (`f9aec21` #140, `0c64fe7` #142) — a Railway deploy
link and a Docker `HARNESS_MODEL` fix, neither near the benchmark table, which
is worth recording so the next check doesn't read the churn as a response.
taskmarket-contracts: still no `.gitmodules` (thread 1 unabsorbed). One new
sync has landed since the previous check — `6584077` (08-25), a single-line
correction to a path inside an ERC-8195 spec document
(`docs/CONTRACTS_GUIDE.md` → `docs/guides/CONTRACTS_GUIDE.md`). It touches no
contract, and nothing has touched RewardVault or `claimTask` since `657b9f7`,
so PR #12's fix is unabsorbed too. The base rate holds: syncs keep arriving,
none of them ours.

**Verified 2026-08-28, git-only, both anchors unchanged in substance.**
SWE-AF: `main` HEAD is still `0c64fe7` — byte-identical to the 08-26/08-27
checks, so `examples/agent-comparison/` and the README table are unchanged
by construction (nothing landed at all). taskmarket-contracts: `.gitmodules`
still absent (thread 1 unabsorbed). Two new syncs since `6584077` —
`a85cc8d` and `f2bd878` (both 08-27) — land a substantial new feature (a
"taskmarket hook manifest" schema + validator + `create-taskmarket-hook`
scaffolding tool + reference hook base classes/tests, 33 files). Checked the
full diff for `RewardVault`/`claimTask` by name: the only `claimTask` hits
are new reference-hook tests *calling* the existing function, nothing
touches its implementation or `RewardVault.sol` itself — PR #12's fix
remains unabsorbed. Anchors going forward: SWE-AF HEAD `0c64fe7`,
taskmarket-contracts HEAD `f2bd878`.

## Inbound, for the first time (2026-08-18)

Everything above is outbound — us contacting other projects. This is the first
entry in the other direction, and it arrived without us doing anything.

**An aggregator indexed us.** `vansh-09/BountyScout` runs a bot that scans
GitHub for bounty-labelled work and files a digest issue; its 2026-08-18 scan
([#829](https://github.com/vansh-09/BountyScout/issues/829)) lists
`Kairose-master/handsel` among eight opportunities. We are in a feed that other
agents read.

What it surfaced is the problem: our entry is **"Label-bot smoke test"**. The
one public bounty surface an outside crawler can see is advertising a test.

### The market-structure finding, from someone else's data

Of the eight entries in that scan, seven are **supply side** — agents, runtimes
and platforms looking for paid work, or infrastructure for paying:
`relayhop/ClaudeEarnSelf-runtime` (×2), `relayhop/sn-monetization-runtime`,
`Doris-sudo/monee-pay` (escrow contracts), `Scottcjn/Rustchain`, and us.

The eighth was checked rather than assumed, and it changes the finding.
`snowdensb/litellm` looked like the one real demand item — "67 vulnerabilities,
severity 10.0". Its issue list is automated dependency-scanner reports on a
fork, every one of them, and **not one offers payment**.

So: a crawler whose entire job is finding bounties scanned GitHub, filed a
digest titled *"Bounty Alert: 8 New Opportunities found"*, and **none of the
eight is someone paying for work.** That is not "demand is thin". On this
sample it is zero, and the sample is not ours.

That is the same finding `docs/product-thesis.md` reaches from our own numbers —
*the constraint is demand, not infrastructure* — reached independently, from a
third party's crawl, on a population we did not select. Until now that claim
rested on our own market being a star centred on the operator. It no longer
does.

### The two worth reading

**`relayhop/ClaudeEarnSelf-runtime`** — an agent trying to earn its own money,
running since at least 2026-05-01. Its `scripts/demand_radar.mjs` inverts the
usual direction: instead of watching bounty platforms it searches for people
*saying* they will pay — Stacker News GraphQL, GitHub issue search for bodies
containing `tip|bounty|paid|sats|usdc`, Reddit `/r/forhire`, Nostr full-text.
Collected feeds from Algora, Bountycaster and Layer3 sit in `data/opportunities`.
The runtime repo is public deliberately (free unlimited Actions minutes on public
repos) with the strategy repo private, and it polls a **Base** USDC balance —
our chain.

It is not a competing market. It is a *worker*, hunting the same scarce thing we
are: someone who will actually pay. Two consequences, and they point opposite
ways — it competes with our workers for outside demand, and it is the first
realistic candidate for an outside worker on our board, because its radar would
find a Handsel repo job on its own if the issue body carries the tokens it greps
for.

**`Doris-sudo/monee-pay`** — the closest technical neighbour: milestone escrow,
product escrow and batch payroll on Quai Network, with a Farcaster mini-app as
distribution. Worth reading `contracts/src/MilestoneEscrow.sol` because the
release model is the one we argue against: `approveMilestone` is the *creator*
approving, and disputes go to `resolveDispute(...) onlyArbitrator`. No
independent grading, no pay-on-pass verdict, no record that survives the
platform. Their arbitrator is a single key that can transfer itself — the same
weakness we disclose in `docs/security-audit.md`, so this is a shared gap rather
than a point scored.

Where they are ahead of us: they have a distribution surface (Farcaster frames,
in-feed transactions) and we have none.

### What this does and does not change

It does **not** solve the demand problem. Posting a real bounty so the crawler
points at real work would still be operator-funded demand, which
`product-thesis.md` already refuses to count.

What it could produce is an outside **worker** — which would also be a first,
since both sides of this market are currently the operator. Worth saying out
loud so the two are not conflated when one of them happens.

## Inbound to our own repo (2026-08-29) — AIPOU pilot proposal

A second inbound thread, and the first one filed directly on `Kairose-master/handsel`
rather than discovered by a crawl: [issue #8](https://github.com/Kairose-master/handsel/issues/8),
0xddneto proposing a narrow, boundary-respecting pilot between Handsel and
AIPOU (an MCP-first signed-receipt protocol, not a grader or an escrow rail).

**Read before responding, per rule 1**: both linked AIPOU docs
(`evidence-boundaries.md`, `external-evidence-links.md`). Both confirm no
binding obligation on a third party, no payment/integration/protocol-change
ask — `workReceiptId` is explicitly "issuer_asserted," not evidence of
quality, delivery, payment, or a Handsel decision.

Step 1 of their proposal ("one unpaid image sample generated and graded
entirely under Handsel's own rules") needed no staging: `POST /api/demo/run
{kind:"image"}` already does exactly this — real image worker, real
independent vision grader, an EIP-712-signed proof. Ran it live rather than
promising one (rule 1 again): passed, proof `841947ac-5076-4baf-aace-02659bd0bfb2`,
independently verifiable at `/api/proof/<id>`. **Replied on the issue
(2026-08-29)** with that real proof link and the self-serve curl so they (or
anyone) can produce their own rather than trusting a hand-picked one.

Steps 2–4 (picking a provider for one real bounty, any onward reference to
AIPOU) are a maintainer/business call, not one to make from this thread —
flagged to @Kairose-master rather than committed to. A stray `/attempt` from
an unrelated account does nothing here; that only means something on a
`bounty:$`-labeled issue, which this is not.

**Next move**: wait. Per the standing discipline, don't bump; respond if
0xddneto (or the maintainer) moves it to step 2.

## Standing rules for new threads

## Standing rules for new threads

1. **Verify before posting.** Clone, build, run — a claim in an outbound comment
   that we did not execute is §27 waiting to happen.
2. **One live venue at a time per community.** daydreams ↔ OpenClaw ↔
   TaskMarket is one small interconnected graph; a spammer reputation there is
   fatal and permanent.
3. **Every artifact must survive us being ignored.** PRs that document real
   defects, a scorer that works standalone, an email that ends "I'll be reading
   it either way" — outreach whose value requires a reply is a lottery ticket,
   not a strategy.
4. **Never request forwarder/whitelist powers** on a relay-gated market — a
   trusted forwarder can impersonate any actor (`docs/taskmarket-evaluator.md`).
   A permission they should refuse is not one we ask for.
