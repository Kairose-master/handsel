# CLAUDE.md — repo guide

Orientation for an AI (or human) working in this repo. Read this first.

## What this is

**Handsel** — a labor market where AI agents hire, work for, and extend
credit to other AI agents. On-chain escrow, independent grading,
pay-only-on-pass, a signed proof per deliverable, and a credit score earned
from real behavior that unlocks borrowing.

**Three public deployments — treat every money path as real money** (see
`docs/deployments.md` for the full matrix, and `/api/tasks` on each URL for the
authoritative `environment` / `chainId` / `realMoney`):

- **Mainnet** (this repo's production): https://handsel-main.vercel.app —
  Base mainnet, **real Circle USDC**, `LaborMarketV2`
  `0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c`, fee 5% + $0.03, worker bond
  5% + $0.03, pull payments, gas self-paid (`PAYMASTER_DISABLED=true`).
  Live since 2026-07-30. GitHub App (`handsel-main`) live since 2026-08-03 —
  one App per repository, see `docs/github-jobs.md`. NOT on mainnet:
  vault/lending, on-chain governance, minting.
- **V2 rehearsal** (this repo, Base Sepolia): https://handsel-nu.vercel.app —
  chain 84532, faucet test USDC with **no monetary value**, `LaborMarketV2`
  `0xd9bcf1740d4721988ec2c579e2ec71d0eb904a09`, sponsored gas. **This is where
  V2 changes get tested** — the mainnet contracts were byte-verified against it.
- **V1 archive** (separate repo): https://ai-agent-credit-dashboard.vercel.app —
  Ethereum Sepolia, MockUSDC, zero value, sponsored gas, mint faucet. A
  different product on a different contract, not a staging environment for this
  repo.

Never hardcode "testnet" or "mainnet" in UI or copy — derive from
`isRealMoney()` / `CHAIN.name` (`lib/onchain/real-money.ts`), and route the
copy through `lib/money-label.ts`. This rule was asserted for months and broken
on the landing page the whole time (§26); `tests/money-label.test.ts` now
enforces it.

## Stack & layout

- **Next.js 16** App Router (`app/`), server actions, Vercel-hosted.
- **Neon Postgres** + drizzle (`lib/db/`); many tables self-migrate on first use.
- **viem** + ERC-4337 Kernel v3.1 smart accounts (`lib/onchain/`). ZeroDev's
  URL serves the **bundler** role (`BUNDLER_RPC`/legacy `ZERODEV_RPC`); the
  paymaster is separate (`lib/onchain/paymaster.ts`) and OFF on mainnet —
  agents self-pay gas from small ETH floats. Escrow via `LaborMarketV2` in
  Circle USDC on Base (MockUSDC + v1 LaborMarket on the testnet sandbox).
- **Tauri (Rust) desktop miner** (`desktop/`) — a worker client. Released via
  the `desktop-v*` tag → `desktop-release.yml` GitHub Action.
- **Minecraft spectacle** — split into its own repo (was `minecraft/` here);
  polls the public API read-only and renders open jobs as holograms.
- **MCP connector** (`app/api/mcp/`) — Streamable HTTP + OAuth 2.1; the same
  market from inside Claude/ChatGPT. Runs both directions: hire a swarm, *and*
  register any external MCP server as a gradeable worker (`lib/mcp-client.ts`).
- **Thin SDK** (`sdk/`) and a headless worker script (`public/`).
- **Contracts** in `contracts/` (Solidity, solc-compiled to committed
  ABI+bytecode artifacts so the server deploys without solc).

| I want to… | look in |
|---|---|
| Solana devnet port (Eternal sprint) — scope, cuts, invariant map, write path | `solana/`, `docs/solana-port.md`, `lib/onchain/solana/` (codec/read/tx/write), `/solana` board (live audit panel), `POST /api/admin/solana-loop` |
| Delegation / agent-to-agent collaboration | `lib/delegation.ts` |
| The readable collaboration DSL | `lib/collab-dsl.ts` |
| Trust gates as decision tables (DMN) | `lib/decision-table.ts` |
| Escrow settlement / auto-release | `lib/labor-settle.ts` |
| Credit scoring + reputation lending | `lib/credit-rules.ts`, `lib/reputation-lending.ts` |
| Who else is building this, and where we sit | `docs/competitive-landscape.md` — ERC-8004/8183, the nearest products, and what a landscape pass does *not* change |
| **What this product actually claims, and what isn't built** | **`docs/product-thesis.md`** — the narrow claim (escrow-collateralized advance), verifiability vs portability, and the two gaps |
| The machine lane: permissionless operatorship of physical machines | `docs/physical-operatorship.md` — thesis, three archetypes (all with shipped booth software: recipe market, slot market, `[machine:plot]` labor lane), operatorship's necessary-and-sufficient conditions, increments 3 (x402 `split` param) and 4 (**operator** credit — a rolling bond withheld from earnings) shipped, plus increment 5 (the machine as requester, hiring its own restocking) and the evidence-class ladder |
| **How strong must evidence be before it can take someone's money** | **`lib/evidence-assurance.ts`** — the 5-dimension assurance vector → E0–E4 → maximum permissible remedy. Nothing below E3 moves money, so no semantic/LLM judgment can slash alone. Consulted by `lib/dispute-gate.ts`: `NO_DELIVERABLE` and `WRONG_KIND` can no longer refund |
| Agents that don't trust each other sharing one workspace | `docs/coordination-layer.md` (v0.2) — design + critique + the layer split: the institutional half extends Handsel, the execution-supervision half is a separate runtime, because hosting execution inverts this repo's "we don't run your code" model. **Read the critique before the design.** Increment 1 shipped; sessions/capabilities/conflict machine/supervisor not built |
| The portable evidence format the layers meet at | `docs/action-receipt-v0.1.md` — draft spec, **zero issuers**. Carries `observationDomain` (what the observer could NOT see), so the attribution claim is "actions mediated by declared boundaries", never "all privileged actions" |
| Prime orchestration risk → LTV | `lib/orchestration-risk.ts` |
| The v2 contract (shipped — deployed to Base mainnet 2026-07-30) | `docs/v2-plan.md` (the plan) · `docs/mainnet-kernel-runbook.md` (live addresses + config) |
| Which deployment is which / what's live where | **`docs/deployments.md`** · `docs/deploy-testnet.md` · `docs/mainnet-deploy.md` |
| The "take my money" public challenge (draft, unpublished) | `docs/open-challenge.md` |
| Signed work proofs (EAS-style) | `lib/attestation.ts`, `lib/work-proof-store.ts` |
| On-chain reads/writes | `lib/onchain/*` |
| DeFi sandbox (collateral→debt) | `lib/mini-vault.ts`, `contracts/MiniVault.sol` |
| Bring any external MCP agent in as a worker | `lib/mcp-client.ts`, `docs/external-agents.md` |
| **Which real MCP servers actually work as workers** | **`docs/office-connectors.md`** — the four probed, the ones rejected and why, and the measurement behind `[mcp-query]` |
| Running the office once, end to end | `docs/verify-cloud-options-desk.md` — the exact env this desk needs, what each stage proves, and what is untested |
| GitHub repo jobs (diff → PR, CI grades, merge pays) | `lib/repo-jobs.ts`, `lib/github-app.ts`, `app/api/github/webhook/`, `docs/github-jobs.md` |
| Red-team jobs (a canary proves the break-in; the poster must prove the target) | `lib/redteam.ts`, `lib/redteam-grade.ts`, `app/api/redteam/`, `docs/redteam.md` |
| **Pluggable graders** (a grader is a money authority; no containers) | **`docs/graders.md`** — design only, nothing built |
| Grading for OTHER platforms (what we expose vs refuse, and why) | **`docs/external-grading.md`** — `/api/grade` (LLM lane) is live; arbitrary external code execution is refused on the current sandbox |
| **Verifying a work proof without trusting us** (interop) | **`docs/verifying-proofs.md`** — `GET /api/attestation` (recipe) + `GET /api/proof/<id>` (JSON) → recover the EIP-712 signer locally. v1 proves provenance; **v2 additionally signs an evidenceHash** (spec + deliverable + grader class, canonical JSON) so third parties re-derive — mechanically for mechanical classes, as an independent opinion for the model class |
| **Being the evaluator on someone else's market** | **`docs/taskmarket-evaluator.md`** — `lib/taskmarket-evaluator.ts` maps a grade onto ERC-8195 `evaluate()` args, anchoring our proof hash in their `evidenceHash`. We never broadcast (their relay is the only sender), and `passed: null` submits nothing so *our* stake burns, not the worker's pay |
| **"Pay for the result, not the attempt" — the build service** | **`docs/build-service.md`** — increments 1–3 shipped: envelope/manifest/gate (pure), `POST /api/build` (repo lane, real escrow via `postRepoJob`), and `GET /api/build/<id>` (the read side — manifest assembled fresh from the on-chain job status per read) |
| **Every external thread (PRs, comments, emails) and its state** | **`docs/interop-outreach.md`** — the outreach ledger. Update it when a thread moves; standing rules (verify-before-posting, one venue per community, artifacts must survive being ignored) live there |
| **Paying for judgment, not just completion** | `lib/brief-refusal.ts` (live), `lib/judgment.ts` (pure core, unwired), **`docs/judgment.md`** |
| **A worker contesting a verdict** | `lib/appeal.ts`, `lib/appeal-resolve.ts`, `lib/appeal-panel.ts`, `app/api/jobs/appeal/`, **`docs/appeal.md`** — recompute route live; panel core tested but unconvened |
| **The contract object — what is binding vs merely asserted** | **`lib/agent-contract.ts`** — provenance per field (`sealed`/`chain`/`platform`); the specHash commits nine fields and nothing else |
| Account-owned gas pool (local paymaster) | `lib/local-paymaster.ts` |
| N-slot parallel block mining | `lib/auto-mine.ts`, `lib/mining-scheduler.ts`, `lib/concurrency.ts`, `docs/parallel-mining.md` |
| Capability directory (ClawHub) | `lib/clawhub.ts`, `app/directory/page.tsx` |
| Public/guest landing | `app/guest/page.tsx` |
| The live spectacle (shareable, no-login) | `app/live/page.tsx` |
| Zero-login demo | `app/try/page.tsx` (English — no hardcoded locale) |
| **Something is stuck / money didn't move** | **`docs/failure-modes.md`** — every real production defect, its root cause and fix, plus which page to check first |
| Is this path safe / who can reach it | `docs/security-audit.md` — threat model, findings by severity, residual risk. Read before touching a money or prompt path |
| Background sweeps (one list, cron + traffic driven) | `lib/ops-cycle.ts`, `lib/ops-lease.ts` |
| Collecting the protocol fee — the one balance no sweep touches | `docs/fee-withdrawal.md`, `scripts/fee-withdraw.mjs` (read-only unless `--send`) |
| **Reading ERC-4337 / ERC-8004 against this code** | **`docs/spec-reading-guide.md`** — spec concept → the file it already runs in |
| Setup self-check | `app/(dashboard)/doctor/page.tsx`, `lib/github-doctor.ts` |

## The collaboration layer (read `docs/collaboration.md`)

Delegation decomposes a goal into escrowed subtasks worked by independent
agents. Four primitives make it real collaboration, not parallel isolation:

1. **Handoff** (`dependsOn`) — a subtask is held back until its dependency
   completes, then that dependency's **real output** is injected into the
   worker's brief. Wave-scheduled in `tickDelegation`.
2. **Peer review** (`reviewOf`) — a *different* agent reviews a deliverable;
   the target's escrow is **held** until the peer returns APPROVE (self-review
   is discarded; REVISE routes to the owner).
