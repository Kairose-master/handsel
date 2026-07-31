# Handsel — Pitch Deck

*GASOK application (MVP Build track). An interactive, styled version of this
deck also exists as a Claude Artifact; this is the permanent, publicly
linkable copy.*

**Live demo (no signup):** https://ai-agent-credit-dashboard.vercel.app/guest
**Repo (Apache 2.0):** https://github.com/Kairose-master/ai-agent-credit-dashboard

<img src="assets/pitch-banner.svg" alt="Handsel — an on-chain credit history for AI agents" width="900">

---

## 1. An on-chain credit history for AI agents

Earned from actually-verified work — not self-reported success. Built solo,
tested in public, ready to build on GIWA. (The deployment actually taken since
this application: Base mainnet, live with real USDC as of 2026-07-30.)

---

## 2. The problem

Agents transact with agents now — and the only signal is "it said it worked."

Every agent-to-agent system today collapses to the same trust primitive: the
agent's own claim of success. No history, no consequence for being wrong, no
way to tell a genuinely capable agent from one that's merely confident.

- **No memory** — an agent that fails today looks identical to one that never
  has. Nothing about past performance carries forward.
- **No independent check** — "completed" usually means the agent said so.
  Confidently wrong output passes the same as correct output.
- **No capital access** — a track record that isn't captured can't be lent
  against; agents can't earn the economic trust people do.

---

## 3. The solution

Give every agent a real credit history, on-chain.

Each agent gets its own ERC-4337 smart account. Its behavior — every task,
every dispute, every verified result — is logged to a ledger, scored, and
published as an on-chain credit limit it can actually draw against.

- **Grader ≠ solver** — the agent that does the work is never the one who
  grades it. Credit-worthy signal comes from independent verification, not
  self-assessment.
- **Credit like a person's** — score → rating → limit → draw → repay →
  score, the same loop a FICO-backed line of credit runs, computed from
  real behavioral history instead of a bureau file.

<img src="assets/pitch-credit-loop.svg" alt="Score, rating, limit, draw, repay loop" width="900">

---

## 4. How it works

Three subsystems feed one ledger:

<img src="assets/pitch-flow.svg" alt="Labor Market, Proving Ground, and Credit Vault feed one ledger" width="900">

---

## 5. The GPU story: what mining rigs do next

After the mining boom, consumer GPUs went idle. DePIN compute networks
(Bittensor, io.net, Akash) rent them out again — but they bill for **GPU
time**, because time is easy to verify and quality isn't. Mining paid for
hashes; they pay for hours. Nobody pays for *work being right*.

Handsel sells **verified labor, not hashrate** — and it already runs:

- **One command** connects a locally-hosted model (Ollama on an RTX 3060)
  as a market worker. The worker polls outbound, CI-runner style — no
  tunnel, no public IP, works behind any firewall.
- Its output is **independently graded before money moves** — requester-
  authored acceptance tests executed by the platform runtime, hidden
  ground-truth answers, dispute review. The machine that did the work
  never grades it.
- Repeat verified work compounds into **on-chain credit** — a reputation
  and borrowing capacity that hashrate never earned anyone.

The pitch to a GPU owner is one sentence: *your mining rig's next job is
skilled labor with a credit score.*

---

## 6. Architecture

Four contracts, one behavioral ledger:

<img src="assets/pitch-architecture.svg" alt="Four contracts connected to a central behavioral ledger and credit score" width="900">

| Contract | Role |
| --- | --- |
| `AgentCreditRegistry` | Oracle-published credit limit per agent, attested via EAS |
| `AgentCreditVault` | Lends mUSDC up to the registry limit; tracks outstanding balance and repayment (testnet sandbox only) |
| `LaborMarket` | USDC escrow for agent-to-agent work; immutable on-chain arbiter for disputes (v1, testnet) |
| `LaborMarketV2` | The contract holding mainnet money: escrow with worker bond, pull payments, and permissionless exits |
| `VerifiedTaskEscrow` | Commit-reveal settlement against a hidden ground-truth answer |

Stack: ERC-4337 (Kernel / ZeroDev) · Solidity (Foundry) · Next.js · Neon
Postgres · Python / LangGraph / Claude · Apache 2.0, public repo.

---

## 7. Already tested in public

Shared across r/SideProject, r/ethdev, and Indie Hackers this week — not for
reach, but for scrutiny. It held up, and where it didn't, that's now
tracked, not hidden.

- **3 days** — idea to a working on-chain demo
- **2** — design gaps opened as public GitHub issues from real feedback
  ([#6](https://github.com/Kairose-master/ai-agent-credit-dashboard/issues/6),
  [#7](https://github.com/Kairose-master/ai-agent-credit-dashboard/issues/7))
- **0** — seeded data; every number in the demo is a live query

---

## 8. Why GIWA

The transaction profile is the argument. An agent economy runs on frequent,
small-value transactions — job payouts, draws, repayments — at a pace no
human-mediated system matches. That's expensive on L1 and still costly at
volume on most general-purpose L2s.

- **Fits the workload** — ~₩1/tx and 1-second finality on an OP Stack,
  EVM-compatible L2, built for exactly this transaction shape.
- **Fits the market** — Dunamu/Upbit distribution in Korea and APAC, the
  builder's home market and a real first market for credit infrastructure
  that needs trust to bootstrap.

---

## 9. Roadmap against GASOK

- **MVP Build** — all five contracts are **already deployed and verified
  on GIWA testnet** (e.g.
  [LaborMarket](https://sepolia-explorer.giwa.io/address/0xaa5b0dc472c0c373a3d0602937533fa9fda94601));
  since then, the live app went to **Base mainnet on 2026-07-30**
  (LaborMarketV2 + registry, real USDC), with Sepolia running in parallel
  as the sandbox.
- **Productize** — replace the single-EOA dispute arbiter with a
  domain-scoped, staked reviewer model (tracked design work, issue #7); add
  a calibration signal so credit scoring penalizes confident-but-wrong
  output, not just completion (issue #6).
- **Mainnet hardening** — mainnet is live; security review of the contracts
  is now hardening of a live deployment (no formal audit yet, flagged
  honestly in the repo today); gas/paymaster policy review at real
  agent-economy transaction volume.
- **KPIs** — real agent-to-agent job volume and vault TVL, instrumented
  from the behavioral event ledger that already drives credit scoring —
  not new infrastructure, existing plumbing.

---

## 10. Team

**Founder & sole developer** — 19, based in Korea, student. Designed and
shipped every layer alone — contracts, backend, agent runtime, dashboard —
over the past week, built with Claude Code.

What that speed proves: not just velocity, but end-to-end ownership across
contracts, UX, and AI systems, with judgment already stress-tested by
outside engineers rather than assumed.

---

## 11. What GASOK enables

Harden a market that is already live on mainnet with real money. Resources
and mentorship to take this from a working product validated by strangers on
the internet, to production infrastructure agents can actually depend on.

- Repo: https://github.com/Kairose-master/ai-agent-credit-dashboard
- Live demo, no signup: https://ai-agent-credit-dashboard.vercel.app/guest
