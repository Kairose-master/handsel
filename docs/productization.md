# Handsel — productization & positioning

> The engineering is deep; the positioning isn't. This doc picks the **one
> front door**, the target customer, the packaging, and the funnel — so every
> surface (landing, connector, docs, deck) says the *same* thing.

## The core problem we're fixing

Handsel is really **three products under one roof**:

- **Hire** — an agent hires other agents (escrow, independent grading, pay-on-pass).
- **Earn** — run a model, do graded work, get paid (desktop/headless miner).
- **Credit** — an on-chain reputation + credit line an agent earns from behavior.

When all three are the headline, a visitor bounces on "…so what is it?". The
fix is not fewer features — it's a **hierarchy**: one front door, one moat, one
funnel-topper.

## The decision

| Role | Which | Why |
|---|---|---|
| **Front door** (what we sell) | **Hire** | Lowest friction to first value — add one MCP server, your agent hires a swarm in 2 minutes. Tryable *today* on the free sandbox — or with real USDC on mainnet. |
| **Moat** (why we win, why we last) | **Credit** | Payments are now standardized (x402 → Linux Foundation). Trust isn't. Credit is *earned by using Hire*, so it compounds and can't be copied by cloning the UI. |
| **Funnel top** (attention → users) | **Earn** | The "run a model, earn" + Minecraft/viral angle pulls eyeballs; it feeds people into Hire. Not the headline (the original reason — testnet USDC made "earn" sound false — expired with mainnet, where earnings are real; the hierarchy still holds because Hire, not Earn, is the lowest-friction first value). |

**One-liner:** *A workforce and a credit score for your AI agent.*

## Target customer (ICP) — narrow on purpose

**Primary:** developers and power-users already running agentic tools — **Claude,
Cursor, ChatGPT, OpenClaw** — who hit the wall of *"my one agent can't do
everything / can't fan out / I can't trust a random agent's output."*

- They already live in an MCP-capable client → distribution is a config line.
- They feel the pain (single-agent ceiling) → the value is obvious.
- They're the ones who'll tell others → developer word-of-mouth.

**The one that has actually paid (added after the fact):** a **repo
maintainer** with a backlog and no time to review a fix. This is the only
segment where a stranger's real money has moved — a `bounty:$1` label escrowed
real USDC on mainnet, 2026-08-03 (`docs/github-jobs.md`, README). It is a
narrower and less glamorous ICP than the one above, and it is the only one with
evidence behind it, so it should lead the next round of message tests rather
than trail them.

**Not (yet):** enterprises, non-technical consumers, or "the whole agent
economy." Those are expansion, not the beachhead.

**Secondary (supply side):** people with idle compute/models who want their
agent to *earn* — they're the worker liquidity that makes Hire deliver. Recruit
them through Earn (miner, leaderboard, viral), not the front door.

## Positioning & message hierarchy

1. **Headline (Hire):** "Give your AI agent a workforce it can hire — escrowed,
   independently graded, pay only on pass."
2. **Proof (내실):** on-chain USDC escrow · grader ≠ worker · signed proof per
   deliverable · every number is live, nothing seeded.
3. **Moat (Credit):** "Every verified job compounds into an on-chain credit
   score — and a credit line the agent can borrow against."
4. **Why now:** x402 became a Linux Foundation standard; payment is solved, the
   trust/credit layer on top isn't — that's us.

Against alternatives:

- **vs OpenClaw / agent frameworks** — they orchestrate *your own* agents on
  *your* trust. We add a **market of third-party agents** + **escrow + grading +
  portable credit** so you can trust ones you didn't build. Complementary: we
  ship as an MCP server / ClawHub skill *inside* those tools.
- **vs raw x402 / payment rails** — they settle a payment. They don't tell you
  *who to trust, how much to release, or who may borrow.* That's the layer we are.
- **vs "just prompt a bigger model"** — a swarm with independent grading and
  pay-on-pass beats one context for parallel, verifiable, cost-bounded work.

## Packaging (product surfaces)

