# Challenge launch post — draft

Fill the three `⟨…⟩` blanks after pre-flight (the live page URL, the escrow
address, the end date), then post. Suggested venues, in order: r/ethdev or
r/CryptoTechnology first (technical, expects an address), then Hacker News
"Show HN" if the first lands. **Post once per venue; do not cross-post the same
day** — that reads as spam and is how the last promo attempt got removed.

Do NOT frame this as "earn money" or a way to make USDC — on-thesis and
regulation-safe, the pitch is *break my design*, not *come get paid to trade*.

---

## Title options

- `I put $100 of real USDC on Base mainnet and published the instructions for taking it — a labor market for AI agents, self-audited, now open to actual adversaries`
- `Show HN: A credit market where AI agents hire each other — here's $100 on mainnet and the exact way to try to steal it`
- `I built an on-chain market where AI agents grade and pay each other. I audited it myself, which proves nothing. So here's $100 and an open invitation to break it.`

## Body

I've spent the last few weeks building **Handsel** — an on-chain labor market
where AI agents post work, hire each other, grade the results independently, and
earn a credit score from verified behavior that unlocks borrowing. It's live on
Base mainnet with real USDC. Solo build, open source.

I also audited it myself: two adversarial rounds, 25 findings, every one written
up. And I ran a Sybil attack against my own market and published the numbers.

**None of that is evidence.** An audit you run on your own code, and an attack
you run against your own market, tell you what you already suspected. The only
thing that upgrades a self-audit is an adversary with something to gain.

So I'm buying that, in the cheapest way I can think of.

### The challenge

There is **$100 in real USDC** on Base mainnet at ⟨escrow address — Basescan
link⟩. The contract source is verified — read it, don't trust me.

**One win condition: move the money.** Extract that USDC to an address you
control without having done work that a grader legitimately passed. Whatever you
extract is yours — no claim form, no adjudication. The chain is the only judge:
a USDC balance change is a win, and nothing else is.

**Window: 30 days.** End date is on the live page: ⟨live page URL⟩.

(Two things people ask, up front: making the board ugly or knocking the site
over doesn't win — the money has to actually move. And manufacturing a fake
reputation score doesn't win either: on this system a high score only makes you
*eligible* to borrow against collateral you already posted, so faking it
extracts nothing. If that ever changes, this challenge changes with it.)

### The rules, short version

- Take it and it's yours — the rules are the rules, even if the route feels like
  a technicality. A hedge here would defeat the point.
- Everything gets published, win or lose, credited to whatever name you choose,
  in the same failure-log format as every other bug I've written up. Then I fix
  it and republish.
- **In scope:** the contracts as deployed, the escrow/grading/settlement/scoring
  logic, the public APIs, and prompt injection against the workers and graders.
- **Out of scope** (please actually respect this): anything belonging to other
  companies — Vercel, Neon, the RPC/bundler providers — it's not mine to
  authorize you against. No DoS. No social engineering. Nothing touching another
  person's account; the deployment holds only my own funds by design.

### Why I think there's no bad outcome here

If it holds for 30 days, that's weak evidence and I'll say so — $100 might just
not be worth your afternoon. If someone takes it, I get the one thing a
self-audit can never produce: a real finding from a real adversary, and a better
post than "nobody showed up." Both outcomes are cheaper than staying uncertain.

Read-only, no login, no wallet, nothing at stake if you just want to look at the
mechanics: ⟨testnet sandbox: https://ai-agent-credit-dashboard.vercel.app/try⟩

Source, the self-audit, and the Sybil write-up: ⟨repo link⟩

Break it. I'll be documenting.

---

## Notes for the poster (delete before posting)

- The three `⟨…⟩` blanks are filled only *after* pre-flight in `open-challenge.md`
  is done — especially the blast-radius cap. Do not post an address that holds
  more than the prize.
- Have `docs/failure-modes.md` open; the promise to publish findings is load-
  bearing and the format is already set.
- If a comment claims a win, verify on-chain before conceding anything — but if
  the chain says they took it, they took it. That's the whole credibility bet.
- Chinese venues (掘金 / 知乎): a *technical* version of this can work, but drop
  the prize/USDC framing entirely there and lead with the architecture (MCP,
  independent grading, credit scoring). The "come take the money" angle is a
  domestic-platform risk; keep that one to Reddit/HN.
