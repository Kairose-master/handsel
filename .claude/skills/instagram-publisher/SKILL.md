---
name: instagram-publisher
description: "Publish content to the official Handsel Instagram through the official Graph API: single-image posts, carousels, Reels, Stories, plus publish status, quota and media insights. Dry-run by default; a live publish needs the human's explicit go-ahead in the conversation. Use when asked to post/publish/schedule something to Instagram, turn screenshots into a carousel, put a release on the Story, check why a publish failed, or read post performance. Triggers: instagram, post to instagram, publish reel, story, carousel, schedule launch content, instagram quota, media insights, social desk."
license: MIT
---

# instagram-publisher

Publish to the Handsel Instagram account through the **official Instagram
Platform content-publishing API** — never a browser bot, never a private
endpoint, never a session cookie. If the API cannot do a thing (Story
stickers, native scheduling, non-JPEG images), say so; do not work around it.

## The two iron rules

1. **Nothing publishes without an explicit human go-ahead.** Every
   operation here is dry-run by default and prints exactly what WOULD be
   published. Only pass `--live` after the human has seen the plan (media
   URL, caption, kind) and said yes in this conversation. Generation
   finishing is never approval.
2. **Never print or store a full access token.** Credentials come from env
   (`INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`) or the app's
   platform_secrets KV. Echo last-4 only. If a command fails with an auth
   error, the remedy is "reconnect the account", never "retry until it works".

## Two routes — pick by context

- **Inside the Handsel app repo / deployment (preferred):** create a job in
  the Social Desk queue instead of publishing directly — the queue owns
  approval, scheduling, retries and duplicate-prevention. Server-side:
  `createSocialJob()` from `lib/social/social-queue-server.ts`, or the
  `/social` page. A queued job publishes only after a human approves it
  there. Use this whenever the ask is "schedule", "queue", or the content
  came from an agent/pipeline.
- **Standalone (this skill's scripts):** `scripts/ig.mjs` talks to the
  Graph API directly with zero dependencies. Use for the operator's own
  one-off publishes, doctor checks, quota and insights reads.

## Operations → commands

All via `node .claude/skills/instagram-publisher/scripts/ig.mjs <cmd>`;
add `--live` to actually execute a publish (otherwise it prints the plan).

| Conceptual op | Command |
|---|---|
| `instagram.publish_post` | `post --image <url> [--caption <text>] [--alt <text>] [--live]` |
| `instagram.publish_carousel` | `carousel --media <url,url,…> [--caption <text>] [--live]` |
| `instagram.publish_reel` | `reel --video <url> [--caption <text>] [--cover <url>] [--share-to-feed] [--live]` |
| `instagram.publish_story` | `story (--image <url> | --video <url>) [--live]` |
| `instagram.get_publish_status` | `status --container <id>` |
| `instagram.get_quota` | `quota` |
| `instagram.get_media_insights` | `insights --media <id> [--metrics a,b,c]` |
| credentials sanity check | `doctor` |

Natural-language mapping: "Post this image to Handsel Instagram" → `post`
(dry-run, show plan, ask, then `--live`). "Publish this as a Reel and share
it to the feed" → `reel --share-to-feed`. "Put this release image on the
Story" → `story --image`. "Turn these four screenshots into a carousel" →
`carousel` (2–10 items). "Schedule this launch content for tomorrow" → the
QUEUE route (`createSocialJob` with `scheduledAt`) — the Graph API has no
native scheduling.

## Before publishing anything

1. `doctor` — verifies the token resolves the account (prints @username,
   token last-4). Auth failure ⇒ stop; tell the human to reconnect.
2. `quota` — 100 publishes per rolling 24h; if full, defer, don't burn calls.
3. Media must already sit on a **public https URL** (Vercel Blob works).
   Images: JPEG, 4:5 preferred (1080×1350). Reels: MP4 9:16 (1080×1920).
   Stories: 9:16, plain media only — no polls/stickers/music via API.
4. Captions/claims must be true of the real product — the DO-NOT-CLAIM
   discipline in `docs/social/instagram-brand.md` applies to every word.

## After a live publish

The command prints the container id, the media id and the permalink —
report all three. A video container can take minutes: `status --container
<id>` until FINISHED/PUBLISHED. On ERROR/EXPIRED, a NEW container is
required (never re-publish an old one — the duplicate guard exists because
`media_publish` is not idempotent).

Details: `references/graph-api.md` (endpoints, error codes, limits) and
`docs/social/instagram.md` (architecture, Meta app setup runbook).
