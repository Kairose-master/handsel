# Product and onchain market research

**Checked 2026-09-27.** This note combines the checked-out `main` implementation and public primary sources. It describes category signals, not market size, adoption forecasts, or proof of product-market fit.

## Product value supported by the repository

Handsel links agent work to conditional payment: escrow is funded before a job starts, an evaluator separate from the worker checks the submitted result, and settlement follows the verdict. The repository includes a Base labor-market contract, acceptance-test grading, manual review and dispute paths, and signed work proofs. See [`LaborMarketV2`](../contracts) and [work-proof details](work-proofs.md).

The most defensible user-facing value is **a job with a review rule and budget attached, where the worker cannot approve its own payout**. Verified results may contribute to a work record. This gives a requester a clear transaction boundary and an auditable outcome. It does not mean every result is objectively verifiable or every completed job automatically creates a credit line.

## Onchain signals relevant to this value

1. **Agent commerce is already being built around work and settlement.** Virtuals describes ACP as an onchain coordination and settlement layer for agents to discover, hire, and pay one another. Its public onboarding material describes escrow and an evaluation phase. This is direct overlap with the broad agent-work flow, so Handsel should not claim that it invented agent commerce or escrow. [Virtuals Protocol overview](https://whitepaper.virtuals.io/), [ACP onboarding](https://whitepaper.virtuals.io/acp-product-resources/acp-onboarding-guide/set-up-agent-profile/initialize-and-whitelist-wallet), [Butler quick start](https://whitepaper.virtuals.io/info-hub/virgens-hub/butler-quick-start-guide).

2. **Agent service markets use onchain requests and payments.** Olas documents Mech Marketplace as a marketplace for agents to hire services and describes requests, deposits, delivery, and settlement. This validates the relevance of agent-to-agent paid services; it does not establish that demand is large enough for Handsel or that Olas offers the same grading and work-proof paths. [Olas docs](https://docs.olas.network/), [Mech marketplace documentation](https://stack.olas.network/mech-client/), [marketplace overview](https://olas.network/agent-economies/mech).

3. **Payment rails are becoming agent-callable.** Coinbase documents x402 flows for agents to discover and pay for HTTP resources, including a Bazaar MCP server. These are useful adjacent rails for buying services, while a simple API payment is distinct from holding a task budget until delivery is graded. [Coinbase x402 Bazaar MCP](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/bazaar-mcp-server), [agent wallet pay-for-service](https://docs.cdp.coinbase.com/agentic-wallet/cli/skills/pay-for-service).

4. **Portable identity and reputation interfaces are being standardized.** ERC-8004 specifies identity, reputation, and validation registries, but leaves scoring and trust models pluggable. It is a compatibility signal, not proof that any particular reputation score is reliable. [ERC-8004 specification](https://github.com/erc-8004/erc-8004-contracts/blob/master/ERC8004SPEC.md).

## Product implication

The useful wedge is not another token, generic agent directory, or unqualified “trust layer.” It is the **reviewable transaction**: agree on checks and budget, separate execution from evaluation, and release funds based on the outcome. Onchain escrow and signed proofs make this flow inspectable; they do not remove evaluator error, contract risk, or disputes.

The x402 framing is a useful doorway, not a claim of a live integration between every Handsel payment path. The mainnet deployment was checked on 2026-09-27: `/.well-known/x402.json` returned six catalog entries but no payment recipient; `GET /api/market/index` returned `200` without an x402 challenge; `/api/storefront` returned no offerings. The mainnet external-job handler also refuses the testnet house-bounty subsidy on a real-money chain. The repository contains x402 paywall, storefront, paid-read, and buyer-tool code, but its production recipient is not configured. Therefore, the current landing page treats x402 as the agent-payment context and leads with Handsel's implemented escrowed-work review flow. It does not claim that mainnet x402 checkout or paid job posting is currently available.

[`handsel-mandate`](https://github.com/Kairose-master/handsel-mandate) is a separate related repository. Its 402-LAB demo describes an x402 seller, a budget-bounded buyer MCP, and a browser mandate prototype. Its README also says the onchain browser mandate path is not deployed or security-reviewed. It is not integrated into this repository; do not attribute its mandate enforcement or live seller checkout to Handsel.

The separate repository's README advertises a live Base mainnet service at $0.02 USDC per request and reports two internal wallet settlements; it says external buyer demand and revenue are not established. This is the strongest concrete x402 product presentation in the related work, while its own stated validation is still early. The useful design lesson is to show the paid request and its exact budget plainly, then make the spending boundary legible. For this repository, the verified wedge remains the escrowed task and independent review—not a claim that mandate-controlled spending is already deployed here.

An initial landing page should explain that mechanism and let a new user try the zero-value sandbox. It should make no claims about market leadership, total addressable market, user counts, revenue, credit availability, or guaranteed agent quality.

## Product limits checked in code/docs

- Handsel has real overlap with Virtuals ACP and Olas Mech Marketplace in agent discovery, hiring, and settlement. Do not describe the overall category as empty.
- The different emphasis visible in this repository is job-specific evaluation, conditional escrow settlement, and work proofs. The strength of that distinction depends on the grader and task criteria; not every review is deterministic.
- Credit underwriting is not the primary landing-page promise: the [product thesis](product-thesis.md) and implementation contain unresolved limits, and production lending is not presented as a generally available service.
- The active production contract is on Base mainnet and holds real assets. The contract has not had a commissioned independent security audit; see the [self-audit caveats](security-audit.md).

## Sources and method

Primary sources only: repository code and product notes, official protocol documentation, and standards text. Competitor descriptions are limited to their own published documentation. Snapshot date: 2026-09-27; the competitive set and deployments can change.
