# Demo video — script and shot list

*3 minutes. For the Anthology Fund / Anthropic Startup Program application, and
reusable for Show HN. Written against what actually works on the live
deployment as of 2026-07-27 — every screen below was verified to respond, and
every number quoted is real.*

*What's filmed is the testnet deployment at
`ai-agent-credit-dashboard.vercel.app`; the mainnet app is
`handsel-main.vercel.app`.*

---

## The one rule

**Nothing staged.** This project's entire claim is a track record that cannot be
manufactured, and `CLAUDE.md` says "no fake data, ever". A demo with a mocked
payout would contradict the product on camera. Everything here is a real job,
real escrow, real settlement — the only editing is **cutting dead time**, and
the cuts are made visible (see below).

---

## The recording problem, and how to handle it honestly

A real cycle is not 3 minutes long:

| Step | Real duration |
|---|---|
| Label → escrow posted | ~30s (ERC-4337 round trip) |
| Worker claims + produces a diff | 1–5 min |
| CI run | 1–3 min |
| Merge → payout confirmed | ~30s |
| Background sweeps | traffic-driven, up to 5 min between ticks |

So: **record the whole thing straight through (~15 min of footage), then cut.**
Two rules that keep the cuts honest:

1. Keep a **visible clock** in frame — the OS clock in the menu bar is enough.
   A viewer can see time jumped, which is the difference between editing and
   faking.
2. On each cut, a one-line caption: `— 2 min later —`. Say it out loud too.

If a step fails on the take, **keep the take and narrate it.** A retry on
camera is better material than a clean second attempt; see §5.

---

## Shot list

### 0:00 – 0:20 · The hook — one gesture

**Screen:** A GitHub issue in `Kairose-master/ai-agent-credit-dashboard`.
Cursor adds the label `bounty:$15`. Nothing else.

**Say:**
> "This is the only thing a human does. I put a price on a GitHub issue.
> Everything after this is agents."

**Cut immediately.** Do not explain the architecture yet — the gesture is the
hook, and it is small enough to be surprising.

---

### 0:20 – 1:00 · Money moves before any work does

**Screen:** the same issue, ~30 seconds later. The bot's comment appears:
escrow locked, job number, link to the board.

**Say:**
> "The bounty is now escrowed on-chain. Not promised — locked. That matters,
> because the worker about to take this is a machine, and a machine cannot
> chase an invoice."

**Screen:** cut to `https://ai-agent-credit-dashboard.vercel.app/live` — the job
is on the public board. Then `/guest`: same job, with acceptance criteria
visible.

**Say:**
> "Anyone can see it. No login. The acceptance criteria are public, because
> they're the contract the work gets graded against."

---

### 1:00 – 1:35 · A stranger takes the work

**Screen:** the board showing the job move to claimed, then the PR appearing in
the repo.

**Say:**
> "A worker agent claimed it and opened a pull request. I don't operate that
> worker's model, and it never receives any credential from me — it submits a
> diff, nothing else."

**Screen:** the PR's CI checks going green.

**Say, and land this line:**
> "CI is green. **No money moves.** Green tests on a wrong diff is exactly the
> failure a bounty market invites, so the tests are evidence, not authority."

---

### 1:35 – 2:00 · The merge is the authorization

**Screen:** click Merge. Then the issue/PR, where the payout comment appears.

**Say:**
> "The merge releases the escrow. That's the one human decision in the loop,
> and it's deliberate — the requester deciding the work was worth buying is
> the signal the whole system is built on."

**Screen:** cut to the worker's public profile.

**Say:**
> "And this is what the worker keeps."

---

### 2:00 – 2:30 · The thing that can't be manufactured

**Screen:** `/world` or the public agent list. Point at the top real row on
the day (at drafting time: **Worker Bot Alpha: score 752, rating BBB, 109
jobs, $681.50 earned**).

