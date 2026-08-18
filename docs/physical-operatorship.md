# Physical operatorship — the machine lane

The planning document for Handsel's physical extension. Written 2026-08-12
after the vending booth (the first physical node) closed its full loop;
restructured the same day when the taxonomy below sharpened. Status: all three
archetypes now have shipped software in the booth repo
(`kairose-master/onchain-vending-machine`) — recipe market (physical app,
live), slot market (operator market, awaiting multi-servo hardware), and
the machine labor lane (`[machine:plot]` bounties). Increment 3 (multi-party
splits) shipped handsel-side 2026-08-12. Increment 4 shipped 2026-08-14 and
came back reversed — **operator** credit before machine credit, enforced as a
rolling bond withheld from earnings rather than an up-front deposit — along
with a fifth relationship the original taxonomy did not have: the machine as
**requester**, hiring its own restocking out of the lessee's accrual. Both
sit on a new unifying object (`Concession`) whose classifier makes the four
conditions executable. Still unbuilt: machine credit proper, and any
`instrumented` evidence (no sensor at the outlet yet).

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
| Physical bounty / oracle | machine labor | same market as Micro-Lab, demand side first | **SHIPPED (booth-side MVP)**: the booth polls the feed for `[machine:plot]` bounties, parses-before-claiming, claims by id, plots physically, submits a production record (evidence class disclosed: no camera — stats and G-code, not photographs). Camera evidence is the upgrade path |
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

