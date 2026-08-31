# Instagram brand specification — Handsel

The official Handsel Instagram presence: what the account claims to be, what
it looks like, and the three content types the publishing system supports.
The machinery that publishes is documented in `docs/social/instagram.md`;
this file is the editorial half.

Two repo rules bind everything below:

1. **No fake data, ever.** Screenshots are real screenshots of the live
   product; numbers in captions are numbers a page actually showed; a
   "verified job result" post links the real work proof
   (`GET /api/proof/<id>`). Never stage a diorama.
2. **Never invent functionality.** Every factual product claim in a caption
   must be true of the deployment it depicts. The shorts-factory Growth
   Office keeps a DO-NOT-CLAIM ledger (`office/research/handsel-model.md`);
   captions follow the same discipline. Money-related copy follows the
   `lib/money-label.ts` rule — say which environment a screenshot shows,
   and never claim testnet activity as real-money traction.

## Account identity

- **Name:** `Handsel — AI Agent Economy`
- **Handle:** `@handsel` if available; fall back `@handsel.ai` / `@handselmarket`.
- **Category:** Software company. The account must be a **professional
  (Business) account** — the content-publishing API does not exist for
  personal accounts.

**Core idea** (the one sentence every piece of content serves):
AI agents can discover work, execute it, verify the result, build
reputation, and participate in an economic network.

**Bio** (Instagram bio, ~150 chars, line-broken):

```
🤖 AI agents hire. Work. Earn. Build credit.
🛡️ Verified work → portable reputation.
🔵 Powered by USDC on Base
🔗 handsel-main.vercel.app
```

The original draft linked `handsel.ai`. That domain is **not verified as
ours** — until it is registered and pointed at the product, the bio links
the live deployment (`PUBLIC_ORIGIN`, currently handsel-main.vercel.app).
Do not print a link we do not control.

## Visual identity — reuse, don't reinvent

There is no second Handsel identity for social. Everything derives from the
design system already in the repo:

- **The mark.** The task brief called it "the H mark"; the actual shipped
  mark (`public/logo.svg`, identical to `app/icon.svg`) is the **ledger
  card**: a dark rounded-square card with faded ruling lines, a light
  upright, and a green verification check as its baseline. That is the
  Handsel mark, and it is what the profile image uses.
- **Profile image:** the ledger-card mark, monochrome white on a pure black
  (`#000`) field, no typography, centered at ~60% of the canvas. (The
  in-app rendering keeps its blue-gray gradient; the avatar flattens to
  white-on-black for legibility at 110px.)
- **Palettes** — the two the product already ships:
  - **"Office Deck" / tactical** (`app/(dashboard)/office/game3d/theme.ts`,
    also the dashboard dark theme): background `#070a0f`, panel `#0d151d`,
    accent cyan `#4fd8ff`, text `#dff4ff`, ok `#57ffb0`, warn `#ffb84f`.
    **This is the default feed look** — product screenshots are taken in
    dark mode and sit naturally on it.
  - **"Quarry"** (`app/globals.css` light theme): off-white `#fbfbfa`,
    ink `#16181a`, sage-teal `#1f5f57`. Used for text-forward cards
    (release notes, quote cards) so the feed alternates dark/light rather
    than being a wall of black.
  - Red (`#b3261e` / `#ff3b3b`) is **reserved for genuine failure states**
    (a REJECTED verdict, a failed job) exactly as in-app — never as a brand
    accent.
- **Glyph language:** the nine department glyphs (`public/dept/*.png`) and
  their spec in `docs/reference-images.md` §G — minimal line icons, uniform
  stroke, rounded caps, no fill, single-colour cyan `#4fd8ff`, readable
  small, **no text inside the artwork**. New social-only icons follow the
  same prompt language.
- **Typography on cards:** system monospace for numbers/addresses (as the
  app renders them), the default sans for everything else. Captions carry
  the words; images stay near-wordless.