| Surface | Role in the funnel | State |
|---|---|---|
| **MCP connector** (`/api/mcp`, 51 tools, OAuth, no keys) | **The product.** "hire an agent to…" from inside Claude/ChatGPT/Cursor/OpenClaw | Live · on ClawHub, mcp.so, Smithery |
| **The office** (`/office`, `hire_office`) | **What a hire now produces.** A standing desk rather than one-shot fan-out: a roster, a pipeline, its own gas/bond automation, and two ways to sell itself. See `docs/office.md` | Live · zero outside customers |
| **Office sessions** (`/office/sessions`) | **What the office does over time.** Connect Claude Code once, give a goal; the office plans, runs it on your machine under a grant, checkpoints, verifies, pays within a written policy, asks you for the rest, resumes after a crash. See `docs/office-sessions.md` | Live · proven end to end on 2026-09-03 with the owner's own worker; no outside customer |
| **Landing** (`/guest`) + **zero-login try** (`/try`) | Prove it's real in 30s (live market, real proofs) | Live · re-cut to Hire (this session) |
| **Dashboard** (`/profile`, `/world`) | Observability + the credit story (score, proofs, balance sheet) | Live |
| **Desktop / headless miner** | Supply side + Earn funnel-top | Live |
| **SDK** (`sdk/`) + `/connect` | Programmatic adoption | Live |

**Naming:** keep **Handsel** as the platform. Give the wedge a **verb**, not a
new brand — the thing users *do* is "**hire**." Landing, connector help, and docs
should all use that verb consistently ("hire an agent to design a logo for $12").

## Pricing model

Charging is live on mainnet: 5% + $0.03 per posting, on-chain; the sandbox is
free. Keep the packaging honest about it:

- **Free tier** (sandbox deployment only) — connect, hire with faucet-funded
  test USDC, build credit.
- **Take rate** — already live: 5% + $0.03 of each escrowed bounty, charged
  on-chain at posting (the natural, usage-aligned revenue).
- **Credit/underwriting** — the long-term business: pricing risk on
  reputation-backed credit lines (interest/fee on drawn credit).
- **Not** a seat/SaaS subscription up front — it taxes the try-it moment that is
  our whole wedge.

## Activation funnel — engineer the aha

The single "aha": **"my agent just hired another agent, it did the work, an
independent grader passed it, and I got the result — and my agent's credit went
up."**

1. **Land** → "workforce + credit for your agent" (Hire headline).
2. **Connect** → one MCP line (or `/try` for zero-login).
3. **First hire** → on mainnet, "deposit USDC, then hire an agent to write X
   for $2"; on the sandbox, "mint 100 test USDC" and do the same for free.
4. **See the proof** → real output + signed Proof of Authorship & Grade.
5. **See credit move** → the score/limit tick up → the moat becomes visible.
6. **Return** → auto-mine / delegation for repeat, parallel work.

Instrument steps 3→5 (first-hire completion, proof view, credit delta) as the
north-star activation event.

## 90-day plan

- **0–30d — Sharpen & prove.** Re-cut landing to Hire (this session). Tighten the
  first-hire flow to ≤2 min. One canonical demo: "watch an agent hire a swarm,
  parallel, graded, paid" (the parallel-mining work makes this concrete).
- **30–60d — Distribute where the ICP lives.** Push the MCP connector / ClawHub
  skill in the Claude/Cursor/OpenClaw communities; developer write-up ("give your
  agent a workforce"); get to a handful of real repeat hirers.
- **60–90d — Compound the moat.** Make credit visibly *do something* (borrow to
  hire beyond balance), publish portable proofs/ERC-8004 so reputation reads
  outside the app. Line up the security review the grant funds.

## Metrics that matter (and the vanity ones to ignore)

- **North star:** completed **first hires** (posted → graded-pass → paid), weekly.
- **Activation:** connect → first-hire conversion; time-to-first-hire.
- **Retention:** repeat hirers; jobs per hirer per week.
- **Moat:** agents with a non-zero *earned* credit score; credit drawn & repaid.
- **Ignore as headline:** total agents, GitHub stars, page views — they don't
  prove the wedge works.

## What NOT to do

- Don't lead with "payments **and** credit **and** mining **and** governance."
  One door.
- Don't gate the try-it moment behind signup or a subscription.
- Earn is real money on mainnet — claim it there. But label the sandbox
  clearly: test-USDC earnings are a game/funnel, and blurring the two burns
  trust.
- Don't chase enterprise before a single developer hires twice.
