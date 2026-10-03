# XRPL production preflight — 2026-10-03

Result: **blocked by production merchant configuration; not ready for registration or paid use.** No wallet, signature, seller purchase, `/verify`, `/settle`, or XRPL transfer was performed.

## Scope and prior work

Inspected main `74f0427570d3b0b0fa6e1883a1120eee33a5e2f1` after PR #22, merge `089b34fceddae0b76336a243f4f0313308f124a6`. Its reported typecheck, full suite and build were not repeated as baseline verification. Path history after that merge contains no changes to the XRPL route, merchant library, discovery route or XRPL documentation. GitHub XRPL issue/PR search found #22 and unrelated ALSP whitepaper #26; no separate XRPL follow-up/preflight completion was found.

## Read-only production observations

Observed around 03:15–03:17 UTC (12:15–12:17 Korea time):

| Probe | Observed result |
| --- | --- |
| `GET https://handsel-main.vercel.app/.well-known/x402` | 200; resource listed without `payment`, pointing to `https://www.handsel.dev/api/xrpl/jobs` |
| Unpaid `POST https://handsel-main.vercel.app/api/xrpl/jobs` | 503; XRPL configuration error; no `PAYMENT-REQUIRED` |
| `GET https://www.handsel.dev/api/xrpl/jobs` | Same 503 configuration error |
| `GET https://xrpl-facilitator-mainnet.t54.ai/supported` | 200; `{"kinds":[{"x402Version":2,"scheme":"exact","network":"xrpl:0"}],"extensions":["x402Secure"],"signers":{"xrpl:*":[]}}` |
| `GET https://xrpl-x402.t54.ai/supported` | 404; this is the documentation/public surface, not evidence that the configured mainnet API is invalid |

Unpaid POST body:

```json
{"title":"Production preflight","acceptance_criteria":"Read-only unpaid configuration preflight; do not create a job."}
```

503 body:

```json
{"error":"XRPL job posting is not configured. Set XRPL_PAY_TO, XRPL_RLUSD_ISSUER, XRPL_NETWORK, and XRPL_FACILITATOR_URL."}
```

This error represents any failed `xrplMerchantConfig()` validation; it does **not** identify which variable is missing or invalid. Production environment values were not available for inspection. The public-origin difference is consistent with `PUBLIC_ORIGIN` taking precedence; both hosts returned the same error, so no broken-domain fix is justified.

## Configuration cross-check

| Item | Code / expected configuration | Verification limit |
| --- | --- | --- |
| Network | Defaults to `xrpl:0`; known T54 mainnet/testnet hosts require matching network | T54 mainnet supported response confirms scheme/network only |
| Asset | `524C555344000000000000000000000000000000` (RLUSD) | `/supported` does not declare IOU support or issuer policy |
| Issuer | Explicit `XRPL_RLUSD_ISSUER`; Ripple documents mainnet `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` | Existing validator checks address syntax, not canonical issuer equality; actual production value unknown |
| Recipient | Explicit `XRPL_PAY_TO`, separate from Base `X402_PAY_TO` | Actual address, account existence, destination-tag requirements and RLUSD trustline unknown |
| Facilitator | Default `https://xrpl-facilitator-mainnet.t54.ai`; URL joins `/verify` and `/settle` | Only GET `/supported` exercised; no IOU verification/settlement claim |
| Source tag | Defaults to `804681468`; integer in uint32 range; challenge/payment terms bind it | Actual production override unknown |
| Economics | Production example: 3 RLUSD payment, $2 house bounty; price must exceed bounty | Previously keyed only to escrow runtime. This PR also treats XRPL mainnet as real money, preventing testnet subsidy fallback |
| Requester | `X402_JOB_REQUESTER_AGENT_ID`, DB agent must have `smartAccountAddress` | Production gate exits before DB check; no claim about agent provisioning/balance |
| Escrow | Shared `createExternalJob` → existing `postJob`, configured labor market and agent account; XRPL receipt does not automatically bridge into escrow | Existing EVM/Base token, contract, RPC, account funding and mainnet guards remain dependencies; paid path not exercised |

XRPL collection and Base escrow remain separate, non-atomic operations. Static configuration checks do not prove balances, contract validity or successful settlement.

## Minimal corrections

Discovery now uses the same configuration/pricing/requester/labor-market checks as the unpaid route, returning an empty, non-cacheable resource list when unavailable. The API remains closed with 503. Pricing treats either XRPL mainnet **or** the escrow's real-money runtime as real money. Only a two-testnet rehearsal retains the existing subsidy.

Regression scenarios cover unavailable merchant, requester, house account, labor market and economics; configured discovery versus decoded unpaid 402 terms; XRPL-mainnet/testnet-escrow pricing; and two-testnet rehearsal. Dependencies are mocked; unpaid tests throw if job creation or invoice writes occur. No facilitator network calls occur in these tests.

## Remaining production evidence

An operator must supply valid merchant configuration and verify the actual issuer/pay-to, RLUSD trustline and account tag requirements. Then repeat only discovery and the valid unpaid POST to capture matching 402 metadata. Independently check the actual house requester and Base escrow funding/configuration. Do not call settlement as part of this preflight. This PR does not set deployment variables, activate the endpoint, register it in AI Hub, merge, or deploy.

References:

- https://github.com/Kairose-master/handsel/pull/22
- https://docs.ripple.com/products/stablecoin/overview/token-addresses
- https://docs.t54.ai/docs/xrpl/x402-facilitator
- https://xrpl-facilitator-mainnet.t54.ai/supported

## Validation of this change

- Targeted Vitest: 4 files, 24 tests passed (including 8 new preflight cases).
- Targeted ESLint and `git diff --check` passed.
- TypeScript: `tsc --noEmit -p tsconfig.json` passed.
- Dependency setup used npm without a lockfile write because the installed pnpm version rejected the existing lockfile override configuration. No dependency files changed; this local run is not a frozen-lockfile CI claim.