**Say:**
> "Every number here is a settled job. The score isn't self-reported and it
> isn't a review — it's computed from graded outcomes, weighted by who the
> counterparty was, how hard the grader is to fool, how much money was at
> stake, and how long ago it happened."

**Screen:** a signed work proof page (`/proof/<id>`).

**Say:**
> "Each deliverable gets a signed proof: content hash, which grader, what
> verdict. The grader is never the author. That's the whole product — a track
> record you cannot manufacture — and the score unlocks borrowing against it."

---

### 2:30 – 3:00 · Close on the unflattering number

**This is the most important 30 seconds. Do not cut it for time.**

**Screen:** `/market-health`. Let the settlement rate sit on screen — read
the live figure on the day (66% when this script was drafted) and quote
*that* in the narration.

**Say:**
> "This is the public health page. Settlement rate: sixty-six percent. It went
> *down* this week, because I spent a day resolving a backlog of dead jobs into
> refunds, and refunds count as failures. I publish it anyway."

**Screen:** scroll `docs/failure-modes.md` on GitHub — let the section headings
blur past, then stop on one.

**Say:**
> "Every way this thing has frozen or duplicated money is written down, with
> the root cause and the fix. Nineteen of them."

**Screen:** `docs/security-audit.md`, scrolled to **"What this is not"**.

**Say, as the last line:**
> "I audited it myself and published the findings — twenty-five defects — along
> with a section on everything a self-audit cannot cover. It's fourteen days
> old, it's live on Base mainnet with real money and no external audit, and
> it's one person. I'd rather you see the real numbers."

**End card:** URL + `github.com/Kairose-master/ai-agent-credit-dashboard`.

---

## Why the ending is built that way

Every other applicant's video ends on a rising metric. Ending on a **falling**
one, and then showing the document that explains why, does two things nothing
else in three minutes can do: it proves the numbers on screen were never
curated, and it demonstrates the engineering judgment that is the actual asset
of a 14-day-old project. The failure-modes and audit documents are unusual for
the project's age — they are the strongest evidence available, and they only
work if the video is willing to look bad for ten seconds first.

---

## What NOT to show

- **The dashboard's every tab.** A tour is not a demo. One cycle, end to end.
- **The Minecraft plugin, the desktop miner's minigame, governance voting.**
  All real on the sandbox deployment (Minecraft lives in its own repo now;
  governance is testnet-only), all interesting, all dilution. They make a
  solo project look unfocused rather than broad.
- **Anything requiring a login to be interesting.** The strongest screens
  (`/live`, `/guest`, `/market-health`, `/world`) are public — a viewer can
  verify every claim after the video ends, which is worth more than showing
  more features.
- **Speed-ups that hide a failure.** If a sweep is slow because traffic-driven
  ticks are sparse, say that; it's a real property of the design.

---

## Technical notes for the recording session

- **Record locally, not against the proxy.** Chromium can't traverse the agent
  proxy in this environment — run `npm run build && npm start` and record
  `localhost`, or record from your own machine's browser against the live URL.
- **The sweeps are traffic-driven.** If the board looks frozen, hit
  `/api/tasks` a few times — the background cycle runs after that request, at
  most once per five minutes (cross-instance lease). Budget for this.
- **Warm the pages first.** Cold serverless starts add a second or two that
  reads as sluggishness on camera.
- **Have a second job ready.** If the first take's worker fails grading, that
  is *usable footage* (see below) but you still need a completed cycle.
- 1080p, no music, no zoom transitions. Screen and voice only.

## If something breaks on camera — keep it

A failed grading, a job that gets refunded, an escrow that needs the recovery
sweep: **that is the most valuable footage you can get**, and it is on-brand.
One sentence turns it from a bug into the pitch:

> "That one failed grading and the escrow went back to me automatically. That
> path is section five of the failure-modes doc — it used to be a dead end
> where money just sat, and finding that is most of what the last two weeks
> were."

Do not re-record to hide it.
