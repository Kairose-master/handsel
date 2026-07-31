# Benchmark: ERC-8004 & Virtuals ACP vs Handsel — and the integration plan

*Last updated 2026-07. Companion to [competitive-landscape.md](competitive-landscape.md);
this one goes to spec level and ends in an actionable adoption plan.*

## Part 1 — ERC-8004 ("Trustless Agents"), spec-level

Three on-chain registries. Concept-for-concept against what we already run:

| ERC-8004 | Spec surface | Handsel equivalent today | Verdict |
| --- | --- | --- | --- |
| **Identity Registry** | ERC-721 per agent; `register(agentURI)`, `setAgentWallet()`, metadata KV; agentURI points to a JSON registration file (`type/name/description/services/supportedTrust`) | `agent` table + deterministic smart-account address (`getAgentAccountAddress`) | Same concept, ours is off-chain by default; on-chain when `ERC8004_IDENTITY_ADDRESS` is set (`agent.erc8004Id`) |
| **Reputation Registry** | `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`; submitter must NOT be the agent's owner/operator; `getSummary()` aggregation | `creditScore` + `agent_events` + EAS attestation of score | Ours computes *one underwritten number*; theirs stores *many raw signals*. Complementary, not duplicate |
| **Validation Registry** | `validationRequest(validator, agentId, requestURI, hash)` → `validationResponse(hash, response 0–100, tag)`; validator-addressed, re-respondable | The grading pipeline: Proving Ground exact-match, acceptance-test runs (`/grade`), dispute rulings | **This is our graded-fact class as a public standard.** `JOB_TESTS_PASSED` ≙ `response=100, tag="acceptance-tests"` |

**Key realization**: ERC-8004 standardizes exactly the two things we already
produce (verified verdicts, reputation signals) but deliberately does NOT
compute anything from them. A credit engine that *consumes* registry
signals and *publishes* an underwritten limit is precisely the layer they
left open — our wedge, stated in their vocabulary.

**Sharp edge to respect**: `giveFeedback` forbids the agent's owner/operator
as submitter. In today's market — live on mainnet, but still mostly
single-operator in practice — requester and worker agents
often share an owner — so peer feedback between our own demo agents would
be blocked on a compliant registry. The **Validation Registry path is the
clean one for us** (validator = the platform oracle EOA, which is not the
agent NFT owner), and peer feedback becomes meaningful exactly when real
third-party users arrive. The standard is actually enforcing the same
"grader ≠ solver / no self-attestation" principle we built around — good.

## Part 2 — Virtuals ACP, mechanics-level

Their four-phase protocol vs our Labor Market lifecycle:

| ACP phase | Mechanics | Handsel today | Gap |
| --- | --- | --- | --- |
| Request | client↔provider compatibility handshake | Open job + `minScore` gate (credit-based, theirs isn't) | Ours gates on underwritten score — richer signal, less negotiation |
| Negotiation | terms signed into a **Proof of Agreement (PoA)** | `specHash` committed on-chain at `postJob`; worker's `acceptJob` tx references the same job — an implicit countersign | Real parity: both bind terms cryptographically before work. Theirs is bilateral-signed; ours is commit-then-accept |
| Transaction | USDC held in intermediary escrow wallet; **SLA expiry auto-refunds buyer** | `LaborMarket` contract escrow (contract > wallet custodially); off-chain run-timeout reaper | **Parity: shipped in LaborMarketV2** (`deliveryWindow` + `reclaimJob`/`expireOpen`/`expireReview`/`expireDispute`, deployed). An accepted-but-never-submitted job is now permissionlessly reclaimable on-chain |
| Evaluation | **Evaluator agents** (a paid market of them) approve/reject vs the PoA; escrow settles on verdict | Platform-run acceptance tests (mechanical), Proving Ground (exact-match), independent dispute review; failed tests auto-refund + repost | Their evaluators are LLM judgment — same confidently-wrong exposure as our `quality_score` (issue #6). Ours is mechanical where possible. **But their evaluator *market* (paid, specialized, reputation-bearing) is the decentralized form of our issue #7 plan** |

**What they have that we honestly lack**: scale (18k+ agents, multi-chain),
negotiation flexibility (dynamic pricing vs our fixed bounty), and an
evaluator marketplace. (SLA-expiry refunds on-chain were on this list until
LaborMarketV2 shipped them.)

**What we have that they lack**: mechanical grading (facts, not evaluator
opinions), and the credit loop — nothing in ACP compounds a provider's
history into borrowing capacity. Their whitepaper's own framing stops at
"reputation building."

## Part 3 — Integration plan

### Phase A — now, no contract changes
- [x] This document; competitive positioning restated in ERC-8004 vocabulary.
- [x] Serve an ERC-8004-style **registration file** per agent —
  `GET /api/agents/[id]/card` returns `{type, name, description, services,
  supportedTrust}` plus a `handsel` extension block (score, rating,
  on-chain address). This URL is what we'll pass to `register(agentURI)`
  in Phase B.
- [x] **x402 live**: `GET /api/agents/[id]/report` (the full credit
  report) is x402-paywalled at $0.01 USDC/query when `X402_PAY_TO` is set
  — the pay-per-query credit check as a real machine-payable endpoint
  (Base Sepolia, public facilitator, `x402-next` middleware; demo payer in
  `scripts/x402-demo-client.mjs`). The registration file's `x402Support`
  story is now literal.

### Phase B — publish into the standard (GIWA-compatible)
The reference contracts are open source; GIWA has no ERC-8004 deployment —
being first is cheap and is a real "builds GIWA ecosystem infrastructure"
story for GASOK.
- [ ] Deploy the three reference registries to the target chain — the only
  item still open; everything below is implemented and env-gated, waiting
  on the registry addresses.
- [x] On provision: `register(agentURI)` each agent (owner = agent-owner EOA).
- [x] On grading: oracle publishes `validationRequest/Response` —
  `tag="acceptance-tests"` (0 or 100) and `tag="proving-ground"` (0 or 100).
- [x] On credit recalculation: oracle publishes score as Reputation
  feedback (`tag1="credit-score"`, value=score, decimals=0) alongside the
  existing EAS attestation.

### Phase C — later, design-heavy
- [x] On-chain SLA expiry for LaborMarket (ACP-style auto-refund of
  accepted-but-undelivered jobs) — shipped in LaborMarketV2 as
  `reclaimJob` against `deliveryDeadline`.
- [ ] Evaluator market design folded into issue #7 (staked, domain-scoped
  reviewers with reputation computed by our own engine — ACP's evaluator
  market + Kleros-style bonds, graded where possible by machinery).
- [ ] ACP interop exploration (their SDK runs on Base; cross-ecosystem
  agent identity via ERC-8004 makes a future bridge plausible).

## Part 4 — the sentence for the pitch

> ERC-8004 standardizes where trust signals live; ACP standardizes how
> agents transact; Handsel is the underwriting engine between them —
> it turns those signals into a credit limit an agent can actually draw
> against, and publishes the result back into the standards.
