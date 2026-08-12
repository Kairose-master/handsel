# Physical operatorship — the machine lane

The planning document for Handsel's physical extension. Written 2026-08-12,
after the vending booth (the first physical node) closed its full loop.
This is a PLAN: increments 2–4 below are not built. Increment 1 is being
built alongside this document in the booth repo
(`kairose-master/onchain-vending-machine`).

## The thesis, one line

> Classic DePIN made infrastructure **supply** permissionless. This makes
> infrastructure **operation** permissionless: anyone can run one physical
> business function — a product slot, a test protocol, a recipe, a
> measurement — inside a machine someone else owns, and the trust layer
> that makes that safe is the one Handsel already runs for agent labor.

The reformulated question that generated it: *"Which real-world actions
that only companies can perform today can become one API call?"* — product
placement, fabrication, inspection, brand creation, inventory routing,
measurement. Each becomes: **pay → machine executes → verified → split**.

## Why operatorship ≠ supply (the economics)

| | DePIN supply (Helium, GPU nets) | Operatorship (this) |
|---|---|---|
| Participant is a | wage/rent earner — commodity capacity, price-competed | **residual claimant** — sets price, picks product, bears demand risk, keeps margin |
| Unit sold | capacity | a **concession** (운영권) — what a franchise sells |
| Demand discovery | platform's unsolved problem (subsidized supply → death spiral) | **distributed into operators' profit motive** — an operator enters only where they see demand they can serve |
| Corporate analogue | outsourced procurement | **separation of ownership and control**, applied to micro-assets |

Two honest complications, stated up front:

1. **Supply doesn't disappear — it becomes the lower layer.** Machines
   still must be bought, placed, and repaired. The full picture is
   two-sided: asset owners (classic DePIN logic) below, operators (the new
   layer) above. The novelty is the upper layer.
2. **Quality externalities arrive exactly as they do in franchising.** One
   operator's bad output burns the machine's — and the network's — trust.
   Franchising solves this with contracts and audits; the permissionless
   version needs **escrow, independent grading, bonds with slash-burn, and
   behavior-earned reputation**. That list is Handsel's existing parts
   list, which is why this is a Handsel extension and not a new project.

## The trust-layer requirement ↔ existing part, mapped

| Operatorship needs | Handsel already has |
|---|---|
| Money held until the machine actually performed | LaborMarket escrow, pay-on-pass (`lib/labor-settle.ts`) |
| Someone other than the operator saying it was done | independent grading — CI lane, image/vision lane, LLM lane (`docs/graders.md`) |
| Proof that survives the platform | signed work proofs (`lib/attestation.ts`, `/api/proof/<id>`) |
| Punishing no-shows without paying anyone to trigger it | bond slash **burned** (`_burnBond`, same on Solana) |
| Letting good operators do more | behavior-earned credit score → borrowing (`lib/credit-rules.ts`, `lib/reputation-lending.ts`) |
| Machine-to-market payment with no accounts | x402 rail (`/api/jobs/external` — the booth is its first real client) |
| External executors joining permissionlessly | external MCP workers (`lib/mcp-client.ts`), headless worker API |

## Vertical map (from the 2026-08-12 ideation), filtered by physics/regulation

| Vertical | What is sold | Reality filter | Verdict |
|---|---|---|---|
| Transformation market (recipes on a maker-machine) | a recipe/design + royalty | goods are low-liability (paper, engraving) | **Build first — increment 1, live in the booth** |
| Micro-Lab / Physical Oracle | a test protocol; an answer to a real-world question | output is information: no inventory, ~0 marginal cost. Hard part is calibration; high-stakes verdicts (authenticity) carry liability | **Increment 2.** Start with low-stakes measurements (sugar content, noise, stock photos) |
| Physical bounty (demand-side oracle) | escrowed question → machine performs | same market as Micro-Lab, opposite side | Increment 2 (same build) |
| Micro-Brand Factory (drinks, perfume) | a brand = parameter set + royalty | ingestible/on-skin → food & cosmetics law immediately. Realistic shape: licensed operator owns the compliance shell; creators sell parameters within a safe envelope (the Coca-Cola Freestyle structure) | Later; needs a licensed partner |
| Arcade app store | a game rule on shared actuators | lowest liability, most viral, low revenue ceiling | Demo vertical, not a wedge |
| Logistics router | a routing policy over lockers/robots | needs infrastructure density only campuses/offices have | A feature for an existing network, not a startup |
| Universal microfactory | a physical app on a do-everything machine | every actuator multiplies failure modes; "sell → produce" (zero inventory) is the real insight | Arrives as a **standard protocol across specialized machines**, not one machine — which is increments 1–3 |

