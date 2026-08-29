# The Mail Desk — email in, USDC in, deliverable out, unattended

The storefront sells office runs to x402 clients. The Mail Desk opens the
same engine to anyone with an email address — the full loop, no human in it:

```
buyer writes to orders@<your-domain>
  → provider inbound webhook → POST /api/mail/inbound (signature-verified)
  → the body is FETCHED, not read from the webhook (Resend — see below)
  → LLM intent extraction (fenced — mail bodies are hostile input)
  → quote reply: price WITH UNIQUE CENTS + the serving prime's address + HS-token
buyer sends the exact amount of USDC
  → ops tick scans ERC-20 Transfer logs to the deposit address
  → exact-amount match = payment attributed to the order
  → commissionOffice() — the same fulfillment engine the x402 route uses
  → "paid, the desk is working" email with a live-status link
pipeline completes (review gate, independent grading, splits)
  → deliverable emailed, full document + per-step grading record linked
```

## The three policies

1. **Inbound-only. No cold outreach, ever.** Every send is a reply or a
   lifecycle notice on an order the person placed — inside lib/email.ts's
   standing transactional policy. An automated cold-mailer is spam with
   extra steps, illegal in most jurisdictions (CAN-SPAM, 정보통신망법), and
   the fastest way to burn a sending domain. "자동으로 이메일 보내기"의
   자동화 대상은 응대이지 영업 발송이 아니다.

2. **Email bodies are hostile input.** They reach the LLM only inside the
   untrusted-content fence (lib/untrusted-input.ts) with a strict-JSON-only
   system prompt; the extracted scope then enters the office pipeline where
   the customer-task fence guards the workers again. A mail that tries to
   instruct gets the catalogue reply, not obedience.

3. **The odd cents are the invoice.** One deposit address serves all orders;
   each quote carries a unique cents tag (1–99) so the transfer VALUE is the
   payment reference. No per-order wallets, nothing for the buyer to
   mistype. All 99 tags in use → the desk says "full", never reuses a tag —
   misattribution is not an option (tests assert this). Unmatched money
   stays visible in the prime's balance for manual reconciliation.

## Bounds

`MAX_QUOTES_PER_SENDER_PER_DAY=3` · `MAX_OPEN_QUOTES=20` · quotes expire in
7 days (freeing their cents tag) · payment scans are bounded to 9,000 blocks
per order per tick · the LLM runs only after the cheap caps pass.

## On "어떤 계정에도 소속되지 않은 오피스"

Schema-wise and custody-wise, ownerless is neither possible nor desirable:
somebody must hold the prime's keys, receive the margin, and answer for the
desk. What the request actually wants — an office the platform operates
without the owner driving it — already exists as the composition of shipped
pieces: **storefront open + Automaton on + gas pool on + lineage mandate on
+ Mail Desk**. That desk quotes, collects, fulfills, delivers, keeps itself
claim-ready, and (on the rehearsal) breeds its successes, with the owner
appearing only in the audit logs. The "house office" is a role, not a new
ownership type.

## Resend's webhook carries no body — the one thing that silently breaks

`email.received` is **metadata only**:

```json
{ "type": "email.received", "data": { "email_id": "...", "from": "...", "subject": "..." } }
```

No `text`, no `html`. The body comes from a second, authenticated call:
`GET https://api.resend.com/emails/receiving/{email_id}`.

This is the failure mode worth naming, because nothing about it looks
broken: read the webhook as if the body were inline and every order
normalizes to empty text, intent extraction finds nothing, and the desk
answers *every* real customer with the catalogue — forever, at 200 OK, with
clean logs. `resendReceivedEmailId` detects that envelope and
`fetchResendReceivedEmail` fetches the body (falling back to `htmlToText`
for HTML-only mail); `normalizeInboundMail` stays the generic inline-body
parser for Postmark and anything posting `{from, subject, text}` directly.

## Authenticating the ear

`POST /api/mail/inbound` 503s until one of two env vars is set — an
unauthenticated inbound endpoint lets anyone forge mail from any address:

- **`RESEND_WEBHOOK_SECRET`** (preferred) — the `whsec_…` signing secret
  Resend shows when you create the webhook. Verified as a real Svix HMAC:
  `HMAC-SHA256(secret, "{svix-id}.{svix-timestamp}.{raw body}")`, compared
  timing-safely, with a 5-minute timestamp window and multiple `v1,<sig>`
  entries accepted so a key rotation does not drop mail. Same posture as
  `verifyGithubSignature` in `lib/github-app.ts`. The route reads the body
  as **text** and parses it only after verifying — the HMAC is over the
  exact bytes, and re-serializing a parsed object would fail every real
  signature.
- **`MAIL_INBOUND_SECRET`** — the shared-secret fallback for providers that
  do not sign, in `?secret=` or `X-Mail-Secret`. Treat it like
  `CRON_SECRET`: a query-string secret lives in Vercel's logs permanently.

## Operator setup (the part only a human can do)

1. Buy a domain and add it to Resend. **Sending** and **receiving** are two
   separate setups on the same domain: sending wants SPF/DKIM, receiving
   wants an MX record. Use the exact records Resend's dashboard prints for
   *your* domain — they differ per domain and per region, so do not copy a
   value out of a doc (this one included).
2. Set `RESEND_API_KEY` and `EMAIL_FROM=orders@<domain>`.
3. Create a Resend webhook on the **`email.received`** event pointing at
   `POST https://<deployment>/api/mail/inbound`. Copy the signing secret it
   shows into `RESEND_WEBHOOK_SECRET` and redeploy.
4. Open a storefront (`set_storefront`) — its prime's address is the
   deposit address every quote advertises.
5. Confirm with `curl -s https://<deployment>/api/capabilities` — `email`
   and `mailDesk` both `on` means the desk can hear and answer. (Names and
   on/off only; the endpoint never echoes a value.)
6. Watch `/autonomy` and the x402 ledger; unmatched transfers to the prime
   are yours to reconcile.
