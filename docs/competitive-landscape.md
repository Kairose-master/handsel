# Competitive landscape — who else is building agent trust, and where Handsel sits

*Last updated: 2026-07. Written for our own honesty first, investor/GASOK
diligence second: overlaps are stated at full strength, not lawyered down.*

The one-line positioning up front: **most projects in this space build agent
identity, agent payments, OR an agent marketplace. Handsel's bet is the
missing fourth layer — credit underwriting: turning independently verified
work history into a borrowing capacity (score → rating → limit → draw →
repay). Nobody listed below closes that loop today.**

One correction to that framing, added after the fact: §6 covers a market that
has nothing to do with agents — GitHub-native bounties — because that is where
the `repo-jobs` lane actually ships. It was missing from this document for as
long as the lane has existed, which is a reminder that the competitive set is
decided by what you built, not by the category you filed yourself under.

---

## 1. Agent identity & reputation standards

### ERC-8004 "Trustless Agents" — the most important thing on this page
Ethereum standard (proposed Aug 2025, live implementations on mainnet and
several L2s/chains through 2026) defining three on-chain registries:
Identity (ERC-721 agent identities), Reputation (standardized feedback
signals), and Validation (hooks for validator contracts to publish
results). Adopted by Avalanche, BNB Chain, and on the EF's 2026 roadmap.

- **Overlap**: their three registries are conceptually our agent registry +
  behavioral ledger + grading pipeline, as a neutral standard.
- **Difference**: ERC-8004 standardizes the *interfaces* for reputation; it
  deliberately doesn't define how reputation is computed, what it's worth,
  or what you can borrow against it. It's plumbing, not underwriting.
- **Our move**: this is not a competitor — it's a compatibility target.
  A Handsel credit score published *into* an ERC-8004 Reputation/
  Validation registry becomes portable and composable, and we become a
  "credit oracle" in their ecosystem rather than an island. Implemented
  and env-gated (`lib/onchain/erc8004.ts`); awaiting a registry
  deployment on the target chain.

### Skyfire — "Agent Passports"
Verified identity + payment credentials for agents; passports carry
reputation/spending history across platforms so vendors can screen agents.

- **Overlap**: reputation-that-gates-commerce, same instinct as our
  min-score job gating.
- **Difference**: identity/KYA + payments trust layer; no independent
  verification of *work quality*, no lending.

---

## 2. Agent-to-agent labor & commerce markets

### Virtuals Protocol / ACP — the closest functional competitor
The largest agent economy (18k+ agents claimed); its Agent Commerce
Protocol runs request → negotiation → escrow → **evaluation by evaluator
agents** → settlement, across multiple chains, with evaluators earning a
share of transaction value.

- **Overlap**: this is our Labor Market's shape — escrow plus an evaluator
  that isn't the worker. Their "market for specialized evaluation agents"
  is a decentralized version of what our platform runtime does centrally.
- **Difference**: (1) evaluation in ACP is itself agent-judgment — an
  evaluator LLM's opinion, with the same confidently-wrong exposure our
  quality_score has; our graded-fact class (exact-match answers,
  requester-authored test execution) is mechanically checkable, not
  opinion. (2) ACP's output is per-transaction settlement; nothing
  compounds into a credit line an agent can draw against. (3) Scale:
  they are years and thousands of agents ahead — no point pretending
  otherwise.
- **What to steal**: evaluator-as-a-market (paid, reputation-scored
  evaluators) is roughly where our issue #7 design is heading anyway.

### Olas — Mech Marketplace
Agents hiring agents for tasks, 11M+ a2a transactions across nine chains
(Q1 2026 figures). Proven demand for agent-to-agent work.

- **Difference**: payment-for-service without independent quality grading
  or credit accumulation; reputation is usage-based, not verification-based.

### Recall Network
Competition network that ranks agents via live, verifiable competitions
(e.g. verifiable trading arenas with EigenCloud).

- **Overlap**: closest philosophical neighbor to our Proving Ground —
  capability demonstrated under controlled, verifiable conditions rather
  than self-reported.
- **Difference**: rankings/discovery are the end product; we treat the
  verified event as an *input to underwriting*.

---

## 3. Agent payment rails (complementary, not competing)

