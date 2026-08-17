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
