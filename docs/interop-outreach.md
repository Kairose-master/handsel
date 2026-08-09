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

| # | Where | What | State (2026-08-06) | Next move / trigger |
|---|---|---|---|---|
| 1 | `daydreamsai/taskmarket-contracts` [PR #11](https://github.com/daydreamsai/taskmarket-contracts/pull/11) | `.gitmodules` missing — fresh clone cannot build | Open, no maintainer response | Wait. Base rate: repo is a mirror of an internal monorepo (`sync:` squashes to internal #369), 0/7 outside issues ever answered. Likely outcome: content absorbed via a `sync:` commit, PR closed — that still credits the finding |
| 2 | `daydreamsai/taskmarket-contracts` [PR #12](https://github.com/daydreamsai/taskmarket-contracts/pull/12) | Empty RewardVault blocks `claimTask` (fixes #6) — 555 tests green | Open, no response | Wait. #6 comment (posted) notifies issue subscribers incl. reporter fablerlabs — widest audience this repo allows |
| 3 | `daydreamsai/taskmarket-contracts` [#6 comment](https://github.com/daydreamsai/taskmarket-contracts/issues/6) | Root-cause + link to PR #12 + `emergencyWithdraw` flag | Posted | None — it exists to make PR #12 findable |
| 4 | `daydreamsai/taskmarket-contracts` [#10 comment](https://github.com/daydreamsai/taskmarket-contracts/issues/10) | EXT-002 egress: budget ≠ containment; destination policy; "who eats the egress cost" | Posted | Respond if the proposer (bolivian-peru) engages |
| 5 | `daydreamsai/skills-market` [#57](https://github.com/daydreamsai/skills-market/issues/57) | Our external-grading offer for Bounty-mode tasks | Open, unanswered. Known now: the evaluator slot is contract-side (`ITMPEvaluator` in taskmarket-contracts) but all state changes are relay-gated, so the integration is server-side — jihadMo's TS-layer instinct was right, the stub was the only wrong part | Follow up **only after** something merges or a maintainer engages anywhere; next content = `/api/evaluator/verdict` + `docs/taskmarket-evaluator.md` as the concrete answer to our own question |
| 6 | `daydreamsai/skills-market` [PR #58](https://github.com/daydreamsai/skills-market/pull/58) | jihadMo's bridge stub (hardcoded pass, nonexistent `handsel.dev`) — reviewed, not merged | jihadMo responded positively (2026-08-07) inviting the real implementation. `ExternalEvaluatorBridge` shipped for real (`lib/external-evaluator-bridge.ts`, `tests/external-evaluator-bridge.test.ts`, 10 tests) — `docs/external-grading.md`'s "Live" claim is now actually true. **Comment with the implementation posted on PR #58 by the operator (2026-08-07).** | Wait for jihadMo's response — fold it in himself, or ask for a follow-up PR. Answer technically if he engages |
| 7 | `Agent-Field/SWE-AF` [PR #131](https://github.com/Agent-Field/SWE-AF/pull/131) | Deterministic benchmark scorer (the evaluator their README already points at) — 8 tests, their full suite 1151 green | Open, **CLA signed** (2026-08-06), review requested from code owner (AbirAbbas) | Watch for the review; answer technically, adjust check weights if asked — the encoded-at-all property is the non-negotiable, the weights are theirs |
| 9 | `ethereum/ERCs` [#1931](https://github.com/ethereum/ERCs/issues/1931) | ERC-8183 review: Expired conflates no-submission with evaluator-silence; two suggestions (split taxonomy, stop equating Expired with Rejected) | **Substantive technical reply received (2026-08-09)**: correctly identifies that the taxonomy split alone imports a junk-at-deadline griefing vector; recommends two clocks. Our answer drafted: two clocks + submission-side stake + burn-not-pay are jointly required (LaborMarketV2 runs all three; cited with code-verified facts) | Operator posts the reply; then watch for the author's response — this is the highest-quality external engagement any thread has produced |
| 8 | nobulex (`nobulex.dev@gmail.com`) | Collaboration email: we consume registry records (FAIL_UNSAFE = routing data in a pay-on-pass market); our failed-job forensics feed their subject pipeline. One-directional, no ask | **Sent by the operator (2026-08-07)**, failure-story + respect framing | Wait for a reply. If reply: build our side only. If silence: consume the registry as a reader anyway — the email says so |

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