- **x402** — HTTP-402 stablecoin micropayments, Linux Foundation project
  (2026) backed by AWS/Google/Stripe/Visa/Mastercard/Amex. If agent
  payments standardize here, our draws/repayments/payouts should
  eventually speak it.
- **Payman** — spend management/budget caps for agents (our
  WALLET_MAX_TX_USD / daily-cap logic as a product).
- These make agent *spending* safe. None of them decide whether an agent
  *deserves* a credit line — that's upstream of them, where we sit.

## 4. Agent credit & lending — the thin field we're actually in

Early 2026 saw the first experiments in underwriting loans against an
agent's on-chain economic activity, and middleware maintaining behavioral
score vectors per agent (e.g. ACHIVX's seven-dimension model) for banks
evaluating agent trust. The category exists, is young, and is mostly
*analytics* — scoring as a report, not scoring wired to an enforceable
on-chain limit with draw/repay/default consequences feeding back into the
score. That closed loop is Handsel's specific claim, and as far as we
can tell it remains rare enough to be a real wedge.

(One anonymous reviewer referenced a "NEXUS" agent-credit design family in
a private message; we could not identify a real project by that name —
noted here for completeness, not as evidence.)

## 5. DePIN / decentralized compute — the adjacent giant

Bittensor, io.net, Akash, Render, Nosana: idle GPUs earning again. The
structural difference we hammer in the pitch deck: **they bill for GPU
time because time is trivial to verify and quality isn't; mining paid for
hashes, they pay for hours, we pay for work being right.** Gensyn is the
interesting outlier — cryptographic verification that ML *computation* was
performed as specified (reproducible execution) — but it verifies the
computation, not the usefulness of the deliverable to a requester.

## 6. GitHub-native bounty markets — where the repo-jobs lane actually competes

Sections 1–5 are the agent-economy framing. But the `repo-jobs` lane
(`docs/github-jobs.md`) ships into a market that already exists and has
nothing to do with agents: **paying for a GitHub issue to get closed.** This
section was missing until a stranger forked this repo alongside
`ubiquity/research`, which was a fair hint that the comparison set here is
not the one we had written down.

Two distinct incumbents, and our lane is the intersection of them — which is
the strongest thing about the position and also the reason both sides can
eat it.

### 6a. Bounty-on-an-issue platforms (money, human workers)

**UbiquityOS / Ubiquity DAO.** The closest thing to our label-to-bounty bot
that actually exists. Label a GitHub issue with a price and their bot pays
the contributor in crypto when the issue closes — xDAI to a wallet or USD to
a card, with comment incentives and XP on top. Around it sits a real
payments stack (`pay.ubq.fi` permit generation, `checkout.ubq.fi`) and a
"DevPool" contributor funnel.

**Algora.** The same primitive with a US-fintech spine instead of a DAO one:
`/bounty $1000` as an issue comment, and they handle payouts, compliance and
1099s. Their pitch has drifted toward hiring — bounties as an audition for
contract and full-time work.

- **Overlap**: the trigger gesture is identical. A human writes a price onto
  an issue and money is committed to whoever resolves it. If someone only
  wanted "label an issue, pay a contributor", both are more mature than us
  and one of them handles tax forms.
- **Current activity (checked 2026-07-27).** Separate axis from maturity, and
  worth tracking on its own: UbiquityOS's core repos (kernel, plugin-sdk,
  plugin-template) were last pushed **2026-04-21/22**, roughly three months
  ago; the UbiquityOS topic in their Telegram has been silent since
  **2025-04**; and their plugins-wishlist carries an open issue titled *"15+
  days no maintainer response"* from 2026-05, with most issues there opened by
  org members rather than outsiders. A quiet project, not an abandoned one —
  April is recent and small teams go quiet. Algora looks the livelier of the
  two, with bounty awards through **May–June 2026**. These dates are the most
  perishable claims in this section; re-check before quoting them.
- **Difference (1) — when the money is committed.** Both are pay-on-outcome:
  the funder is trusted to be good for it, and the contributor claims
  afterwards. Ours escrows at posting time, on-chain, before any worker sees
  the job. That is worse UX and a strictly stronger promise, and it is the
  only reason a *machine* can safely take the work — an agent cannot chase
  an invoice.
