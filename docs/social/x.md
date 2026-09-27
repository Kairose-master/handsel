# X (Twitter) — how Handsel uses it, and how it does not

*2026-09-27. Editorial spec, like `instagram-brand.md`. No X publishing code
exists in `lib/social/` yet; everything below is done by hand until the
Social Desk grows an `x` platform (same approval gate, same fingerprinting).*

The two repo rules bind here exactly as on Instagram: **no fake data, ever**
(every number is a number a page showed; every "verified" post links the
real proof), and **never invent functionality** (money copy follows
`lib/money-label.ts` — say which deployment, never call testnet traction
real). `docs/positioning.md:158` is the warning label: the old mechanism
tagline "recruits spectators — people retweet it; nobody opens a wallet."
So the X account is not built to be retweeted. It is built to be *found by
the ~200 people who wire agents to paid tools* and to give them one thing
to try.

## Who it is for, in order

1. **Developers wiring agents to paid APIs** (x402, MCP, Lucid, ERC-8004
   crowd). They search X for "x402", "402", "agent payments", "ERC-8004",
   "MCP worker". They are the ones who can install `npx`-anything today.
2. **Bounty and grant program operators** (daydreams, Circle Arc, Colosseum,
   Coinbase Developer Platform). One good reply in their thread is worth
   more than a hundred of ours.
3. **Korean builder communities** (블록체인 밸리, SKKRYPTO, 디스콰이엇 readers)
   — reached with the same artifacts, in Korean, on a second account.

Not for: retail crypto, "AI agent" hype accounts, anyone who cannot open a
terminal. A post that would please them is a post that fails rule one.

## Account structure

| Account | Language | Voice | Posts |
| --- | --- | --- | --- |
| `@handsel` (or `@handselmarket`) | English | The product. First person plural, plain, numbers-first. | Receipts, digests, replies in ecosystem threads |
| 진우's own account | Korean + English | The builder. First person singular. | Build log, the honest failures, the weekly digest in Korean |
| bot-alpha (optional, later) | English | A worker agent on the market, posting its own settled proofs | One post per settled job, machine-signed, links the proof |

The third account is the one nobody else can run: an agent posting *its own*
work proofs (`GET /api/proof/<id>` → EIP-712 signer, `GET
/api/proof/<id>/anchor` → on-chain root). It is also the first thing to hold
back until the anchoring sweep is live on mainnet — a bot posting
unanchored proofs is a bot asking to be trusted.

## The five post shapes (all from real endpoints)

1. **Receipt.** One settled job: bounty, what passed, the proof link, and
   from now on the anchor tx. `#143 — $1.20, pytest grader, proof → …,
   anchored in epoch 497,812 → basescan`. This is the atom. It is boring on
   purpose; twenty of them in a row are the argument.
2. **The number.** One figure from `GET /api/market/index`, once a week,
   with the methodology link the endpoint already carries. Never a chart
   without the endpoint that produced it.
3. **The refusal.** What the system *did not* do: a spend envelope DENY, a
   challenge `pickRequirement` refused, a grader FAIL that refunded. These
   are the posts that distinguish an escrow market from a job board, and
   nobody else has them to post.
4. **The digest** (weekly, the only scheduled post): "what agents could not
   do this week" from the backorder board once it exists; until then, what
   the market cleared and what it refused, with the numbers.
5. **The reply.** In someone else's thread — a bounty program, an x402
   release, an ERC-8004 draft discussion — one message that carries an
   artifact (a working PR, a proof, a measurement). `docs/interop-outreach.md`
   rule 3 applies verbatim: it must be worth something even if ignored.

Shapes that are banned: launch-style announcements ("introducing…"),
roadmap posts, screenshots of the 3D office (positioning §8 paused it),
anything with "revolutionary", threads that explain the vision. The vision
is the receipts.

## Cadence

- Receipts: as they settle, hand-picked, at most three a day. Silence on a
  day with no settlements is correct; a receipt invented to fill a gap is
  rule one broken.
- The number: Monday.
- The refusal: whenever one happens and is interesting. Roughly weekly.
- The digest: Friday, both accounts (Korean on the builder's).
- Replies: only with an artifact in hand. Zero is a fine week.

## The first thirty days

| Week | English account | Builder's account | Gate before posting |
| --- | --- | --- | --- |
| 1 | Nothing public. Bio, pinned post = one real proof + one real anchor tx. | Build log: what shipped 2026-09-27 (envelope, action log, anchoring, Bazaar), in Korean, with the commits. | Anchoring sweep has run once on the rehearsal deployment; `/api/proof/<id>/anchor` answers 200. |
| 2 | First receipts (3–5) and the first "number". | Weekly digest #1. | Seed jobs posted (`scripts/seed-needs.mjs`) and at least one settled by an outside worker. |
| 3 | First "refusal" post. One reply in the daydreams bounty thread with the Handsel job that matches an open issue. | Digest #2. | The reply links a job an outside worker can take today. |
| 4 | Bazaar listing post: the `discovery/resources` entry, the validate output, the first settled call. | Digest #3 + "what I got wrong" post. | Listing actually visible in CDP discovery; screenshot is of that page. |

## What "working" looks like (the only three numbers to watch)

- **Outside settlements** per week (jobs settled by a worker that is not the
  house) — the number the whole account exists to move. `market_price`
  gains a second class with ≥3 trades.
- **Paid calls on the Bazaar-listed resources** from payers we do not
  control (the x402 ledger already records them).
- **Replies that came with an artifact** (someone else's PR, proof, or
  measurement) — the sign the account reached builders, not spectators.

Followers, impressions and likes are not on the list. `positioning.md`
already learned what they buy.

## Mechanics, when it is automated

The Social Desk queue (`lib/social/social-job.ts`) is platform-agnostic in
its rules — approval-gated, fingerprinted, one human go-ahead per post. An
`x` platform under `lib/social/x/` would post receipts as they settle, with
the same gate. Until then, the operator posts by hand from the proof page.
Do not wire the bot-alpha account to post unattended before the envelope
and the anchor are both live on the deployment it posts about.
