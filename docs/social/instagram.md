# Instagram publishing — architecture, setup, limits

The official-API integration behind the Social Desk. Editorial spec:
`docs/social/instagram-brand.md`. Skill: `.claude/skills/instagram-publisher/`.

**Policy first:** this integration uses the **official Instagram Platform
content-publishing API only** (`graph.instagram.com` / `graph.facebook.com`).
No private endpoints, no password/session automation, no browser bot — if the
official API cannot do something (see Limitations), the answer is "it can't
be automated", not a workaround that risks the account.

## Architecture

```
asset (already on a public https URL — e.g. Vercel Blob)
   │
   ▼
SocialJob row (social_jobs table, lib/social/social-queue-server.ts)
   DRAFT → APPROVAL_REQUIRED → READY/SCHEDULED         ← humans only
   │            approve() records WHO + a payload fingerprint
   ▼
ops-cycle step `socialQueue` (atomic claim; NOT fast)
   QUEUED → PREPARING → UPLOADING → PROCESSING → PUBLISHING → PUBLISHED
   │                                            failures: FAILED · EXPIRED · NEEDS_AUTH
   ▼
lib/social/instagram-publisher.ts  (provider: queue vocabulary ↔ Graph API)
   ▼
lib/social/instagram/*  (containers → poll status → media_publish)
   ▼
media id + permalink stored back on the job
```

- **`lib/social/social-job.ts`** — pure: statuses, transitions, payload
  validation, approval fingerprint, the one retry rule. `SocialJob` is the
  platform-agnostic abstraction; `SocialPublisher` is the provider
  interface. Adding TikTok/X later = a new provider, not a new job system.
- **`lib/social/social-queue-server.ts`** — the queue: self-migrating
  `social_jobs` table, atomic claims (two ticks cannot both take a job),
  stuck-job reaping, checkpoint persistence.
- **`lib/social/instagram/`** — the API client, zero dependencies:
  `client` (one fetch door: Bearer-header auth, retries with exponential
  backoff for transient failures ONLY), `errors` (the taxonomy that decides
  what may retry), `containers`, `publish` (duplicate guard), `carousel`,
  `reels`, `stories`, `status`, `quota`, `auth`, `insights`, `types`.
- **UI:** `/social` (Social Desk, dashboard nav → Advanced). Office view:
  an agent attached to an in-flight social job appears at the **Market**
  gate of the diorama (`lib/office-functional-departments.ts`,
  `socialPublishing` signal).

### Idempotency / duplicate-publish prevention

`media_publish` is the one non-idempotent call, so it is guarded three ways:

1. the tick claims a job with `UPDATE … WHERE status IN (claimable)` —
   concurrent ticks cannot both run it;
2. the container id is checkpointed the moment it exists — a retry resumes
   that container instead of creating a second post;
3. `publishContainerSafely` reads the container's status before (and after
   a failed) `media_publish` — a container that already reads PUBLISHED is
   never published again; the existing media id is recovered instead.

### Retry policy

- Transient (network, 5xx, 429, Graph codes 1/2/4/17/32/613): exponential
  backoff in the client (1s·2s·4s), then requeue up to
  `MAX_PUBLISH_ATTEMPTS` (4) across ticks.
- Auth (OAuthException / 190 / permission codes): **never retried** — job
  parks at `NEEDS_AUTH` until the token is fixed.
- Validation (code 100 etc.): fails on the first strike — a replay cannot
  succeed.
- Container `ERROR`/`EXPIRED`: job parks at `EXPIRED`, dead checkpoint
  discarded; explicit requeue starts a fresh container.
- Quota full: **deferred** — requeued without burning an attempt.

## Dependency evaluation (why the client is hand-rolled)

Four candidates were inspected before writing `lib/social/instagram/`:

| Project | Verdict | Why |
|---|---|---|
| `fbsamples/reels_publishing_apis` (Meta official) | **Reference only** | Sample apps, not a library; Meta Platform Policy licence (not standard OSS); demonstrates the container flow we implement directly. |
| `Inoue-AI/Inoue-AI-Instagram-SDK` | **Rejected** | Official Graph API and good surface (containers, polling, insights), but Python/Go in a TypeScript repo, and effectively unadopted (0 stars, 3 commits) — too young to be a money-path dependency. |
| `mcpware/instagram-mcp` | **Rejected as a dependency** | MIT, official Graph API, 23 MCP tools — credible, but it is a separate MCP *process* aimed at interactive use. The queue needs an in-process library inside the ops cycle; wrapping an MCP server there adds a runtime and an auth hop for zero gain. Viable as an operator-side convenience, unnecessary here. |
| `MatthieuThib/pystagram` | **Rejected** | Python; leans on the Basic Display API, which Meta shut down (Dec 2024) — wrong stack and stale API assumptions. |

Decision: **direct official Graph API calls, zero new npm dependencies.**
The publish surface is ~6 endpoints; a dependency would be larger than the
integration. This also matches the repo convention (viem + fetch, no SDK
bloat) and CI's strict pnpm tree (no new package.json entries to verify).

## Meta configuration (operator runbook)

