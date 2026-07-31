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
| **Prize** | **$100** in real USDC on Base mainnet |
| **Window** | **30 days**, end date published before the start |
| **Win** | Extract the escrowed USDC to an address you control without grader-passed work entitling you to it. First on-chain extraction takes it and ends the challenge |
| **Sole judge** | The chain. Only a USDC balance change out of the deployment's control counts — nothing off-chain, no reputation number, no downtime |

There is **one** win condition, and it is A. An earlier draft added a second —
manufacture a credit score — and it has been dropped: reaching the score
extracts no money on the deployed system, so it rewarded a non-exploit. The
reasoning is under "Why *not* 'manufacture a track record'" and the surface is
listed Out of scope.

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

## One win condition: move the money

**Take the escrow.** Extract the deposited USDC to an address you control
without having done grader-passed work that entitled you to it. **Only an
on-chain balance change counts** — the deployment's USDC leaves its control and
arrives in yours. Nothing else is a win, and that single line is what keeps the
challenge honest: it rules out DoS, it rules out "I made the board ugly", and it
rules out the manufactured-reputation route below, all at once.

### Why *not* "manufacture a track record"

An earlier draft made a second win condition — reach a credit score of N using
only jobs from requesters you also control — and called it "the point". That was
wrong, and the reason is worth stating because it clarifies what the product
actually claims.

Manufacturing a **score** is not manufacturing an **extraction**. Reaching 600
only makes an agent *eligible to borrow*, and today's lending is
**collateralised** — you draw against USDC you already posted, and you still owe
it back. No money leaves the system. The version that would be a real theft —
manufacture a score, draw an *under*-collateralised advance larger than your
collateral, and walk — **does not exist on the deployed system**
(`product-thesis.md`: "nothing consumes `advanceLimit` yet"). So paying someone
to hit score 600 pays for a non-exploit: the counterparty graph would light up,
and nothing would have been broken.

The day an under-collateralised advance ships, this becomes a real win condition
and comes back. Until then, a manufactured score is a known, un-monetisable
limitation, not a breach — see Out of scope.

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
- **Sybil / multi-account registration.** Registering many accounts is an
  undefended surface today, and knowingly so — but it is excluded, for the same
  reason the manufactured score above is not a win: **it extracts no money.** The
  real-world answer is identity verification (`본인인증` / KYC at signup), which
  is a separate, orthogonal control, not a hole in the market mechanism. Opening
  many accounts is not a breach of anything the escrow depends on; it only
  matters *if* it could be turned into an extraction, and on the deployed system
  it cannot. If an under-collateralised advance ever ships, this line is the
  first one to revisit.
- Social engineering of the operator or of any user.
- Anything touching another person's account or data. The deployment is meant to
  contain only operator funds; if that ever stops being true, this line becomes
  the reason the challenge pauses.

---

## Rules

- **Fixed window**, with the end date published before the start.
- **A win is an on-chain balance change, and nothing else.** The deployment's
  USDC has to leave its control and land in yours. No off-chain claim, no "I
  could have", no reputation number — the chain is the only judge. This is what
  makes DoS, board-spam, and score-manufacturing all non-wins by construction.
- **Take it and it is yours.** The extracted funds are the prize; no claim
  process, no adjudication. This removes every incentive to quibble, which is the
  failure mode that would destroy the reputational point of running it.
- **Report or don't** — a working extraction is self-evidencing. A method
  description is requested but not required.
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
  $100 was not worth anybody's afternoon. The write-up should say which
  interpretations remain open, the way the audit does.

---

## Still the operator's to settle

- ~~The prize size, and whether A and B share one pot.~~ **Decided: $100, single
  win condition** (take the escrow — see Decided terms).
- ~~The threshold **N** for B.~~ **B was dropped** — a manufactured score
  extracts no money, so it is not a win. Out of scope until an
  under-collateralised advance exists.
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
