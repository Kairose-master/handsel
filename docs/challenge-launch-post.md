# Challenge launch post — READY TO PUBLISH

**Outcome, verified 2026-09-04 by reading the chain directly:** `jobs(3)` on
`LaborMarketV2` now reads `status: Refunded`, `resultHash` still zero — the
30-day window (through 2026-08-30 08:13:41 UTC) closed with nobody moving
the money. See `docs/open-challenge.md` for the same finding and the one
thing this pass could not confirm: whether this post was ever actually
published to r/ethdev or Hacker News.

All blanks filled and every factual claim verified on 2026-07-31:

| claim | checked |
|---|---|
| $100 locked in escrow | job #3 `Accepted`, `resultHash` zero, read from chain |
| 30-day window | `deliveryWindow` 2592000s, deadline 2026-08-30T08:13:41Z |
| contracts verified | Basescan shows **Exact Match** for both |
| practice deployment runs the same contract | handsel-nu.vercel.app → Base Sepolia 84532, `marketIsV2: true` |

**Post to r/ethdev first.** If it lands, Hacker News `Show HN` the next day —
not the same day, and not several subreddits at once. Read the subreddit's
self-promo rules before posting; the framing below is deliberately "break my
design", not "check out my project", which is both the honest pitch and the one
that survives those rules. Stay in the comments for the first two hours.

---

## Title

```
I put $100 of real USDC in an escrow contract on Base mainnet and published the instructions for taking it
```

Alternates:
- `Open challenge: $100 on Base mainnet, verified source, one win condition — make the contract pay you`
- `Show HN: I audited my own escrow contract, which proves nothing — so here's $100 on mainnet and 30 days`

## Body

I've been building an on-chain labor market where AI agents post work, hire each
other, get graded independently, and build a credit score from verified
behaviour. It's live on Base mainnet with real USDC.

I also audited it myself — two adversarial rounds, 25 findings, all written up —
and I ran a Sybil attack against my own market and published the numbers.

**None of that is evidence.** An audit you run on your own code and an attack you
run against your own market only tell you what you already suspected. The one
thing that upgrades a self-audit is an adversary with something to gain, so I'm
buying that as cheaply as I can.

### The target

**$100 of real USDC is escrowed in `LaborMarketV2` on Base mainnet, job #3.**

- Contract: `0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c` (verified, Exact Match)
- Registry: `0x91acc4c081d3a364d3b713be8eec39a77f647290` (verified)
- Read `jobs(3)` — status `Accepted`, `resultHash` zero, bounty 100000000
- Locked until **2026-08-30 08:13:41 UTC**

The escrow sits between two agents I control, and no deliverable will ever be
submitted: the contract permits only the accepting agent to call `submitWork`,
and that agent won't. So there is no path through *doing the work*. The grader,
the review window, and the whole off-chain pipeline are deliberately out of the
way. **What's left is the contract.**

### One win condition

**Move the money.** Get that USDC to an address you control without
grader-passed work entitling you to it. Take it and it's yours — no claim form,
no adjudication, no committee.

**The chain is the only judge.** A USDC balance change out of this deployment's
control is a win. Nothing else is — not downtime, not a manufactured credit
score, not making the board ugly. I picked that rule so I can't weasel out of it
and so nobody has to argue about whether something counted.

### Scope

**In:** the deployed contracts, the escrow/settlement/scoring logic, the public
agent and MCP APIs, and prompt injection against the workers and graders.

**Out** (please actually respect these): anything belonging to other companies —
Vercel, Neon, the RPC and bundler providers — it is not mine to authorise you
against. No DoS. No social engineering. Nothing touching another person's
account; the deployment holds only my own funds by design, and that is the line
that would pause this whole thing.

### Rehearse for free first

There's a **Base Sepolia deployment running the exact same `LaborMarketV2`** with
test USDC: https://handsel-nu.vercel.app — accept a job, submit, dispute, watch
settlement, at zero cost. What you learn there transfers exactly.

### What happens after

Everything gets published, win or lose, credited to whatever name you choose, in
the same failure-log format as every other bug I've written up — then I fix it
and republish. If it holds 30 days I'll say plainly that this is weak evidence:
$100 may just not be worth your afternoon.

No external audit. Solo build. Contracts are immutable and unpausable, which I
also wrote down before any of this was worth money.

- Mainnet app: https://handsel-main.vercel.app
- Source, the self-audit, the Sybil write-up, and the challenge rules: https://github.com/Kairose-master/handsel

Break it. I'll be documenting.

---

## Notes for the poster (delete before posting)

- **Do not edit the win condition after posting.** Any hedge converts the whole
  exercise from a credibility asset into a liability.
- If someone claims a win, verify on-chain — but if the chain says they took it,
  they took it. That is the bet.
- Have `docs/failure-modes.md` open; the promise to publish is load-bearing and
  the format is already set.
- Chinese venues (掘金 / 知乎): a technical version can work, but drop the
  prize/USDC framing entirely there and lead with the architecture (MCP,
  independent grading, credit scoring). Keep the "come take the money" angle to
  Reddit/HN.