What the operator must do once, in a browser — none of this can be automated:

1. **Instagram account** → convert to a **Professional (Business)** account.
2. **developers.facebook.com** → Create App → type **Business**.
3. Add the **Instagram** product. Two auth routes — pick ONE:
   - **Instagram API with Instagram Login** (recommended; no Facebook Page
     needed). Scopes: `instagram_business_basic`,
     `instagram_business_content_publish` (+
     `instagram_business_manage_insights` for the Analyst reads).
     Host: `graph.instagram.com` (the default here).
   - **Instagram API with Facebook Login** (needed only if the IG account
     is managed through a Facebook Page). Scopes: `instagram_basic`,
     `instagram_content_publish`, `instagram_manage_insights`,
     `pages_read_engagement`. Set `INSTAGRAM_GRAPH_HOST=graph.facebook.com`.
4. Complete the OAuth flow (App Dashboard → API setup with Instagram
   business login → Generate token), exchange for a **long-lived token**
   (60 days, refreshable via `refresh_access_token` once >24h old).
5. Note the **IG account id** (numeric, returned as `user_id` /
   `GET /me?fields=user_id` — not the @username).
6. While the app is in **Development mode** it can only publish to accounts
   with a role on the app — that is exactly right for testing. **App
   Review** (advanced access for the two scopes) is required before
   publishing for arbitrary accounts; for our own account, Standard Access
   with an app role is sufficient.
7. Store credentials **server-side only** — preferred: the encrypted
   platform_secrets KV (`setPlatformSecret('instagram_access_token', …)`
   and `'instagram_account_id'`); fallback: env vars below. Never in the
   repo, never in a client bundle, echoed only as last-4.

### Environment variables

```
INSTAGRAM_ACCESS_TOKEN=   # long-lived token (platform_secrets wins if set there)
INSTAGRAM_ACCOUNT_ID=     # numeric IG professional account id
INSTAGRAM_API_VERSION=    # optional; defaults to the library's pinned version
INSTAGRAM_GRAPH_HOST=     # optional; graph.instagram.com (default) | graph.facebook.com
```

Unset ⇒ the Social Desk drafts and approves but the queue publishes
nothing (jobs park at `NEEDS_AUTH`); everything else is unaffected.

### Media hosting

The API downloads media from a **public https URL** — it does not accept
uploaded bytes (except the separate resumable-upload lane for reels, not
implemented). Use Vercel Blob (`BLOB_READ_WRITE_TOKEN`, already the
attachment store) or any public host. Requirements: images JPEG ≤8MB
(PNG is rejected by some paths — export JPEG), reels MP4 (H.264/AAC,
9:16, ≤90s for feed reels), story video ≤60s.

## Known API limitations (do not design around their absence)

- **100 API publishes per rolling 24h** per account
  (`content_publishing_limit`; carousels count once). The queue checks
  before publishing and defers when full.
- **No native scheduling** — `scheduled_at` is implemented by OUR queue,
  not by Instagram.
- **JPEG only** for feed images on the classic lane; no PNG guarantees.
- **`alt_text` is images only** (not reels, not stories).
- **Stories are plain media** — no polls/stickers/music/links via API.
- **Containers expire** unpublished after ~24h — hence the EXPIRED state.
- Video processing is asynchronous and can take minutes — hence container
  polling with a per-tick budget and resume.
- Insights metric names change across API versions; the defaults in
  `insights.ts` are overridable per call.
- Development-mode apps publish only to accounts holding an app role.
- Meta's recommended container-poll cadence is ~once per minute for up to
  5 minutes; our poll backs off 2s → 30s within a bounded per-tick budget
  and resumes the same container next tick, which stays inside that spirit
  for video while keeping image publishes fast.
- Carousel images are all cropped to the FIRST slide's aspect ratio
  (default 1:1) — export every slide at the same ratio.
- **AI disclosure is supported**: `is_ai_generated=true` self-labels
  AI-generated media (payload field `isAiGenerated`; `--ai-generated` in
  the skill CLI). For carousels the flag goes on the parent container ONLY
  — the API errors if a child carries it, and the code strips it there.
- Facebook-Login route only: an IG account connected to a Page that
  requires **Page Publishing Authorization (PPA)** cannot be published to
  until PPA is completed — complete it preemptively; the API gives no way
  to detect the requirement in advance. (Trial reels `trial_params` and
  partnership-ads labels are also FB-Login-only; not implemented.)

## Testing

```
npx vitest run tests/social-job.test.ts tests/instagram-client.test.ts \
  tests/instagram-containers.test.ts tests/instagram-publish.test.ts \
  tests/instagram-publisher.test.ts
```

All Instagram API traffic in tests goes through an injected `fetchImpl`
(the house DI style) — no network, no global stubs. Full gate: `npm run gates`.

**Live verification (the one unautomatable step):** with real credentials
set, run the skill's doctor + dry-run
(`.claude/skills/instagram-publisher/scripts/`), then publish a single test
image to the development-mode account and confirm the returned permalink.
Until that has been done once, treat publishing as implemented-but-unproven.
