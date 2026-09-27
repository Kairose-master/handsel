# Listing Handsel in the x402 Bazaar

*2026-09-27.* The Bazaar is CDP's discovery layer for x402 resources: an
agent asks it "who sells a labor-market index for under a cent" and gets
back resources ranked by relevance and by real usage (calls and unique
payers over 30 days). Nothing here is submitted by hand — a resource is
indexed on its **first settled call through the CDP facilitator**, and
ranked by what it declares about itself.

## What shipped

| Piece | File | What it does |
| --- | --- | --- |
| Resource metadata | `lib/x402-catalog.ts` | One list of everything priced: price, description (≤500 chars, test-pinned), `inputSchema`, `outputSchema.example`, `discoverable: true`. The middleware's price map is generated from it, so the paywall and the listing cannot drift. |
| CDP facilitator | `lib/cdp-facilitator.ts` | `{url, createAuthHeaders}` for `api.cdp.coinbase.com/platform/v2/x402` — the CDP API-key JWT built with `jose` (edge-safe; no CDP SDK in the middleware). Used whenever `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` are set, else x402.org as before. |
| Public listing | `GET /api/x402/catalog`, `/.well-known/x402.json` | The same facts readable without triggering a 402 — for crawlers, for humans, for the 402-LAB storefront to link. |

## The steps to be indexed (mainnet, operator's job)

1. In the CDP portal create a **Secret API Key** (Ed25519). Set
   `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` on the **mainnet** deployment.
   Testnet settlements validate the setup but do not get curated.
2. Deploy. `middleware.ts` now settles through CDP; `X402_PAY_TO` unchanged.
3. Validate each resource once:
   `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` with the
   resource URL — it checks reachability, the 402, the discovery block, and
   that the CDP facilitator accepts the requirements.
4. Make **one real paid call** per resource (`scripts/x402-demo-client.mjs`
   with a mainnet-funded `X402_CLIENT_KEY`, ~$0.01 each for the two reads;
   the storefronts index on their first real commission). That settlement
   is the listing.
5. Check `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
   (public, no key) — the resource appears within minutes.

## Traps the community already hit

- **`http://` in the resource URL** behind a TLS-terminating proxy → silently
  not indexed. Vercel is fine; self-hosted needs proxy trust before the
  middleware.
- **Description over 500 chars** → the settle is hard-rejected.
  `tests/x402-catalog.test.ts` pins every description under the cap.
- **Sub-cent prices** ($0.001) were observed not to index; $0.01 did within
  minutes. Every Handsel price is ≥ $0.01.
- **Probe traffic** (callers replaying the declared example) inflates the
  usage metrics; exclude it from `lib/x402-ledger.ts` counts if it appears.

## What this does NOT do

It does not put Handsel *jobs* in the Bazaar — the Bazaar lists paid HTTP
resources, and a job is an escrow, not a resource. What it lists is the
four things an agent can buy from Handsel with one HTTP call: a credit
report, the labor index, a posted job, an office commission. The market
itself is reached through the MCP connector (`docs/mcp-connector.md`).