## Increment 1 — the recipe market (booth repo, being built now)

**Sentence:** a third party registers a card design on the booth; every
sale of that design splits revenue between the author and the booth,
on-chain.

- **Register** (kiosk, no login — booth-local trust): name (≤40),
  author (≤20), author wallet (Base Sepolia address, optional), and either
  a text template or an uploaded image. Registration runs the REAL preview
  pipeline; a design that produces no strokes is refused at registration,
  not discovered by a paying customer.
- **Sell**: the kiosk gains a gallery lane. Picking a design consumes a
  paid credit exactly like the text/image lanes; the plot uses the stored
  design verbatim.
- **Split**: `RECIPE_AUTHOR_BPS` (default 7000 = author 70%, booth 30%)
  of the card price accrues to the author on each sale. With the booth's
  hot key configured, the author's share is **paid per sale as a real
  Base Sepolia USDC transfer** and the tx hash is recorded on the recipe;
  without it, shares accrue in the booth ledger and the kiosk says
  "accrued", never "paid". No pretending.
- **Settlement**: each sold card still becomes a Handsel job (the x402
  settlement layer already live in the booth); the job title carries the
  recipe name, so the market's public feed shows WHOSE design earned.
- **Done when**: a design registered by someone who is not the booth
  operator sells to a third person, the author's USDC arrives with a tx
  hash, and the Handsel job for that card settles graded. One photo of
  that receipt is the whole thesis demonstrated.

## Increment 2 — machine-as-worker (Physical Oracle MVP)

- A machine owner registers a machine as a Handsel worker agent with
  declared capabilities (the capabilities field already exists:
  `plot`, `photo`, `measure`, …).
- A demander posts an escrowed job addressed to physical capabilities
  ("photo of shelf X, hourly"); the machine's runtime claims by id (the
  booth's directed-claim client generalizes), performs, submits with
  sensor/image evidence; the image-grading lane grades; escrow settles.
- **Done when**: one recurring physical bounty settles N times unattended.

## Increment 3 — multi-party settlement splits

- Generalize per-job settlement from (worker, fee) to a split table:
  capability author / machine owner / location holder. The Withdrawable
  ledger is already per-recipient; this adds a split spec on the job.
- Every vertical above runs on this one primitive.

## Increment 4 — machine credit

- A machine operator's uptime, grading pass-rate and settled revenue
  become a credit score (the engine exists); borrowing against verified
  machine cashflow (the lending code exists) funds the next machine.
- The original product thesis — behavior-earned credit unlocking capital —
  closed in the physical world.

## Metrics that would falsify or confirm this

- # of designs registered by people who are not the operator (increment 1)
- share of booth revenue earned by third-party designs
- # of physical bounties posted by strangers and settled (increment 2)
- repeat rate: does any author register a second design?

Zero third-party registrations after real booth traffic = the thesis
fails at its first gate, and this document should say so in a postmortem
section rather than be quietly forgotten.

## Positioning lines (for GIWA / Eternal / interviews)

- EN: "Classic DePIN lets anyone supply infrastructure. Handsel's machine
  lane lets anyone **operate** it — run one real-world business function
  inside someone else's machine, with escrow, independent grading and
  on-chain settlement making a stranger's slot trustworthy."
- KR: "기존 DePIN이 인프라 '공급'을 개방했다면, 이건 인프라 '운영'을
  개방합니다 — 기업만 하던 현실 행동 하나(진열·제조·검사·측정)를 API처럼
  등록하고, 에스크로·독립 채점·온체인 정산이 낯선 운영자를 신뢰 가능하게
  만듭니다. 1호 노드가 이 펜 플로터 자판기입니다."

## Boundaries (unchanged from the booth's founding decisions)

- Testnet tokens are gifts with zero value; real money buys physical goods
  only. Nothing here changes the VASP analysis (`onchain-vending-machine`
  README) — and any vertical where third parties sell REAL goods through
  the machine re-opens the who-is-the-seller question and gets researched
  BEFORE it gets built, the same way the booth's structure was.
- No fake data anywhere: recipe sales counters, author earnings and
  bounty settlements are all real transactions or they are not shown.
