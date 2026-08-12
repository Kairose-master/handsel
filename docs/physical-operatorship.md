# Physical operatorship — the machine lane

The planning document for Handsel's physical extension. Written 2026-08-12
after the vending booth (the first physical node) closed its full loop;
restructured the same day when the taxonomy below sharpened. This is a
PLAN: increments 2–4 are not built. Increment 1 (the recipe market) is
live in the booth repo (`kairose-master/onchain-vending-machine`).

## Definition

> **Physical operatorship** is the right of a third party to set
> economically meaningful policy inside a physical asset someone else
> owns, and to receive the residual profit or loss of that policy.

Every word is load-bearing. *Policy* (not tasks — a courier follows
instructions, an operator decides). *Someone else's asset* (else this is
just small business). *Residual* (not a wage, not a fee per unit — the
upside AND the downside of being right about demand).

## The two questions

The generative question: **"Which real-world actions that only companies
can perform today can become one API call?"** — product placement,
fabrication, inspection, brand creation, routing, measurement.

The economic question underneath it: **"What is the smallest
independently operable unit of a company?"**

| Company | Smallest operable unit |
|---|---|
| store | a shelf |
| factory | a recipe |
| laboratory | a protocol |
| measurement firm | a measurement task |

Which makes the machine lane, in one sentence:

> **A protocol that compiles a company function into micro-concessions.**

## The intellectual core: ownership/control separation, one layer down

The 20th-century corporation's structural invention was
`capital owner ≠ manager`. This structure is the same separation applied
to micro-assets — with one substitution that changes everything about who
gets to participate:

```
Corporation:            shareholders → board → managers → physical assets
Operatorship network:   asset owner → protocol → permissionless operators → micro-assets
```

In a corporation the **board selects** the manager; here the **market
selects** the operator — anyone may enter, and grading, bonds and
reputation decide who stays. A vending slot under this regime is not a
tokenized asset; it is a **micro-concession** (초소형 영업권) — the thing
a franchise sells, shrunk to one shelf and made permissionless.

## Necessary and sufficient conditions

A participant is an *operator* iff all four hold:

1. **Policy discretion** — they set at least one economically meaningful
   variable: assortment, price, recipe parameters, placement.
2. **Residual claim** — income is revenue minus costs, not a wage per
   task or rent per unit of capacity.
3. **Downside exposure** — capital or stake at risk when their demand
   judgment is wrong: unsold inventory, a slashed bond, a forfeited slot
   fee.
4. **Non-ownership of the asset** — the policy executes through a machine
   they do not own.

Drop any one and the structure degenerates into something that already
has a name — which is precisely what makes the conditions useful:

| Missing condition | Degenerates into | Existing name |
|---|---|---|
| discretion | renting out capacity | classic DePIN supply |
| residual claim | paid per task performed | (machine) labor |
| downside | free options on the asset's audience | spam — must be re-created with bonds/curation |
| non-ownership | owner-operator | ordinary small business |

This taxonomy is why the claim here is a **market-structure claim**, not
a collection of machine ideas.

## The three sub-markets (and their canonical archetypes)

The earlier draft put everything under "operatorship". Strictly, only one
of the three is; naming all three makes the thesis sharper, and Handsel's
existing machinery serves each differently.

| | **Operator market** | **Physical app market** | **Machine labor market** |
|---|---|---|---|
| Canonical form | **vending slot** micro-market | **plotter/microfactory recipe** | **physical oracle bounty** |
| Participant sells | stocked goods at their price | a behavior program (recipe/CAD/protocol) | execution of an external task |
| Conditions met | all four — the pure case | discretion + residual (royalty ∝ sales); downside ≈ 0 at free registration | residual? No — paid per task. **The machine owner here is a worker, not an entrepreneur** |
| Economic role | residual claimant | royalty-earning author (app-store developer) | wage earner with capital |
| Failure mode | unsold inventory (self-punishing) | registration spam — the missing downside must be re-created (curation, listing bonds, shelf-space limits) | shirking/fraud — needs verification, which is what grading is |
| Handsel machinery | escrow + splits + credit; slot lease = a job with a duration | recipe registry + royalty splits (booth increment 1, live) | worker registration, directed claim, image grading, bonds — **increment 2 literally registers the machine as a Handsel worker agent**, which is the honest classification |

The three are one project because they run on one settlement/verification
rail and one reputation ledger — not because their participants play the
same economic role. They don't, and the document should never again imply
they do.

## Trust-layer requirement ↔ existing part, mapped

| The lane needs | Handsel already has |
|---|---|
| Money held until the machine actually performed | LaborMarket escrow, pay-on-pass (`lib/labor-settle.ts`) |
| Someone other than the operator saying it was done | independent grading — CI lane, image/vision lane, LLM lane (`docs/graders.md`) |
| Proof that survives the platform | signed work proofs (`lib/attestation.ts`, `/api/proof/<id>`) |
| Punishing no-shows without paying anyone to trigger it | bond slash **burned** (`_burnBond`, same on Solana) |
| Letting good operators do more | behavior-earned credit → borrowing (`lib/credit-rules.ts`, `lib/reputation-lending.ts`) |
| Machine-to-market payment with no accounts | x402 rail (`/api/jobs/external` — the booth is its first real client) |
| External executors joining permissionlessly | external MCP workers (`lib/mcp-client.ts`), headless worker API |

## Vertical map, filtered by physics/regulation

Now organized under the three sub-markets. The vending micro-market —
the example that generated the thesis — leads its column instead of
hiding behind increment 1.

