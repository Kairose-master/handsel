# Surface audit — every route, script and external path, classified

Taken 2026-08-06 as the precondition for the Nocturne UI overhaul: you cannot
promise "no functionality lost" without first writing down what the functality
*is*. This is that inventory. Rule inherited from the outreach ledger: an
unclassified surface is a surface that gets dropped.

**2026-09-04: the counts below are stale (57 `page.tsx` files, 92
`route.ts` files today) and this pass did not re-walk the full inventory —
only what shipped this session is classified here, by this rule.** New
surfaces since the 2026-08-06 pass, not yet folded into the sections below:

- `/repo-care` — public landing + free diagnostic (`app/repo-care/page.tsx`,
  `components/repo-diagnostic.tsx`). Nav-reachable from nowhere in the deck
  (it is a public page, outside the dashboard shell) — reached from outbound
  links and `/office/sessions`'s Repo Care card. Its own action,
  `app/actions/repo-diagnose.ts`, is deliberately unauthenticated — see
  `docs/security-audit.md`'s note on the same surface.
- `/office/repo-care` — the guided onboarding wizard
  (`app/(dashboard)/office/repo-care/`). Dashboard-shell-gated by the
  `office` path segment; linked from `/repo-care`'s diagnostic result.
- `/admin/pilots` — operator-only, `billing` permission
  (`lib/admin.ts`), reads `pilot_lead`. Direct-URL by design, same pattern
  as `/admin/disputes` above.
- `POST /api/webhooks/lemonsqueezy` — headless-by-design, documented in
  `docs/billing.md`, HMAC-verified before parsing.
- A full re-walk of the other ~20 new pages and ~20 new API routes (office
  sessions, autonomy console, social desk, and more) is still owed — this
  note only closes the gap for what this specific pass touched.

## Pages (35 as of 2026-08-06; 57 today, not re-audited) — reachability

**Nav-reachable (dashboard shell):** `/`, `/guide`, `/agents`, `/jobs`,
`/delegate`, `/mine`, `/settings` + Advanced group: `/credit-scores`,
`/transactions`, `/messages`, `/verify`, `/risk`, `/insurance`, `/governance`,
`/world`, `/directory`.

**Linked from pages/flows (in-code references verified):** `/agent/[id]`,
`/connect`, `/disputes`, `/doctor`, `/examples`, `/guest`, `/live`,
`/profile`, `/proof/[id]`, `/sign-in`, `/sign-up`, `/start`, `/try`,
`/oauth/authorize`, `/challenge`, `/admin/access`, `/admin/credit-rules`.

**⚠ Orphans found (0 in-code references):**

| Route | What it is | Disposition |
|---|---|---|
| `/admin/disputes` | Working admin review page for disputed jobs (`getDisputedJobs`) | **Keep** — operator tool, direct-URL by design, but it predates `/disputes` and the overlap should be reconciled eventually. Recorded, not deleted |
| `/market-health` | The public honest-numbers page | ~~Not linked from anywhere in the app~~ **Fixed in Phase 3**: the sidebar network-status card is now `<Link href="/market-health">` — same numbers it already summarizes, linked to the page that publishes them in full |

## API routes (~70 as of 2026-08-06; 92 today, not re-audited) — classification

- **UI-consumed:** agents/tasks/jobs/delegations/worker/wallet/world/vault/me —
  exercised by the pages above (fetch calls verified by grep).
- **Headless-by-design (documented in docs/, not UI-linked — correct):**
  `/api/grade`, `/api/evaluator/verdict`, `/api/attestation`,
  `/api/proof/*`, `/api/tasks`, `/api/agents/register`, `/api/mcp`,
  `/api/oauth/*`, `/api/github/webhook`, `/api/redteam/*`, `/api/repo/ci-bounty`,
  `/api/x402/live`, `/api/capabilities`, `/api/fleet`, `/api/market/index`.
- **Ops/cron:** `/api/cron/settle`, `/api/runtime/*`, `/api/admin/*` (13 routes,
  token-gated). `/api/admin/demo-negotiation` and `/api/admin/post-image-jobs`
  are the staleness candidates here — both still referenced by ops docs, kept.
