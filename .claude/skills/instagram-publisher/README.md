# instagram-publisher

A Claude Code / Handsel skill for publishing to the official Handsel
Instagram account through the **official Instagram Platform content
publishing API** — posts, carousels, Reels and Stories, plus status, quota
and insights reads.

- `SKILL.md` — the instructions Claude follows (dry-run-by-default rule,
  the queue-vs-standalone routing, command table).
- `scripts/ig.mjs` — zero-dependency Node CLI over the Graph API. Every
  publish is a dry run unless `--live` is passed.
- `references/graph-api.md` — endpoint/error/limit cheat sheet.

## Credentials

Env only (or the app's encrypted platform_secrets KV when running inside
the deployment):

```
INSTAGRAM_ACCESS_TOKEN   long-lived token for the professional account
INSTAGRAM_ACCOUNT_ID     numeric IG account id
INSTAGRAM_API_VERSION    optional (default v25.0)
INSTAGRAM_GRAPH_HOST     optional (graph.instagram.com default)
```

Never commit these; never paste a full token into a chat, log or file.
Setup runbook: `docs/social/instagram.md`.

## Quick start

```bash
node .claude/skills/instagram-publisher/scripts/ig.mjs doctor
node .claude/skills/instagram-publisher/scripts/ig.mjs post \
  --image https://example.com/card.jpg --caption "…" --alt "…"   # dry run
# … human reviews the printed plan …
node .claude/skills/instagram-publisher/scripts/ig.mjs post \
  --image https://example.com/card.jpg --caption "…" --alt "…" --live
```

Scheduling ("publish tomorrow 9am") is not a Graph API feature — route
those through the app's Social Desk queue (`/social`), which also owns the
approval gate, retries and duplicate-publish prevention.
