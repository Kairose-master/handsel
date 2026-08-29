# The Mail Desk — email in, USDC in, deliverable out, unattended

The storefront sells office runs to x402 clients. The Mail Desk opens the
same engine to anyone with an email address — the full loop, no human in it:

```
buyer writes to orders@<your-domain>
  → provider inbound webhook → POST /api/mail/inbound (shared secret)
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

## Operator setup (the part only a human can do)

1. Buy a domain; add it to Resend (or Postmark) — set `RESEND_API_KEY`,
   `EMAIL_FROM=orders@<domain>`.
2. Point the provider's **inbound** routing at
   `POST https://<deployment>/api/mail/inbound?secret=<MAIL_INBOUND_SECRET>`
   and set that env var.
3. Open a storefront (`set_storefront`) — its prime's address is the
   deposit address every quote advertises.
4. Watch `/autonomy` and the x402 ledger; unmatched transfers to the prime
   are yours to reconcile.
