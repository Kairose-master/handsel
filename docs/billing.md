# Billing — the Repo Care pilot, and why Lemon Squeezy

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
| The public offer | `/pilot` — English, like `/start`; the "Start the pilot" button is `LEMONSQUEEZY_PILOT_CHECKOUT_URL`, and its absence is not an error — the page shows a plain email ask instead |
| Reading who paid | `/admin/pilots` — `billing` permission (`lib/admin.ts`), name/email/amount, newest first |

What is **not** built, on purpose: a subscription, a second tier, an
in-product upgrade flow, automatic account provisioning on payment. This
platform sells exactly the offer `docs/positioning.md`'s two-week test
asks for — one $500, 14-day pilot — and nothing past it, because building
a ladder before the first rung has sold once is the mistake that section
warns against. Onboarding a paid pilot (connecting their repo, setting the
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
   for `/pilot` to accept a real payment — no API key, no webhook required
   for the button to work.
4. In the store's webhook settings, add `https://<your-domain>/api/webhooks/lemonsqueezy`,
   subscribed to `order_created`. Copy the signing secret into
   `LEMONSQUEEZY_WEBHOOK_SECRET`. This is what makes the sale show up on
   `/admin/pilots` instead of only in Lemon Squeezy's own dashboard and
   email.
5. Grant yourself the `billing` admin permission (`lib/admin.ts` — the
   `ADMIN_EMAIL` superadmin already has every permission implicitly) to read
   `/admin/pilots`.

Test-mode orders (Lemon Squeezy's own sandbox card) are recorded and marked
`test_mode` on `/admin/pilots`, never hidden — the same "no fake data"
posture as everywhere else, applied to a table an operator reads instead of
a customer-facing page.
