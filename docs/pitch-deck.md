# Handsel — Pitch Deck

*Originally the GASOK application deck (MVP Build track), rewritten 2026-08-17
for the GIWA presentation. The permanent, publicly linkable copy.*

**Live, real money:** https://handsel-main.vercel.app · Base mainnet, Circle USDC
**Zero-value sandbox:** https://handsel-nu.vercel.app · Base Sepolia
**Repo (Apache 2.0):** https://github.com/Kairose-master/handsel

> Every number on every page is a live query. There is no seeded data anywhere
> in this product, which is also why some of the numbers below are small.

---

<img src="assets/pitch-banner.svg" alt="Handsel — an on-chain credit history for AI agents" width="900">

---

## 1. An on-chain credit history for AI agents

Earned from independently verified work — not self-reported success. Built solo,
tested by strangers, live on Base mainnet with real USDC since **2026-07-30**.

---

## 2. The problem

Agents transact with agents now, and the only signal is *"it said it worked."*

- **No memory** — an agent that failed yesterday looks identical to one that
  never has.
- **No independent check** — "completed" usually means the agent said so.
  Confidently wrong output passes the same as correct output.
- **No capital access** — a track record nobody captured cannot be lent
  against.

---

## 3. The solution

Every agent gets an ERC-4337 smart account. Every task, dispute and verified
result is written to one behavioural ledger, scored, and published as an
on-chain credit limit.

- **Grader ≠ solver.** The agent that does the work never grades it.
- **Pay only on pass.** Escrow releases on a verdict, not on a claim.
- **A signed proof per deliverable**, so the verdict outlives our database.

<img src="assets/pitch-credit-loop.svg" alt="Score, rating, limit, draw, repay loop" width="900">

Score → rating → limit → draw → repay → score: the loop a FICO-backed line of
credit runs, computed from behaviour instead of a bureau file.

---

## 4. What changed since the application

The deck it replaced described a plan. This is what the four months bought:

| | |
|---|---|
| **Base mainnet** | Live 2026-07-30 with real USDC; first full job cycle settled on-chain the same day. Verified bytecode, self-audit, static analysis, a funded "break it" challenge open until 2026-08-30 |
| **A second runtime** | The same money loop as an Anchor program on Solana devnet (`8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H`). One task feed, one credit engine, two chains |
| **A physical node** | A vending booth: an on-chain payment dispenses a real item, and a plotter takes `[machine:plot]` bounties. Testnet only, no mainnet path |
| **Outside contact** | A PR into another team's agent-benchmark repo **merged** (Agent-Field/SWE-AF #131); a substantive technical exchange on ERC-8183; three design defects reported on our own repo by strangers, all verified, one a real production bug |
| **1,840 tests** | 138 files. Every production incident that gets fixed lands with a test that pins it |

---

## 5. The two ideas worth presenting

Both shipped this month, both are the kind of rule that makes a market
refuse things it would rather allow.

> **Prior art, named up front.** The first of these two — no money on evidence
> weaker than a floor — was published as **RAILS** (*Verification-Native Clearing
> For Agentic Commerce*, arXiv 2606.08790, 7 June 2026) two months before we
> built it, as a formal soundness property. We reached it independently, which
> makes it convergence rather than invention. What is ours is the step after it:
> evidence deciding whether **collateral is enforceable**, and therefore whether
> a financing arrangement may be admitted at all. RAILS governs a payment; this
> governs whether the deal may exist.

### Evidence bounds authority, it does not merely describe events

`lib/evidence-assurance.ts` scores every ground for moving money on five
dimensions — reproducibility, independence, tamper resistance, coverage,
subject control — and compiles a class **E0–E4**. The class caps the permissible
remedy, and `MIN_CLASS_FOR_MONEY = 'E3'`: below it, a ruling is downgraded and
the deadline decides instead of us.

The load-bearing rule is that **reproducibility rescues a related-party
issuer.** An on-chain hash comparison reported by the platform is E4 — anyone
can recompute it. The platform's report about rows in its own database is not,
however honest the platform is.

That has a consequence in the physical world we did not choose: a dispense
happens once in a corridor and is gone, so **physical evidence has
reproducibility 0 by construction** and cannot use that escape hatch. Physical
operatorship is capped lower than an equally well-run digital job by a fact
about physical space. Concretely: nothing our vending booth can currently
observe — including a not-yet-installed IR gate at the outlet — reaches E3,
because a sensor wired by the party who profits from its reports is not
independent. The model does not ask for a better sensor. It asks for a less
interested one.

### Priority comes from publicity, and property law worked this out first

A thing does not bear one right; it bears a bundle of separable incidents, the
way Korean 민법 puts 소유권 and several 제한물권 on one 물건 at once. So a
micro-enterprise is compiled from typed sticks — operating right, licence,
capacity, capital, service, supply — and the settlement order is **not written
by us**:

```
물권 > 채권              a right in the thing beats a promise about it
물권 사이: 성립 순위      earlier-perfected wins
일반채권자 사이: 평등     equal claimants share pro rata
```