- **Verdict: no dead API routes.** Every route is UI-consumed, documented
  headless, or an ops tool.

## scripts/ (21) — 0-reference entries, classified not deleted

`compile-evm-fixtures.mjs`, `compile-labor-v2.mjs`, `deploy-governance-poll.mjs`,
`migrate-agents-to-kernel.mjs`, `recover-agent-funds.mjs` have zero references
from package.json/CI/docs. All five are **operational one-shots** (compile
artifacts, one-time migration, emergency fund recovery). `recover-agent-funds`
especially is exactly the script you want findable in an emergency —
**disposition: keep, now referenced from this doc** so they are no longer
unreferenced.

## External paths — findings

| Path | Where | Verdict |
|---|---|---|
| `sepolia.etherscan.io` ×3 | `verify/page.tsx` initial state (server data replaces it on load), `config.ts` fallback, `feed-meta.ts` per-chain map | Benign: keyed/fallback values, not user-facing assertions. Initial-state flash on /verify noted, not worth churn |
| `ai-agent-credit-dashboard/releases` ×2 | MCP guide (desktop download) | **Correct today** — handsel has zero GitHub releases, so the v1 repo is genuinely where the binaries are. Must flip when `desktop-v*` first runs on this repo |
| `clawhub.ai` ×3 | directory read client | Deliberate (OpenClaw's registry; see competitive-landscape correction) |
| groq/openrouter/hf/pollinations/google-tts | model + media lanes | Feature dependencies, env-gated, degrade gracefully per repo convention |
| `sepolia-rpc.giwa.io` / explorer | chain config | GIWA testnet rehearsal lane (pitch deck §8) |

## The overhaul contract

The Nocturne/Sage restyle (design handoff 2026-08-06) touches **tokens,
shell chrome and card presentation only**. The functionality baseline it must
not regress is: 16 nav destinations, 17 linked flows, 2 recorded orphans, ~70
API routes, all forms/actions on `/jobs`, `/delegate`, `/mine`, `/settings`,
`/credit-scores`. Any restyle commit that changes an action handler, form
field, fetch call or i18n key is out of scope by definition and needs its own
commit with its own reasoning.

## Phase 3 note — scope cut, stated not silently taken

The mockup's screen spec covers 2a (Dashboard), 2b (Labor Market), 2c (Credit
Scores). 2a and 2c were restyled — both are small (240 and 135 lines) and
every change was a className addition to existing JSX, nothing structural.
**2b (`app/(dashboard)/jobs/page.tsx`, 992 lines) was deliberately left for a
separate pass.** It's the page with the actual money buttons (Approve & pay,
Dispute, Accept job, the escrow/bounty form) and the template marketplace —
the highest blast-radius surface in the whole app, and the file is 4x the
size of the other two combined. Restyling it in the same sweep as the small
pages would have meant reviewing money-path JSX at the same speed as
navigation copy. It gets its own pass, its own gates run, and its own visual
check before anything in it changes.

## Phase 4 — app-wide glass-card sweep

Every remaining page (25 files beyond 2a/2b/2c) swept for the same card-shell
convention (`rounded-{md,lg,xl,2xl} border border-border p-{3..8}`, either
attribute order) and given `glass-card`. Element-scoped to `<div>` only —
verified by a first pass that caught a `<textarea>` false positive (reverted)
before re-running restricted to div tags. `<Link>`/`<a>`-based cards
(agents.tsx roster, a few empty-state paragraphs, `<pre>` log blocks) were
excluded from the automated pass by design; one (`agents/page.tsx`, mirrors
the dashboard-home agent list already styled in Phase 3a) was patched by hand
to match. `lift` was NOT swept automatically — several pages already hand-code
their own hover transform (`mine.tsx`, `guest.tsx`: `hover:-translate-y-0.5`)
and stacking a second transform risked visual conflict; only Phase 3's
explicitly-reviewed list-item cards carry it.

81 total `glass-card` insertions across 23 files, every one verified via
`git diff` to be a className-only change (79+2 insertions, matching deletions,
zero other lines touched). Visually confirmed on `/guest` (full-page
screenshot, Nocturne dark) — consistent sheen across every card, no layout
regressions, no overlaps.