| Vertical | Sub-market | Reality filter | Verdict |
|---|---|---|---|
| **Vending slot micro-market** | operator | cheapest real MVP of PURE operatorship; needs a slot machine + lease contract (a Handsel job with a duration) | **The canonical case — software SHIPPED in the booth repo** (lease registry, price-as-address payment routing, per-sale on-chain lessee payout, sold-out refund ledger, multi-servo firmware). Awaits multi-servo hardware to go physical |
| Recipe/transformation market | physical app | goods are low-liability (paper, engraving) | **Live — increment 1 in the booth** |
| Micro-Lab / test protocols | physical app (protocol author) + machine labor (machine runs it) | output is information: no inventory, ~0 marginal cost; calibration is the hard part; high-stakes verdicts (authenticity) carry liability | Increment 2 territory; start with low-stakes measurements |
| Physical bounty / oracle | machine labor | same market as Micro-Lab, demand side first | **Increment 2** |
| Micro-Brand Factory (drinks, perfume) | physical app, aspirationally operator | ingestible/on-skin → food & cosmetics law immediately. Realistic shape: licensed operator owns the compliance shell; creators sell parameters within a safe envelope (the Coca-Cola Freestyle structure) | Later; needs a licensed partner |
| Arcade app store | physical app | lowest liability, most viral, low ceiling | Demo vertical, not a wedge |
| Logistics router | operator (policy over flows) | needs infrastructure density only campuses/offices have | A feature for an existing network, not a startup |
| Universal microfactory | physical app platform | every actuator multiplies failure modes; "sell → produce" (zero inventory) is the real insight | Arrives as a **standard protocol across specialized machines**, not one machine |

## Increments

Each increment now states which sub-market it serves.

**1 — Recipe market** *(physical app market — LIVE in the booth)*.
Third parties register card designs; every sale splits
`RECIPE_AUTHOR_BPS` (default 70/30) between author and booth, with the
author's share paid per sale as a real Base Sepolia USDC transfer when
the hot key is configured (accrued and labeled 적립, never 지급, when
not). Registration runs the real preview pipeline so an undrawable
design is refused at the kiosk, not discovered by a paying customer.
Sold cards keep the Handsel settlement lane; the job title carries the
recipe name and author. **Done when** a stranger's design sells to a
third person and the royalty tx hash lands. *Known gap vs the
conditions table: registration is free, so condition 3 (downside) is
unmet — spam pressure will decide when listing bonds or slot limits
arrive.*

**2 — Machine-as-worker** *(machine labor market)*. A machine registers
as a Handsel worker agent with declared capabilities (`plot`, `photo`,
`measure` — the capabilities field exists); demanders post escrowed
physical bounties; the machine's runtime claims by id (the booth's
directed-claim client generalizes), performs, submits sensor/image
evidence; the image lane grades; escrow settles. This is honest
worker-classification by construction. **Done when** one recurring
physical bounty settles N times unattended.

**3 — Multi-party splits** *(all three)*. Generalize per-job settlement
from (worker, fee) to a split table: author / machine owner / location.
The Withdrawable ledger is already per-recipient. Every vertical runs on
this one primitive — and it is what makes a slot LEASE (operator market)
expressible: lessee revenue, machine-owner cut, location cut.

**4 — Machine credit** *(the flywheel)*. Uptime, grading pass-rate and
settled revenue become a machine operator's credit score (engine
exists); borrowing against verified machine cashflow (lending code
exists) funds the next machine. The original thesis — behavior-earned
credit unlocking capital — closed in the physical world.

## Metrics that would falsify or confirm this

- # of designs registered by people who are not the operator (inc. 1)
- share of booth revenue earned by third-party designs
- # of physical bounties posted by strangers and settled (inc. 2)
- repeat rate: does any author register a second design?
- when a slot machine exists: do slot lessees renew at unsubsidized rents?

Zero third-party registrations after real booth traffic = the thesis
fails at its first gate, and this document gets a postmortem section
rather than quietly forgotten.

## Positioning lines (for GIWA / Eternal / interviews)

- EN: "The corporation separated capital from management; this separates
  physical-asset ownership from operation — and replaces the board with a
  market. A protocol that compiles a company function into
  micro-concessions: anyone can run one shelf, one recipe, one
  measurement, inside a machine someone else owns, with escrow,
  independent grading and on-chain settlement making a stranger's slot
  trustworthy."
- KR: "회사가 자본과 경영을 분리했다면, 이건 물리 자산의 소유와 운영을
  분리하고 — 이사회 자리에 시장을 놓습니다. 기업의 기능 하나를
  초소형 영업권(micro-concession)으로 컴파일하는 프로토콜: 누구나 남의
  기계 안에서 선반 하나, 레시피 하나, 측정 하나를 운영하고,
  에스크로·독립 채점·온체인 정산이 낯선 운영자를 신뢰 가능하게 만듭니다.
  1호 노드가 이 펜 플로터 자판기입니다."

## Boundaries (unchanged from the booth's founding decisions)

- Testnet tokens are gifts with zero value; real money buys physical
  goods only. Nothing here changes the VASP analysis
  (`onchain-vending-machine` README) — and any vertical where third
  parties sell REAL goods through the machine re-opens the
  who-is-the-seller question and gets researched BEFORE it gets built,
  the same way the booth's structure was.
- No fake data anywhere: recipe sales counters, author earnings and
  bounty settlements are all real transactions or they are not shown.
