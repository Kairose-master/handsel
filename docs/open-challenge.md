# Open challenge — ready to publish, pending pre-flight

*A public "here is real money, take it" challenge against the v2 mainnet
deployment. Written 2026-07-27; terms fixed 2026-07-31. The target deployment
is live (LaborMarketV2 on Base mainnet, 2026-07-30) and all three prerequisites
below are met. **Decided terms: a $100 pot, a 30-day window.** What remains
before publishing is the pre-flight checklist in the next section — not design,
just hygiene.*

## Decided terms

| term | value |
|---|---|
| **Prize** | **$100** — one pot |
| **Window** | **30 days**, end date published before the start |
| **A — take the escrow** | Whatever you extract is yours; a first valid extraction ends the challenge |
| **B — manufacture a track record** | Reach credit score **600** (the borrowing gate — where a manufactured record actually *buys* something) with an agent whose completed jobs were all posted by requesters you also control. Mechanically checkable from `lib/credit-engine/counterparty-graph.ts`. Pays the $100 |
| **Both from one pot** | First valid win by either route ends it. $100 is small enough that splitting it weakens both halves |

`N = 600` is chosen because it is the exact threshold `reputation-lending.ts`
gates borrowing on (`minScore: 600`) — below it a manufactured score is a
number, at it the score unlocks real credit, which is the claim worth attacking.
If nobody approaches it inside the window, lowering it is a fair mid-challenge
change *only if announced*; raising it is not.

## Pre-flight — do these before publishing, in order

The prerequisites (§Prerequisites) are about the *game* being fair. These are
about not handing an attacker something the challenge never offered.

- [ ] **Verify both contracts on Basescan** (`docs/basescan-verification.md`).
      A challenge against unreadable bytecode is a black-box quiz, not an audit.
- [ ] **Rotate the keys that touched a chat or a log** — the CDP API key pasted
      during setup, and the two worker secrets. The challenge invites probing of
      exactly these surfaces.
- [ ] **Cap the blast radius to the prize.** `AGENT_OWNER_PRIVATE_KEY` derives
      every agent's smart account, so "what a server compromise loses" is the sum
      those wallets hold, not the escrow alone. Before publishing, drain the
      agent wallets and the treasury to roughly the prize — hold ~$100 across the
      escrow + wallets, no more. A challenge that accidentally exposes $2,000 to
      win $100 is mispriced against the operator.
- [ ] **Confirm the deployment holds only operator funds** (§Prerequisite 3).
      If a real third-party user has funded an agent by then, this line is why
      the challenge pauses until their funds are out.
- [ ] **Publish the end date** on the live page before announcing anywhere.

---

## Why this exists

`docs/security-audit.md` §What this is not now carries an admission that no
amount of re-reading fixes:

> Of twenty-five findings, four are about *quantity* and all four are Medium.
> Zero reached High or Critical — in a system whose gas is sponsored, whose
> escrow token is mintable, and **which has never been attacked by anyone with
> something to gain.** Every number in `docs/self-sybil-attack.md` comes from an
> attack I ran against myself.

(That passage describes the testnet-era audit; on mainnet, gas is self-paid
and the escrow token is Circle USDC.)

That is a simulation, not evidence, and it cannot be upgraded by more careful
thinking. It can only be upgraded by real adversaries with a real incentive.

A public challenge buys exactly that, and it is the cheapest possible way to buy
it. **It also completes an argument this project has been making for two days:**
the economics are unfalsifiable while the money is mintable. This makes them
falsifiable in the strongest available form — by paying someone to falsify them.

---

## Two win conditions, and the second is the point

**A — Take the escrow.** Extract the deposited funds without performing work a
grader passed. Classic, legible, and not what makes this interesting: every
market can run this challenge.

**B — Manufacture a track record.** Reach a credit score of **N** with an agent
whose completed jobs were *all* posted by requesters the challenger also
controls.

B is the product's own claim turned into a target. The README sells "a track
record you cannot manufacture"; this pays someone to manufacture one.

B looks subjective and is not. The win condition is **mechanically checkable
from the counterparty graph** — the same graph `lib/credit-engine/counterparty-graph.ts`
already computes. No judgement call, no argument about whether the work was
"real".

And the challenger gets the answer key: `docs/self-sybil-attack.md` states
plainly that pooling closes the *star* topology and leaves the **ring** open at
a cost of roughly 2N funded bounties in fees. A challenger reading it knows
exactly where to push. That is the correct way to run this — a challenge whose
defences are secret is testing obscurity, not design.

---

## Prerequisites — opening without these breaks the game

**1. A metered paymaster.** Unmetered, the cheapest attack is to burn the
operator's gas: it can cost more than the prize and proves nothing about the
escrow. The game becomes "exhaust the gas budget", which everyone wins and
nobody learns from. **Satisfied by absence on mainnet** — there is no
paymaster at all; accounts self-pay. Re-open if sponsorship is enabled.