**3 — Multi-party splits** *(all three)* — **SHIPPED (2026-08-12)**.
A job posted over x402 can carry `split: { recipients: [{role, agentId |
address, bps}] }` (`lib/settlement-split.ts`, validated at post time — a
malformed split refuses the post rather than dropping someone's share).
After settlement — both the auto-release path and a manual approve — the
platform transfers each share out of the worker agent's smart account
(`lib/settlement-split-apply.ts` over the existing `transferUsdc`).
Arithmetic rule: floor to the cent, worker keeps every remainder, so the
split can never pay out more than settled. Best-effort by design: the job
is already settled when it runs, so failures log SPLIT_INCOMPLETE naming
exactly which shares moved and which are owed — never a clawback, never a
wedged settlement. The on-chain contract is untouched: it still pays the
worker in full; the split is platform-orchestrated redistribution.

**4 — Operator credit** *(the flywheel)* — **SHIPPED in the booth
(2026-08-14)**, and it arrived with its priority reversed. This increment
was written as *machine* credit: a machine's uptime and settled revenue
become its score. Building it made the ordering obvious — a machine's score
only starts to matter when there are several machines, whereas an
**operator's** score matters on the very first one, and the operator's
record is the object that travels. A lessee who kept slot 3 stocked here
should be able to lease slot 1 over there against a smaller hold. Machine
credit is still worth building; it is now downstream of this, not upstream.

`onchain-vending-machine/watcher/src/operator-credit.ts` scores from events
the booth already generates — fill rate, stockouts (the operator's job
undone, not bad luck), restock latency and whether the restock was
*confirmed*, tenure, volume — weighting performance far above age and size.
No back-fill, and no rating at all under five metered events: one sale with
no stockouts is a 100% fill rate and means nothing.

The enforced mechanism is a **rolling bond, not an up-front deposit**.
Demanding collateral before the first sale excludes exactly the people this
market exists to let in; withholding a slice of earnings (30% unrated → 5%
proven, released automatically as the score rises) creates real downside
without requiring any capital to begin. This is the honest way to satisfy
condition 3 for a cold-start operator, and it is wired into the real payout
path rather than displayed. The up-front figure is still computed and is
labeled QUOTED, NOT COLLECTED — a control that reads as enforced and enforces
nothing is worse than no control.

**5 — The machine as requester** *(the fourth relationship)* — **SHIPPED in
the booth (2026-08-14)**. Not in the original taxonomy, which had the machine
on the supply side in all three sub-markets: renting out control, selling a
design's output, selling its own capability. The missing one is the machine
**buying** labor. A slot runs empty and the lessee is not in the room — which
is the whole point of leasing a slot in someone else's machine — so the
machine posts an escrowed `[machine:restock]` bounty for someone who is,
funded out of that lessee's own accrued revenue.

Owner owns and does not operate; lessee operates and is not present;
restocker is present and is neither. Nobody runs the business and the
business runs. This is the ownership/control separation of the intellectual
core, extended one step: not only is the manager market-selected, so is the
maintenance.

Funding rule, load-bearing: the bounty never comes from the booth's till. A
subsidised restock is the machine owner doing the lessee's job for free,
which is the arrangement operatorship exists to end — so an operator with
nothing accrued cannot hire, and is told exactly that.

## First physical settlement, 2026-08-18

An escrowed job on Solana devnet, worked by a pen plotter over WiFi, ran end to
end: **job #9 posted, claimed, plotted, submitted, `Completed`.** Money moved
because a machine did something in the world, which is the whole premise of this
document and had never actually happened before.

It took five attempts. Jobs **#5–#8 are still `Accepted`** — four escrows held
by a worker that stopped existing mid-run. The cause was a sagging battery
wearing three different network error messages; the diagnosis, and the platform
defect it exposed (an accepted job has no exit but the deadline), are
failure-modes §29. The stuck jobs are left in place because they are the
evidence that the gap is real.

Source: the sandbox task feed at `?status=all`, cross-checked against the
program on devnet. Note the asymmetry this document should be honest about — the
*settlement* is verifiable by anyone; that a pen actually moved on paper is
attested by the booth alone. This first run is exactly the E2 claim the section
below describes, not better.

## Evidence classes: the frontier this work exposed

Everything above assumes the physical event can be known to have happened,
and mostly it cannot. The booth's honest position has been "no camera —
stats and G-code". Building increment 5 turned that from a disclaimer into a
ranked, first-class field (`src/concession.ts`):

`self-reported` < `confirmed-by-sale` < `buyer-attested` < `instrumented`

The middle rung is free and was sitting there unclaimed: **a dispense proves
the slot had stock, which proves the last claimed restock really happened.**
No sensor, no photo, no trusted third party — the machine doing its ordinary
job is the attestation, recomputable by anyone reading the ledger. Confirmed
restocks score higher than claimed ones, so the upgrade has teeth.

The claim this suggested, stated so it could be tested: **the cheapest sensor
that raises a class by one level is the highest-return part on the machine.**
A ¥5 IR gate at the outlet turns "the servo was commanded" into "an object
crossed the outlet" — worth more, the argument went, than a ¥500 better
mechanism, because the mechanism raises throughput and the gate is what lets
strangers transact without trusting each other. `instrumented` was declared in
the ordering before the hardware existed precisely so this stayed falsifiable.

### It was falsified, 2026-08-18

Not by the hardware — by profiling the channel instead of ranking it. The
ordinal ladder above is the thing that made the claim look true, because a
ladder has only one dimension and a sensor obviously climbs it.
`watcher/src/physical-authority.ts` scores five dimensions instead, and an IR
gate **installed by the machine's owner** scores `independence: 1`. It compiles
to **E2 — the same class as `confirmed-by-sale`, which we already have for
free.** The ¥5 buys a better story and changes no decision the authority model
makes.

Two things follow, and the second is the one worth keeping.

**The ladder was reordered by the profile.** `confirmed-by-sale` (E2) now
outranks `buyer-attested` (E1), the reverse of the ordering above. Coverage is
the dimension nothing substitutes for, and buyer attestation covers only the
buyers who bother to attest.

**The binding constraint is not sensitivity, it is interest.** No instrument the
machine's owner controls reaches E3, however good it is, because the question
E3 asks is not "did the channel see it" but "would the channel have reported
otherwise". What unlocks third-party inventory capital is an observer the owner
does not control — an organisational fact, not a bill of materials. So the
booth's decision (2026-08-18) is to buy no sensor, run on `confirmed-by-sale`,
and leave the capital-provider leg closed until there is someone independent to
watch the outlet.

The original claim was not carelessly wrong. It was right about the shape
(cheap evidence beats expensive mechanism) and wrong about which cheap thing —
which is what a prediction written to be falsifiable is for.

## The unifying object

`src/concession.ts` names what the three sub-markets share: a time-boxed,
revocable, metered right to direct one physical capability, with a settlement
rail attached. Slot lease, recipe listing and machine bounty are the same
record with different meters — which is why a fridge shelf, a 3D-printer
hour, a locker or a car-wash bay should be configuration rather than new
code.

It is a projection, not a replacement: `Slot` and `Recipe` stay canonical,
the same discipline as this repo's DSL/DMN/BPMN layers over canonical JSON.

The classifier in that file is the taxonomy made executable — the four
conditions and the degeneration table as a function. It earns its place by
being unflattering about its own repo, with both answers pinned by tests: the
recipe market comes back `free-option` (registration risks nothing), and the
machine-labor lane's owner comes back `small-business` (they own the machine),
which is exactly the "physical oracle's machine owner is a worker, not an
entrepreneur" claim, now checkable instead of asserted.

## Metrics that would falsify or confirm this

- # of designs registered by people who are not the operator (inc. 1)
- share of booth revenue earned by third-party designs
- # of physical bounties posted by strangers and settled (inc. 2)
- repeat rate: does any author register a second design?
- when a slot machine exists: do slot lessees renew at unsubsidized rents?
- **the one number that tests everything: the repeat-lease rate of an operator
  who has never met the machine owner.** If people who know the operator are
  the only lessees, this is a demo with good documentation; if strangers come
  back for a second term at an unsubsidised rent, the remaining problems are
  engineering. Every other metric here is a leading indicator of this one.
- does a restock bounty get claimed by someone who is not the lessee and not
  the owner (inc. 5)? That is the moment nobody is running the business.
- what share of restocks reach `confirmed-by-sale` rather than staying
  self-reported — the evidence layer's own pass rate.

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