3. **Synthesis** (`synthesizes`) — a worker reads the actual pieces and weaves
   one coherent deliverable; its output *is* the result (not concatenation).
4. **Subcontract** (`subcontract`) — a piece is expanded one level into a child
   sub-plan + a synthesis (`expandSubcontracts`), always within its bounty.

**Four representations of the same graph** (a deliberate layering):
- **JSON** = canonical wire format (what the planner emits, what's stored).
- **Collab DSL** (`lib/collab-dsl.ts`) = readable coordination layer *on top*;
  each worker's brief carries a compact plan so it knows where its piece fits.
- **DMN decision tables** (`lib/decision-table.ts`) = the trust gates
  (auto-release, reputation ceiling) as auditable rules — `decideAutoRelease`
  is the authority the settlement path actually calls, so table = behavior.
- **BPMN** = a process view (static today in `lib/bpmn/`; a generator is a TODO).

## Conventions (important)

- **No fake data, ever.** Every number on a page is a live query. New agents
  start at a real cold start (score 0). Don't seed or stage.
- **JSON stays canonical.** New readable layers (DSL, DMN, BPMN) are
  *projections* of it, never replacements — don't make the planner LLM emit a
  bespoke format; keep it on JSON and derive the rest.
- **Optional on-chain.** Features degrade gracefully without their env
  (`X402_PAY_TO`, `ONCHAIN_*`, HF token…) — mirror that pattern.
- **Secrets** live in an encrypted `platform_secrets` KV, never in the repo or
  `.env` commits. Echo only last-4.
- **i18n**: user-facing strings go through `lib/i18n`; run `npm run i18n:check`.

## Build / test / verify

- **`npm run gates`** — typecheck → lint → test → build, one command that
  cannot be half-passed. Run this before every commit rather than the four
  separately. It exists because the four *were* run separately and piped into
  `grep` to shorten the output — and `grep`'s exit status replaced vitest's, so
  a red suite got pushed under a green read. Same defect as the `tee` in
  `solana-devnet.yml` and the `bump` nothing wrote: **a check that cannot fail
  is not a check.** Never pipe a gate.
- `npm run test` — vitest (currently 136 files, ~1,784 tests). The pure logic
  (planner parse/validate, DAG, DMN, DSL round-trip, assembly, block-mining
  scheduler, `mapLimit`, MCP client parse, ClawHub normalize) is unit-tested;
  **prefer adding pure functions + tests over untested tick/on-chain code.**
- `npm run lint` — ESLint (flat config `eslint.config.mjs`) and
  `npx tsc --noEmit -p tsconfig.json` — both are build gates; keep them green.
- `npm run test:coverage` — vitest with coverage.
- Desktop: `cd desktop/src-tauri && cargo check`.
- Solana program: `cd solana && cargo check` — **devnet only** (a decision,
  not a gap: `docs/solana-port.md`). Deploying needs `cargo-build-sbf`, an
  operator/CI step, not an in-repo one.
- **Verify by running, not just testing** — pure end-to-end runs have caught
  real bugs unit tests missed (e.g. synthesis-vs-subcontract assembly).

## Environment gotchas

- Outbound HTTPS goes through an agent proxy. `curl` works; **chromium can't
  traverse it** (use `next dev`/`next start` on localhost for screenshots).
- The git proxy **allows branch pushes but 403s tag pushes**, and the GitHub
  MCP integration lacks `actions:write` — desktop releases must be triggered
  from the GitHub web UI (create the `desktop-v*` tag there).
- `edge-tts` needs `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt` + `--proxy`.

## Git workflow

Develop on the designated feature branch, `tsc`+`test` green, commit, then
fast-forward `main` and push both. Never leave `main` broken. Don't open a PR
unless asked.
