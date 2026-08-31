# Instagram Graph API — publishing cheat sheet

Hosts: `graph.instagram.com` (Instagram Login tokens) ·
`graph.facebook.com` (Facebook Login tokens). Same endpoint shapes.
Auth: `Authorization: Bearer <token>` header — never the query string.

## The flow

```
POST /{ig-id}/media            → { id: container_id }
GET  /{container_id}?fields=status_code,status   (poll until FINISHED)
POST /{ig-id}/media_publish    creation_id=<container_id> → { id: media_id }
GET  /{media_id}?fields=id,permalink,media_type,timestamp
```

## Container parameters by kind

| Kind | Required | Optional |
|---|---|---|
| Image post | `image_url` (public https, JPEG) | `caption`, `alt_text`, `is_carousel_item`, `is_ai_generated` |
| Reel | `video_url`, `media_type=REELS` | `caption`, `share_to_feed`, `cover_url` XOR `thumb_offset`, `is_ai_generated` |
| Story image | `image_url`, `media_type=STORIES` | `is_ai_generated` (no stickers/polls/music/links via API) |
| Story video | `video_url`, `media_type=STORIES` | `is_ai_generated` |
| Carousel item | `image_url`/`video_url`(+`media_type=VIDEO`), `is_carousel_item=true` | `alt_text` (images) — **NEVER `is_ai_generated`** (API error on children) |
| Carousel parent | `media_type=CAROUSEL`, `children=<id,id,…>` (2–10) | `caption`, `is_ai_generated` |

Carousel crop: every slide is cropped to the FIRST slide's aspect ratio
(default 1:1) — export all slides at one ratio. Meta's recommended poll
cadence: ~once/minute, up to 5 minutes.

## Container status codes

- `IN_PROGRESS` — keep polling (videos: minutes).
- `FINISHED` — ready to publish.
- `PUBLISHED` — already went out; NEVER call media_publish again (that is
  how duplicates happen); recover the media id from `/{ig-id}/media`.
- `ERROR` / `EXPIRED` — container is dead (unpublished containers expire
  ~24h); a fresh attempt needs a NEW container.

## Errors — retry discipline

| Class | Signals | Action |
|---|---|---|
| Auth | `type=OAuthException`, code 190, codes 10/200–299 | STOP. Reconnect the account. Retrying invites token invalidation. |
| Rate limit | HTTP 429, codes 4/17/32/613 | Back off (exponential), retry later. |
| Transient | HTTP 5xx, codes 1/2, code 9007 (media not ready) | Retry with backoff (1s·2s·4s). |
| Validation | code 100 and most 4xx | Permanent — fix the request; a replay cannot succeed. |

## Limits

- **100 API publishes / rolling 24h / account** — read
  `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`
  BEFORE publishing. Carousel = 1.
- No native scheduling; no PNG guarantees (export JPEG); `alt_text` images
  only; media must be publicly fetchable by Meta's servers.
- Insights: `GET /{media_id}/insights?metric=reach,likes,comments,saved,shares`
  (reels add e.g. `ig_reels_video_view_total_time`; names drift across
  versions — expect code 100 for a retired metric and adjust).
- Token refresh (Instagram Login only):
  `GET /refresh_access_token?grant_type=ig_refresh_token` — token must be
  >24h old; new token lasts 60 days.