- **Difference (2) — what closes the loop.** Theirs pays on issue close.
  Ours pays on **merge**, deliberately: CI green never moves money, because
  green tests on a bad diff is exactly the failure a bounty market invites —
  though the repo-jobs lane currently runs on the testnet deployment only
  (the GitHub App is not configured on mainnet).
- **Difference (3) — what accumulates.** Theirs accumulates a payment
  history. Ours accumulates an underwritten credit score that unlocks
  borrowing. That is the whole thesis and neither of them is trying to do it.
- **Honest caveat**: I have not read Ubiquity's escrow internals. "Permit
  generation" strongly implies claim-after-the-fact rather than lock-up-front,
  but this is inference from their public repo names, not verification.

### 6b. Autonomous coding agents (workers, no market)

**GitHub Copilot coding agent** is the one that matters. Assign it an issue
and it works in a GitHub Actions sandbox, explores the repo, writes code,
runs tests, and opens a PR for review — with CodeQL, secret scanning and
dependency review built in, and MCP integration for pulling external
context. Devin, OpenHands/SWE-agent and Codegen occupy the same slot with
different distribution.

- **Overlap**: this is our worker, and it is first-party to the platform our
  jobs live on. For the specific act of turning an issue into a PR, Copilot's
  coding agent is better resourced than anything claiming a job from our
  board, and it is one click from where the issue already is.
- **Difference**: it is a **worker without a market**. There is no price on
  the issue, no escrow, no counterparty, no independent grader, and no record
  that transfers anywhere. It does work for the repo that pays for its seat.
  Nothing about it lets an unknown third-party agent bid for the job and be
  trusted with it.
- **Where this actually lands**: Copilot's agent is a plausible *supplier* to
  our market, not only a competitor — the same way `foreman` is. A market
  whose workers include first-party coding agents is a better market. The
  thing we must not do is compete with it on raw diff quality.

### The intersection, stated plainly

Neither half has the other's piece. Bounty platforms have a market with human
workers and no verification layer that a machine could be graded by. Coding
agents have machine workers with no market, no escrow, and no portable record.
Handsel's repo-jobs lane claims the intersection: **an escrowed price on an
issue, an arbitrary agent taking it, an independent grade, merge as the only
release trigger, and a score that follows the worker to the next job.**

The risk in that sentence is that an intersection is defensible only while
both sides ignore it. UbiquityOS adding agent workers is a smaller step than
us building their payments maturity; GitHub adding a price field to issues is
a smaller step still.

## 7. Dispute-resolution prior art (design inputs for issue #7)

- **Kleros** — staked, incentive-compatible juror courts with appeal
  escalation.
- **UMA Optimistic Oracle** — assertions stand unless disputed within a
  window; bonds punish wrong disputes.
- **Reality.eth** — escalating-bond answer market.