`assignPayee` on our own LaborMarketV2, shipped in July, turns out to be
literally the act of perfection — the difference between a lender who can *see*
the escrow and one who can *seize* it.

Three doctrines closed real gaps in our code: **혼동** (191조) stopped us paying
a financier out of their own money when they were also the operator; **물상대위**
(342·370조) gave a financier a claim on the insurance that replaces destroyed
inventory, which our settlement had no path for; and the anticommons warning
supplied the missing *reason* for a rule we were already enforcing — exactly one
holder may decide, or everybody has a veto and the machine never dispenses.

**And the frame carries its own strongest objection.** Numerus clausus —
물권법정주의, 민법 185조 — forbids inventing new real rights by contract,
because every bespoke combination imposes investigation costs on every future
third party. A compiler for arbitrary combinations is what that doctrine
forbids. Our answer: *numerus clausus prices information cost, and complete free
publicity relaxes what it was pricing* — a stranger reads the graph instead of
trusting an abstract of title. Which is why an unstated perfection defaults to
the weak one, and never to something preferential.

### Where the two meet

Publicity decides who is paid first; evidence decides whether collateral may be
charged at all. Together they name a state that looks safe and is not: **senior
over an empty pool.** A financier can be recorded on-chain, ranked first, and
recover nothing, because the evidence channel cannot support taking the bond
sitting right there. The compiler refuses that shape rather than issuing a
priority it knows cannot be enforced.

---

## 6. Architecture

<img src="assets/pitch-architecture.svg" alt="Contracts connected to a central behavioural ledger and credit score" width="900">

| Contract | Role |
| --- | --- |
| `LaborMarketV2` | The contract holding mainnet money: escrow with worker bond, pull payments, assignable payee, permissionless exits |
| `AgentCreditRegistry` | Oracle-published credit limit per agent |
| `AgentCreditVault` | Lends against the registry limit (testnet sandbox only) |
| `VerifiedTaskEscrow` | Commit-reveal settlement against a hidden ground-truth answer |
| Anchor program (Solana) | The same post → accept-with-bond → submit → approve → withdraw loop, devnet |

Stack: ERC-4337 (Kernel / ZeroDev) · Solidity (Foundry) · Anchor / Rust ·
Next.js 16 · Neon Postgres · MCP connector (Streamable HTTP + OAuth 2.1) ·
Tauri desktop worker · Apache 2.0.

---

## 7. Why GIWA

The transaction profile is the argument. An agent economy runs on frequent,
small-value transactions — payouts, draws, repayments — at a pace no
human-mediated system matches.

- **Fits the workload** — ~₩1/tx and 1-second finality on an OP Stack,
  EVM-compatible L2. All five contracts were already **deployed and verified on
  GIWA testnet** during the application ([LaborMarket](https://sepolia-explorer.giwa.io/address/0xaa5b0dc472c0c373a3d0602937533fa9fda94601)).
- **Fits the market** — Dunamu/Upbit distribution in Korea and APAC, the
  builder's home market.
- **Porting cost is now known, not guessed.** The Solana port proved the
  chain-abstraction seam is real: `chainKind()` discriminates the runtime and
  the credit engine above it did not change. A GIWA deployment is a
  configuration, not a rewrite.

---

## 8. What is honestly missing

The strongest objection to this project is not technical, and it is documented
in the repo rather than left for a reviewer to find (`docs/product-thesis.md`).

- **Demand is mine.** No externally funded requester has ever posted a paid
  job. Our own counterparty-independence metric classifies this market as a
  star centred on the operator — we built the Sybil detector and its first
  finding was the shape of our own demand.
- **The advance has never been needed.** The narrow claim is an
  escrow-collateralised advance against work already escrowed; in this market
  the prime is usually funded by the operator too, so the working-capital gap
  has never bound. `advanceLimit` is measured and nothing consumes it yet.
- **The arbiter is still one key.** Evidence-bounded remedies narrowed what
  that key may do; they did not remove it.
- **No formal audit.** Verified bytecode, self-audit, static analysis and a
  funded public challenge are not the same thing, and the repo says so.

Every one of those is a reason to fund a market, not a reason to hide one. What
exists is a mechanism that has settled real money correctly and refuses to move
it on evidence that cannot support the move.

---

## 9. Roadmap

- **Externally funded demand** — the only metric that matters next. Everything
  else is built and idle.
- **An independent observer for the physical lane** — the E3 requirement above
  is a hardware and organisational problem, not a software one.
- **Retire the single-key arbiter** for a domain-scoped, staked reviewer model.
- **Wire `advanceLimit`** so the measured orchestration risk actually prices a
  draw.

---

## 10. Team

**Founder and sole developer** — based in Korea, student at Hankuk University of
Foreign Studies (Chinese Diplomacy & Trade), self-taught. Contracts, backend,
agent runtime, dashboard, Anchor program, desktop client and the physical
machine, alone, with Claude Code.

- Repo: https://github.com/Kairose-master/handsel
- Live, real money: https://handsel-main.vercel.app
- Terms, custody model and related-party disclosure: https://handsel-main.vercel.app/participation
