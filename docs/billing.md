# Billing — the Repo Care pilot, the office subscription, and why Lemon Squeezy

`docs/positioning.md` §8 named "card payment and a pilot flow" as still
owed, and said plainly that it "needs a Stripe account and a decision about
who is billed, neither of which is a code question." The decision is now
made: **Lemon Squeezy**, not Stripe, because Stripe does not onboard a
Korea-domiciled seller directly — there is no path to a standard Stripe
account without a supported-country business entity (a US entity via Stripe
Atlas is the common workaround, but that is incorporation, not a webhook).

Lemon Squeezy (and Paddle, its closest peer) is a **merchant of record**:
it is the one that legally sells to the customer, collects the card, handles
VAT/sales tax, and pays the operator out — no US entity, no Korean payment
gateway integration, nothing this repo has to build to be correct about
tax. The cost is a higher take rate than Stripe's; at pilot scale ($500,
one sale at a time) that difference is noise.

## What is built, and what is a human's job

| | where |
|---|---|
| The offer (name, price, days, summary) | `lib/billing.ts` `PILOT_OFFER` |
| Verifying a Lemon Squeezy webhook | `lib/billing.ts` `verifyLemonSqueezySignature` — HMAC-SHA256 over the raw body, hex in `X-Signature`, no prefix (unlike GitHub's `sha256=…`) |
| Reading an `order_created` event | `lib/billing.ts` `parsePilotOrder` — every other event name, and every malformed body, reads as "not an order" |
| Recording the lead | `lib/billing-server.ts` — a self-migrating `pilot_lead` table, insert is idempotent on `order_id` (a webhook retry changes nothing) |
| Receiving the webhook | `POST /api/webhooks/lemonsqueezy` — verifies before parsing, always answers 200 (Lemon Squeezy retries a non-2xx) |
| The public offer | `/repo-care` — the landing page, in Korean (the operator's own copy — see the page's own header comment before changing it); `/repo-care`'s diagnostic and `/office/repo-care`'s wizard both end at the same `LEMONSQUEEZY_PILOT_CHECKOUT_URL` checkout, and its absence is not an error — both show a plain email ask instead |
| The guided onboarding | `/office/repo-care` — worker connect, posture (`PRESET_POLICIES`), a final plan review, then the same checkout button. Starts the real session immediately (`startRepoCare`) — Repo Care's own work is `settlement: 'internal'`, so nothing here waits on payment to run at $0 on-platform cost |
| Reading who paid | `/admin/pilots` — `billing` permission (`lib/admin.ts`), name/email/amount, newest first |
| The subscription tiers (id, price/month, repo limit, nightly cap, summary) | `lib/billing.ts` `OFFICE_SUBSCRIPTION_TIERS` — Starter/Growth/Studio, ordered cheapest first |
| Reading a `subscription_*` event | `lib/billing.ts` `parseSubscriptionEvent` — every lifecycle event (`created`/`updated`/`cancelled`/`expired`/`paused`/`payment_success`/`payment_failed`), matched to a tier by variant name (`tierIdForVariantName`) |
| Recording a subscription | `lib/billing-server.ts` — a self-migrating `office_subscription` table, upsert on `subscription_id` (unlike the pilot lead, a later event **updates** the row — a subscription has a status lifecycle, not a one-shot fact) |
| The subscription checkout links | `/repo-care`'s "계속 사용" card — one `LEMONSQUEEZY_SUB_<TIER>_CHECKOUT_URL` per tier, each falling back to a mailto exactly like the pilot button |

**2026-09-05 — the owner overrode the "no subscription ladder" rule this
doc used to state here.** It used to say a subscription was refused on
purpose until the pilot sold once. The decision now is to build the
recurring rung immediately rather than wait: `OFFICE_SUBSCRIPTION_TIERS`'
prices are an initial anchor (Starter's $299 carries over from what
`/repo-care` was already showing before it had a real checkout behind it),
not evidence from a paying subscriber — expect to revise them once one
exists. Still not built, and still a genuine gap rather than a choice made
this time: **wiring a plan's `repoLimit`/`maxPerWave` to an actual
account.** `office_subscription` records who paid by email; nothing links
that email to the `userId` that would run the Repo Care session, so
`repoCareWithinTierLimits` (`lib/billing.ts`) is pure, tested, and unwired.
Onboarding a paid pilot or subscriber (connecting their repo, setting the
approval policy, watching the first night with them) is still the operator
reading `/admin/pilots` and doing it by hand.

## Setting up the Lemon Squeezy side (not code)

1. Create a Lemon Squeezy account and a store. This is identity verification
   and payout details — the part no code can do.
2. Create one product: **"Repo Care pilot"**, one-time price **$500**. Match
   `lib/billing.ts` `PILOT_OFFER` if either number changes, so the page and
   the actual charge never say two different things.
3. Copy the product's hosted checkout URL into `LEMONSQUEEZY_PILOT_CHECKOUT_URL`
   (Vercel env, both this repo's deployments as needed). This alone is enough
   for `/repo-care` to accept a real payment — no API key, no webhook required
   for the button to work.
4. In the store's webhook settings, add `https://<your-domain>/api/webhooks/lemonsqueezy`,
   subscribed to `order_created` **and every `subscription_*` event**. Copy
   the signing secret into `LEMONSQUEEZY_WEBHOOK_SECRET`. This is what makes
   a sale or a subscription show up on `/admin/pilots` instead of only in
   Lemon Squeezy's own dashboard and email.
5. Create three recurring products, **named exactly** `Starter`, `Growth`,
   `Studio` (the variant name is how the webhook matches an event back to a
   tier — `tierIdForVariantName`), at the prices in `OFFICE_SUBSCRIPTION_TIERS`.
   Copy each hosted checkout URL into `LEMONSQUEEZY_SUB_STARTER_CHECKOUT_URL`,
   `LEMONSQUEEZY_SUB_GROWTH_CHECKOUT_URL`, `LEMONSQUEEZY_SUB_STUDIO_CHECKOUT_URL`.
   Any tier without its env var falls back to a mailto link on `/repo-care`,
   same as the pilot button without `LEMONSQUEEZY_PILOT_CHECKOUT_URL`.
6. Grant yourself the `billing` admin permission (`lib/admin.ts` — the
   `ADMIN_EMAIL` superadmin already has every permission implicitly) to read
   `/admin/pilots`.

Test-mode orders (Lemon Squeezy's own sandbox card) are recorded and marked
`test_mode` on `/admin/pilots`, never hidden — the same "no fake data"
posture as everywhere else, applied to a table an operator reads instead of
a customer-facing page.
