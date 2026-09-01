# Instagram DM automation — setup guide (keys, webhooks, policy)

Comment-triggered Private Replies: someone comments on a Handsel post → the
comments webhook fires → triage → at most ONE private reply DM, once per
person per campaign. This is Meta's officially supported "comment-to-DM"
flow (the ManyChat pattern), not scraping and not cold outreach — the code
has no path to message a non-commenter.

## 1. What you set up on the Meta side (one-time, ~20 min on top of publishing)

Prerequisites: the working publishing setup from docs/social/instagram.md.

1. **Add the Messenger product** to the Meta app (Instagram messaging lives
   under Messenger API for Instagram).
2. **Token scopes** — regenerate the System User token adding:
   - `instagram_business_manage_messages` (Instagram Login) or `instagram_manage_messages` (Facebook Login) — send private replies
   - `instagram_business_manage_comments` / `instagram_manage_comments` — comment webhooks
   - keep: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
3. **App review**: `instagram_manage_messages` requires **Advanced Access**
   for production use. Submit with a screen recording of the comment→DM flow
   on a test post; approval typically takes days. Until granted, the flow
   works for accounts with a role on the app (enough for testing on the
   official account if it's owned by the app's Business).
4. **Webhook subscription** (Meta app dashboard → Webhooks → Instagram):
   - Callback URL: `https://<your-prod-domain>/api/webhooks/instagram`
   - Verify token: the value you'll set as `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **`comments`** field.
   - Then subscribe the IG account itself:
     `POST /{page-id}/subscribed_apps?subscribed_fields=comments`
5. **Private-reply constraints Meta enforces** (design facts, not choices):
   one private reply per comment; only on comments on your own media; within
   7 days of the comment (we stop at 6); recipient is addressed by
   `comment_id`, so the person's inbox shows it attached to their comment.

## 2. Keys/env to set (never committed — see the Instagram DM block in .env.example)

| Var | What | Where to get it |
|---|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | System-User token WITH the two new scopes | Business Manager → System User → generate token |
| `INSTAGRAM_ACCOUNT_ID` | ig-user-id (same as publishing) | `GET /{page-id}?fields=instagram_business_account` |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | random string you invent | `openssl rand -hex 24`, paste same value in the Meta form |
| `META_APP_SECRET` | app secret, webhook signature check only | app dashboard → Settings → Basic |
| `INSTAGRAM_DM_ENABLED` | `true` to turn the mechanism on | you — this is the standing approval |
| `INSTAGRAM_DM_DISABLED` | `true` always wins (kill switch) | you |

Production storage: token in `platform_secrets` (`instagram_access_token`), the
rest as Vercel env vars. Echo last-4 only, ever.

## 3. How a campaign goes live (the approval chain)

```
video/caption promises: "comment PROOF and we'll DM the on-chain links"
        ↓
.claude/skills/instagram-publisher/prompts/dm-reply-generation.md drafts the template   (LLM, offline)
        ↓
HUMAN approves the template + trigger + link          ← the real gate
        ↓
campaign row created {id, triggers:['proof'], template, link, mediaIds}
        ↓
webhook: comment arrives → triage → dedupe → 1 DM → social_dm_log
```

- Approval is per-CAMPAIGN (template+trigger+link), not per-DM — per-DM
  human approval is impossible at webhook latency, and the template being
  frozen is what makes per-campaign approval meaningful. No LLM writes text
  at send time; only `{{username}}`/`{{link}}` are substituted.
- The mechanism switch (`INSTAGRAM_DM_ENABLED=true`) is itself an approval
  artifact: setting it is the Office's "contacting people outside the Office"
  sign-off, made once, revocable instantly via `INSTAGRAM_DM_DISABLED`.

## 4. Anti-spam guardrails (all enforced in code, lib/social/instagram/dm.ts + instagram-dm-server.ts)

| Guardrail | Enforcement |
|---|---|
| Comment-triggered only | send call requires a `comment_id`; no user-id path exists |
| One DM per person per campaign, ever | `social_dm_log` PRIMARY KEY dedupe, claimed BEFORE sending |
| 6-day freshness (Meta allows 7) | `isCommentFresh` |
| ≤ 20 DMs/hour account-wide | durable counter in `social_dm_log` |
| Negative/complaint comments never get promo | triage `NEGATIVE_MARKERS` → `human` row for a person to answer |
| Own-comment echo loops | `fromId === accountId` → ignore |
| Honest copy | template linter: must name Handsel; ≤1000 chars; no unknown variables; the prompt adds the no-repeat opt-out line |
| No conversation farming | one message, no follow-ups; replies from the user land in the normal inbox for humans |

## 5. Testing without Meta

`npm run gates` covers the pure layer (webhook parsing, HMAC signature
verification, triage routing, dedupe keys, freshness, template lint). Live
verification order once keys exist:
1. `GET /api/webhooks/instagram?...hub.challenge=...` handshake passes (Meta
   dashboard "Verify and save" succeeds).
2. Comment "proof" on a test post from a second account with an app role →
   one DM arrives, attached to the comment.
3. Comment again / from the same account on another campaign post → no
   second DM (dedupe row visible in `social_dm_log`).
4. Comment something angry → no DM; a `verdict='human'` row appears.

## 6. What this deliberately does not do

- No cold DMs, follower scraping, or messaging people who engaged elsewhere.
- No LLM free-writing in anyone's inbox.
- No follow-up sequences ("just bumping this!").
- No unofficial/private Instagram endpoints or session automation — if the
  official API can't do it, this system doesn't do it.