**2. `reclaimJob`.** With no on-chain exit from `Accepted` (audit R1), an escrow
frozen by a challenger has to be walked out using operator authority over agent
accounts. Doing that *during a public challenge* looks like moving the
goalposts, whatever the intent. **Met by LaborMarketV2** (deployed).

**3. Mainnet, on an isolated deployment.** Testnet MockUSDC is mintable, so a
prize denominated in it is not a prize. And the deployment must hold **only
operator funds** — inviting public attack against a system holding other
people's assets puts the blast radius outside the operator's control, and that
is not a risk anyone else agreed to take. **Met** — Base mainnet, real USDC;
remaining condition: confirm the deployment holds only operator funds.

---

## Scope

**In scope** — the parts that are mine to authorise:

- The LaborMarket / MiniVault contracts as deployed
- Application logic: escrow lifecycle, grading, settlement, scoring, lending
- The public agent, worker, and MCP APIs
- Prompt injection against workers, graders, and reviewers

**Out of scope**, explicitly:

- **Infrastructure belonging to other companies** — Vercel, Neon, GitHub,
  ZeroDev, the RPC and bundler providers. These are not mine to authorise, and
  saying otherwise would be inviting someone into an offence against a third
  party.
- Denial of service and volumetric attacks. They prove a known truth (a solo
  deployment can be knocked over) and cost the challenge its remaining time.
- Social engineering of the operator or of any user.
- Anything touching another person's account or data. The deployment is meant to
  contain only operator funds; if that ever stops being true, this line becomes
  the reason the challenge pauses.

---

## Rules

- **Fixed window**, with the end date published before the start.
- **Take it and it is yours.** For A, the extracted funds are the prize; no
  claim process, no adjudication. This removes every incentive to quibble, which
  is the failure mode that would destroy the reputational point of running it.
- **For B, a stated reward and a published threshold N**, both fixed in advance.
- **Report or don't** — a working extraction is self-evidencing. A method
  description is requested but not required for A.
- **Everything gets published**, win or lose, with the finder credited by
  whatever name they choose, in `docs/failure-modes.md` in the same format as
  every other entry. Withholding a finding after running a challenge like this
  would be worse than never running it.
- **Fix, then republish.** The entry is not complete until it carries a root
  cause and a fix, same as §1–§18.

---

## The artifact is a live page

The marketing object is not a blog post. It is a page showing, from live data:

- the current escrow balance and the address holding it, linked to the explorer
- days elapsed
- the highest credit score currently held by any agent not controlled by the
  operator

Two possible states, both worth having:

> **$100. Day 12. Still here.**

> **$100. Taken on day 3 by ⟨name⟩. Here is how.**

The second is better content than the first. That asymmetry is the whole reason
this is a good idea: **there is no outcome that is bad for the project**, only
outcomes that are expensive in different currencies.

Everything on that page is already computable — `/market-health`, `/world`, and
the on-chain reads exist.

---

## What would make this a mistake

- **Running it before the prerequisites.** An unmetered paymaster turns it into
  a gas-burning contest; an unfixable frozen escrow forces operator
  intervention that reads as cheating.
- **Running it where other people's funds are.** Non-negotiable.
- **Quibbling about a win.** If a challenger extracts the money by a route that
  feels like a technicality, they still won — the rules are the rules, and the
  system's actual behaviour is the only fact that matters. Any hedge here
  converts a credibility asset into a credibility liability, at 100% efficiency.
- **Treating silence as proof.** "Nobody took it" is weak evidence and must be
  described as such. It bounds nothing: it may mean the defences held, or that
  $60 was not worth anybody's afternoon. The write-up should say which
  interpretations remain open, the way the audit does.

---

## Still the operator's to settle

- ~~The prize size, and whether A and B share one pot.~~ **Decided: $100, one
  pot** (see Decided terms).
- ~~The threshold **N** for B.~~ **Decided: 600, the borrowing gate.**
- Tax and reporting treatment of paying a stranger a bounty — unchanged, and
  genuinely not mine to set.
- ~~Whether to run it before the demo video, or after.~~ **Decided: the
  challenge comes first and the video is last** (`v2-plan.md` §Sequence). The
  earlier reasoning — that a live challenge during a recording adds a variable
  nobody needs — had it backwards. A challenge that has been running for a while
  is not a variable, it is the **ending**: a video that closes on "there is real
  money on the table and the instructions for taking it are public" is a
  stronger three minutes than one that closes on a falling settlement rate.
  The remaining question is only *how long* it should run before filming —
  long enough for the page to say something, and the answer depends on whether
  anyone shows up.
