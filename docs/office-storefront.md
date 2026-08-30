# The office storefront — external revenue, with the desk as the unit of sale

## Why the office, not the agent

"Make the agents earn outside money" has an obvious first draft — expose each
agent as a paid API — and a problem with it: **labor is a commodity.** Anyone
who can pay an agent per call can run one for the same tokens. A bare
agent-endpoint competes on price against the buyer's own API key.

What a stranger cannot cheaply replicate is Handsel's *structure*: escrowed
steps in dependency order, an adversarial reviewer whose APPROVE gates the
money, independent grading, a signed work proof per deliverable, and a desk
whose graded history is public. The storefront sells that structure with the
labor inside it. The price is above the pipeline cost **because of the
structure** — `tests/storefront-pricing.test.ts` asserts the margin exists,
since a storefront selling below its own pipeline cost is a subsidy wearing a
price tag.

## The flow

```
client (human or agent, NO account)
  │  GET /api/storefront                     ← free shop window: open? price? capacity? live desk roster?
  │  POST /api/storefront/{template}/commission   ← x402: HTTP 402 → sign EIP-3009 → retry with X-PAYMENT
  │        body: { scope }
  ▼
payment settles at X402_PAY_TO ──► serving office's PRIME escrows the pipeline budget
                                          │
                                   standing desk works it: waves → review gate → grading → splits
                                          │
  GET /api/storefront/commission/{token} ◄┘   ← status per step; assembled deliverable on completion
```

- **The token is the whole relationship.** Unguessable id as access key — the
  same model attachment URLs use. The buyer may have nothing but the receipt.
- **Polling drives verification.** The status endpoint ticks the underlying
  delegation, so an impatient client powers the grading that pays the desk.
- **Money:** the client's price is 100% external inflow (payer-attributed in
  the x402 ledger); the prime fronts the budget; the workers earn it back by
  passing grading; the margin stays with the operator.

## Why each mechanical choice

- **Static price map in edge middleware** → prices live in
  `lib/storefront-pricing.ts`, tiny and dependency-free, a deliberate *copy*
  of template facts pinned by test (price > budget; budget ≥ steps × the $1
  hire minimum so a paid commission can never be refused by `hire_office`;
  template must exist). Copy-plus-pin, same as `MAX_GENOME_SKILLS`.
- **Payment settles before the handler can refuse.** Three consequences:
  the free catalogue advertises `open` and `capacityRemainingToday` up front;
  the commission row is written *before* the escrow attempt and its token is
  returned even on failure (a receipt either way — "we kept your money and
  told you nothing" is the one behaviour a pay-first machine economy cannot
  survive); and an unknown template 404s, because it was never in the price
  map and therefore arrived **unpaid** — no free ride through a misspelled
  path.
- **The standing desk serves** (`freshAgents: false`): its wallets, wiring
  and graded record are the product. The serving storefront per template is
  the longest-standing open one — seniority earned by staying open.
- **`MAX_COMMISSIONS_PER_DAY = 5`** bounds the prime's float exposure, not
  the client's money: it is how much escrow the desk can be asked to front
  before earlier commissions settle back.

## What this closes

The lineage system selects on graded outcomes — but until now every graded
outcome was funded by the owner's own escrow. A commissioned pipeline's
verdicts are **fitness evidence paid for by a non-owner**: the market's
judgment, not the owner's allowance. Earn-or-die finally has the gradient it
was built for.

## Honest state

- Sellable today: `venture-lab`, `growth-studio`, `research-desk` — a curated
  subset, because a storefront row is a promise that a real desk exists and
  serves. The middleware network is `base-sepolia` (matching the existing
  x402 entries), so commissions settle on the rehearsal deployment first —
  same rehearsal-first posture as the lineage mandate.
- Revenue starts at $0.00 and the ledger shows it. The first commission from
  a stranger's wallet matters as proof before it matters as money.
- Switches: the **Storefront panel on `/office`**, or the `set_storefront`
  MCP tool. The read side belongs on `/autonomy` eventually.

  This line used to read "`set_storefront` MCP tool. A dashboard surface can
  follow" — and nothing followed, for the whole life of the feature. That
  was not a cosmetic gap: it meant the office's one autonomous sales channel
  could only be opened by an assistant with the connector wired up and
  authorized, so an owner sitting on their own `/office` could not open
  their own shop. Every template was `open: false` on every deployment the
  entire time, and a closed desk is indistinguishable on screen from an open
  one nobody found. See `docs/failure-modes.md` §42.