## Highlight system

Six pinned highlights, each covered by an existing department glyph or an
office card (`public/office-cards/*.png`) so the profile row reads as one
system:

| Highlight | Cover art source | What goes in it |
|---|---|---|
| Office | `dept/strategy.png` style | Diorama clips, office lifecycle, the nine rooms |
| Agents | `dept/skills.png` style | Agent profiles, lineage, credit scores earned |
| Harness | `dept/engineering.png` style | Code Harness runs (plan→code→test→review→deploy) |
| Local Jobs | `dept/market.png` style | The jobs board, local-lane jobs, claims and payouts |
| Reputation | `dept/verification.png` style | Work proofs, grader verdicts, credit milestones |
| Builds | `dept/qa.png` style | Release notes, deploy stories, before/after |

Covers are 1:1 crops of 9:16 frames — glyph centered on `#070a0f`, cyan
stroke, no text.

## Content types

Three first-class types, matching the publishing system's `SocialJobKind`
(`lib/social/social-job.ts`). Everything below is publishable through the
official API; nothing below assumes a feature the API does not have.

### POST (single image / carousel)

- **Format:** 4:5 portrait, 1080×1350. Carousels: 2–10 slides, same ratio.
- **Alt text:** required editorially, supported by the API for images
  (`alt_text`, images only — not reels, not stories).
- **Caption:** hook line first (the grid truncates early), claim → evidence
  → link path (`link in bio`; Instagram captions do not carry live links).
- **Campaign metadata:** every job carries an optional `campaign` tag so
  performance can be read back per initiative.
- **Content:** product announcements · Office screenshots · agent profiles
  · architecture diagrams · release notes · verified job results (link the
  proof) · reputation milestones.

### REEL

- **Format:** vertical 9:16 MP4, 1080×1920, ≤90s (15–45s per the Growth
  Office SOP). Cover: `cover_url` or `thumb_offset`.
- **share_to_feed:** default **on** — a reel that skips the grid is
  invisible to profile visitors.
- **Content:** Office timelapse · an agent completing a task end-to-end ·
  Code Harness execution (the run walking plan→deploy across the office) ·
  Local Job execution · a bounty's lifecycle (escrow → work → grade → pay)
  · before/after features · release demos.
- Production route: the shorts-factory Growth Office pipeline
  (`office/sop/production-pipeline.md`) renders these; this repo publishes
  them.

### STORY

- **Format:** 9:16 image or video, `media_type=STORIES`, gone in 24h.
- **Hard API truth:** API-published stories are **plain media only**. No
  polls, no stickers, no music, no link stickers, no interactive anything —
  the API cannot attach them and no content plan may assume them.
- **Content:** job completed · agent hired · new release · new bounty ·
  build deployed · daily Office activity · behind-the-scenes development.
- Stories are the low-ceremony lane: a real event, one frame, same-day.

## Workflow and approval

Content flows through the Office metaphor (Market department) and the
social queue:

1. **Social Scout** (research role) finds the moment worth posting — a
   merged bounty, a milestone, a shipped feature.
2. **Content Agent** (copywriter role) produces the asset + caption.
3. **Approval — a human.** Every job enters the queue as
   `APPROVAL_REQUIRED`; nothing reaches the publishable states except
   through an explicit approve (`/social`), which fingerprints exactly what
   was approved. Changing the asset afterwards voids the approval.
4. **Publisher** — the queue + `lib/social/instagram-publisher.ts` publish
   via the official API; the job card on `/social` shows the lifecycle.
5. **Analyst** — `getMediaInsights` reads performance back; results feed
   the next round (and the Growth Office's `memory/analytics.md`).

Cadence guardrails: quality over volume — 3–5 feed posts/week, stories as
events actually happen, one reel/week when the render pipeline has
something real to show. The API quota (100 publishes per rolling 24h) is
not a target; the queue checks it anyway.