These are the reference architectures for replacing our single-EOA
arbiter; our addition (per issue #7 discussion) is domain-scoped reviewer
reputation computed by the same behavioral engine that scores workers.

---

## Honest threat ranking

1. **Virtuals ACP** — could add credit/underwriting on top of their scale
   faster than we can build scale under our underwriting.
2. **ERC-8004 ecosystem** — if reputation becomes a commodity standard,
   the moat moves entirely to underwriting quality and verified-grading
   supply; good for us only if we integrate early.
3. **A well-funded fintech** entering agent credit top-down (bank-style
   scoring per ACHIVX direction) with compliance resources we lack.
4. **GitHub itself**, to the repo-jobs lane specifically. A price field on an
   issue plus the coding agent it already ships would be most of our GitHub
   story, first-party, with distribution we cannot approach. Our answer has
   to be the part GitHub structurally will not build: an *open* market where
   the worker is a stranger and the grade is what makes them trustable.
5. **UbiquityOS / Algora adding agent workers.** Bolting agents onto an
   existing bounty market is a shorter path than bolting a payments-and-
   compliance business onto ours. Their missing piece is grading; ours is
   maturity and users. Ranked 5th rather than higher on current activity
   (§6a), not on how short the path is: the path really is short, but a
   project three months between pushes is not walking it today. Algora is the
   live half of this row.

## Why we still think the wedge is real

- Verified-work grading (ground truth + test execution) as the *input*,
  enforceable on-chain limits as the *output*, and repayment behavior
  feeding back — no one listed runs all three.
- Solo-buildable surface today; standards (ERC-8004, x402) are arriving
  exactly when we'd need portability.
- The failure modes everyone else defers ("who grades the grader",
  "confidently wrong", Sybil resets) are already our public issues (#6,
  #7) — being early on the hard part is the moat a small team can afford.
- The repo-jobs lane sits on an intersection nobody occupies (§6): bounty
  platforms have a market without machine-gradeable verification, coding
  agents have machine workers without a market. Thin ice, but ice.

*Sources for §6, checked 2026-07: github.com/ubiquity and the Ubiquity Bounty
Bot marketplace listing; algora.io; the GitHub blog post on assigning issues
to the Copilot coding agent. Everything attributed to a competitor here is
from public material — where I am inferring rather than reporting, the text
says so.*


---

# Second pass, 2026-08-03

*Prompted by a landscape summary that arrived from outside. Roughly half
survived checking, and the half that did not is the more useful half. Every
project below was confirmed to exist before being written down; the two EIPs
were read from the spec text rather than from commentary; single-source claims
are marked as reported rather than verified.*

## The framing this pass corrects

The July version leads with the wedge as *"credit underwriting"*. That is the
phrase `docs/product-thesis.md` — written a few days later, after an outside
critique — explicitly rejects:

> *Not "credit for AI agents". That phrase is **true and useless**: it
> describes a market that mostly does not exist in 2026, and it buries the one
> case here that is real and checkable.*

The defensible claim is narrower: **an escrow-collateralized advance to a
prime contractor, where the score prices execution risk and therefore sets
LTV.** Nothing in the table below is making that claim. The broad one, several
of them are.

## ERC-8183 — the standard that arrived on top of what we built

New since the July pass, and the more consequential of the two EIPs.
Virtuals Protocol with the Ethereum Foundation. It standardises the **Job
primitive**: client, provider, evaluator, escrowed budget, lifecycle
`Open → Funded → Submitted → {Completed, Rejected, Expired}`, evaluator alone
may complete. ([EIP-8183](https://eips.ethereum.org/EIPS/eip-8183) ·
[context](https://cryptobriefing.com/erc-8183-virtuals-protocol-ethereum-ai-agent-commerce/))

That is LaborMarketV2's shape. Which is not a threat to anything the thesis
claims — *"the asset is the ledger, not the score"* — and is a reason to speak
the vocabulary instead of competing with it.

`lib/onchain/erc8183.ts` is the projection, with the gap analysis in its
header. The summary:

| | Cost |
|---|---|
| **V2 → 8183** (export) | A pure function. Every V2 job projects into an 8183 state. Shipped. |
| **8183 → V2** (conform inbound) | A new contract. 8183 has the client *assign* a provider; this market has the worker *claim* one, behind a credit gate, staking a bond. That is the mechanism, not the interface. |

Three things the standard cannot represent, which the projection reports
rather than drops:

- **The worker bond.** 8183 has no state between funded and submitted, because
  its model is procurement — the client picks the provider, so nothing needs to
  make claiming costly. The bond is this market's Sybil resistance on the
  supply side, and it is invisible in 8183.
- **The dispute process.** `Disputed` projects to `Submitted`, which is the
  right lifecycle position (delivered, evaluator has not ruled) and loses the
  procedure.
- **The word *Expired*.** 8183 means "refunded to the client after timeout".
  V2 means "settled by a deadline with no verdict", and `expireReview` pays the
  **worker**. Same word, opposite settlement.

## ERC-8004 — the July call now has evidence

July called 8004 "the most important thing on this page" and treated
portability as the arriving tailwind. `docs/product-thesis.md` then argued the
opposite from first principles:

> *If identity is free, a portable reputation is **portable for the forger
> too**. Portability and Sybil resistance are not two problems. They are one
> problem, and portability makes it worse.*

An empirical study of the deployed 8004 ecosystem has since found a
substantial share of registered agents inactive or non-functional, and named
**reputation gaming and Sybil attacks** as the critical vulnerabilities —
concluding that *"decentralized verification mechanisms alone may prove
insufficient"*. ([arXiv 2606.26028](https://arxiv.org/abs/2606.26028))

Prediction and measurement agree. Two cautions on using that:

1. The paper says the ecosystem is gameable, **not that anyone solved it**.
   Handsel has not. `docs/self-sybil.md` is an admission, not a defence.
2. The July claim that standards are "arriving exactly when we would need
   portability" now reads as the wrong wish. What is arriving is the surface
   this project decided not to build on, and being right about that is worth
   more than the interop would have been.

## Kojiru — the nearest product, and closer than expected

Not in the July pass. Positioned as credit infrastructure for agents.
([source](https://finbold.com/fico-was-built-in-1989-ai-agents-need-a-score-for-2026/)
— one article, so details are reported rather than verified)

| | Kojiru | Handsel |
|---|---|---|
| Chain | Base mainnet | Base mainnet |
| Score range | 300–850 | 300–850 |
| Primary axis | *Operational Integrity* — probability of successful task completion | Execution risk, from graded outcomes |
| Model | Recursive Bayesian, updated per task | Rule-based + sample-size damping (`lib/credit-engine/scoring.ts`) |
| Lending | Collateralized, per-task escrow vault | Collateralized, draw against posted USDC |
| Lender side | Bilateral lines; the funding lender bears the default | **Not built** — nothing consumes `advanceLimit` |
| Formal verification | 8 contracts, Certora | Slither + Mythril, dispositioned |
| Usage published | none found | 17 agents, $0.06 credit line |
| Sybil | not addressed in the source | `docs/self-sybil.md`, unsolved |

**The core insight converged.** Kojiru's first axis is *probability of
successful task completion*; the thesis independently reached *"execution risk
is what a record of graded outcomes actually measures"*. Two teams landing in
the same place is evidence the place is right.

**Both are collateralized, and that is the sharp observation.** Kojiru's
capital flows into a vault tied to one task and releases on evaluator
confirmation; the agent never holds general funds. So the thesis's own line
applies to them at full strength:

> *A loan against observable collateral does not need a credit score — it needs
> an escrow lookup.*

Two agent-credit protocols on Base both quietly collateralize everything, and
both therefore have a score doing less work than the pitch implies. The
difference is not architectural — **one of us wrote it down.** That comparison
is only usable because it is self-implicating first.

**Their per-task escrow is itself a partial Sybil answer**, and a good one: a
forged score buys a credit line, but funds only ever land in a vault an
evaluator releases. Worth borrowing the thinking from even while the
portable-score half looks exposed.

**Ahead of us:** the lender side exists, Certora beats Slither+Mythril, and
they have a capital-attraction path (published staking APY). **Behind us:** no
published usage, and no public accounting of what their evaluator network
costs in trust — every project here relocates trust to an evaluator, and this
is still the only one that shows the invoice (`GRADER_WEIGHTS`, and the hole
in it).

## The Agentcoin question

A collaboration thesis arrived with the summary: mining as the currency layer,
Handsel as the labour layer, five integration points. Two of them are opposite
in quality.

**Staked tokens as collateral — sound.** Observable collateral needs a lookup,
not a score, and this plugs into a mechanism that exists.

**Mining history as a credit signal — unsound**, and not for the usual reason.
The objection is not that the trust models differ and weights need tuning. The
two measure **different quantities**: proof-of-work proves *compute spent*, and
the score exists to price *execution risk*. An agent with a flawless mining
record has demonstrated nothing about finishing a job. In `GRADER_WEIGHTS` it
would be a ruler in a table of thermometers.

One honest use, and it is the more valuable one:

> Mining history as a **cost-to-forge signal**, not a competence signal.

What proof-of-work genuinely establishes is that an identity cost money — which
is Sybil resistance, the hole both the arXiv study and this project's own
thesis point at. It even fixes cold start honestly: not *"this agent is good"*
but *"this agent is expensive to throw away and remake"*.

## What this pass changes

Nothing about what to build next, which is the right outcome for a landscape
document and the reason to distrust one that concludes otherwise. Three
smaller things:

1. **Speak ERC-8183** — the projection exists; use its vocabulary.
2. **Stop saying "credit for AI agents"** — the field says it, it is true and
   useless, and the narrow claim is the only defensible one.
3. **The lender side is the real gap**, and a competitor shipping it first is
   the concrete version of the thesis's own "not built" list.

*Unverified, listed so the next pass knows where to start: AgentKarma, iAgentFi,
ChainAware, Kustodia, RIP-302, AI Lance, AGIJobManager, OKX AI.*
