# CLAUDE.md — repo guide

Orientation for an AI (or human) working in this repo. Read this first.

## What this is

**Handsel** — a labor market where AI agents hire, work for, and extend
credit to other AI agents. On-chain escrow (Sepolia testnet USDC), independent
grading, pay-only-on-pass, a signed proof per deliverable, and a credit score
earned from real behavior that unlocks borrowing.

Live: https://ai-agent-credit-dashboard.vercel.app · solo-built · **testnet
only, no real money.**

## Stack & layout

- **Next.js 16** App Router (`app/`), server actions, Vercel-hosted.
- **Neon Postgres** + drizzle (`lib/db/`); many tables self-migrate on first use.
- **viem / ZeroDev** smart accounts (ERC-4337, gas-sponsored) on Sepolia
  (`lib/onchain/`). MockUSDC escrow via a LaborMarket contract.
- **Tauri (Rust) desktop miner** (`desktop/`) — a worker client. Released via
  the `desktop-v*` tag → `desktop-release.yml` GitHub Action.
- **Minecraft spectacle** (`minecraft/`, Paper 1.21 plugin) — polls the public
  API read-only and renders open jobs as in-world holograms (see its README).
- **MCP connector** (`app/api/mcp/`) — Streamable HTTP + OAuth 2.1; the same
  market from inside Claude/ChatGPT. Runs both directions: hire a swarm, *and*
  register any external MCP server as a gradeable worker (`lib/mcp-client.ts`).
- **Thin SDK** (`sdk/`) and a headless worker script (`public/`).
- **Contracts** in `contracts/` (Solidity, solc-compiled to committed
  ABI+bytecode artifacts so the server deploys without solc).

| I want to… | look in |
|---|---|
| Delegation / agent-to-agent collaboration | `lib/delegation.ts` |
| The readable collaboration DSL | `lib/collab-dsl.ts` |
| Trust gates as decision tables (DMN) | `lib/decision-table.ts` |
| Escrow settlement / auto-release | `lib/labor-settle.ts` |
| Credit scoring + reputation lending | `lib/credit-rules.ts`, `lib/reputation-lending.ts` |
| **What this product actually claims, and what isn't built** | **`docs/product-thesis.md`** — the narrow claim (escrow-collateralized advance), verifiability vs portability, and the two gaps |
| Prime orchestration risk → LTV | `lib/orchestration-risk.ts` |
| The v2 contract rewrite (why a fork, which chain, what gates mainnet) | `docs/v2-plan.md` |
| The "take my money" public challenge (draft, unpublished) | `docs/open-challenge.md` |
| Signed work proofs (EAS-style) | `lib/attestation.ts`, `lib/work-proof-store.ts` |
| On-chain reads/writes | `lib/onchain/*` |
| DeFi sandbox (collateral→debt) | `lib/mini-vault.ts`, `contracts/MiniVault.sol` |
| Bring any external MCP agent in as a worker | `lib/mcp-client.ts`, `docs/external-agents.md` |
| GitHub repo jobs (diff → PR, CI grades, merge pays) | `lib/repo-jobs.ts`, `lib/github-app.ts`, `app/api/github/webhook/`, `docs/github-jobs.md` |
| N-slot parallel block mining | `lib/auto-mine.ts`, `lib/mining-scheduler.ts`, `lib/concurrency.ts`, `docs/parallel-mining.md` |
| Capability directory (ClawHub) | `lib/clawhub.ts`, `app/directory/page.tsx` |
| Public/guest landing | `app/guest/page.tsx` |
| The live spectacle (shareable, no-login) | `app/live/page.tsx` |
| Zero-login demo | `app/try/page.tsx` (English — no hardcoded locale) |
| **Something is stuck / money didn't move** | **`docs/failure-modes.md`** — every real production defect, its root cause and fix, plus which page to check first |
| Is this path safe / who can reach it | `docs/security-audit.md` — threat model, findings by severity, residual risk. Read before touching a money or prompt path |
| Background sweeps (one list, cron + traffic driven) | `lib/ops-cycle.ts`, `lib/ops-lease.ts` |
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

- `npm run test` — vitest (currently 60 files, ~553 tests). The pure logic
  (planner parse/validate, DAG, DMN, DSL round-trip, assembly, block-mining
  scheduler, `mapLimit`, MCP client parse, ClawHub normalize) is unit-tested;
  **prefer adding pure functions + tests over untested tick/on-chain code.**
- `npm run lint` — ESLint (flat config `eslint.config.mjs`) and
  `npx tsc --noEmit -p tsconfig.json` — both are build gates; keep them green.
- `npm run test:coverage` — vitest with coverage.
- Desktop: `cd desktop/src-tauri && cargo check`.
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
