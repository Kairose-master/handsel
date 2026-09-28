# Agent-owned x402 payments through Bazaar

*Design note, verified 2026-09-28. This describes the target design; it is not a claim that per-agent Bazaar spending is already shipped.*

## What exists today

Handsel has an x402-paid HTTP tool binding (`connect_x402_tool`) with a URL, GET/POST method, per-call price ceiling (currently at most $1), and optional pinned recipient. Before paying, it checks the agent's spend envelope; it pins the x402 network and USDC asset, refuses a challenge above the binding's price cap or to a different configured recipient, and records the selected spend. The paid call is implemented in [`lib/x402-tool-server.ts`](../lib/x402-tool-server.ts).

The payer is currently one deployment-wide EOA secret, `X402_BUYER_PRIVATE_KEY`. All agents on that deployment use that signer. It is not their `smartAccountAddress`; it does not implement personal wallets or isolated per-agent balances. The database stores each agent's tool binding, but not a payer wallet. Production x402 payment configuration was absent in the 2026-09-27 deployment check; see [product and risk notes](product-and-risk.md).

Agents also have `smartAccountAddress` values provisioned by Handsel. That address alone is not a signer. In the current Kernel setup, the owner key backs agent accounts; it must not be repurposed as a shared Bazaar buyer secret. The existing direct HTTP buyer uses x402's `exact` flow. ERC-3009 itself specifies EOA typed-data signatures and explicitly says it does not apply to smart-contract accounts. Therefore do not assume that the current Kernel account can pay through the present x402 facilitator without a supported contract-signature scheme and an end-to-end compatibility test.

## Recommended product flow

1. **Discover:** An agent searches Coinbase's public x402 Bazaar by intent, network, asset, and maximum price. Discovery is free and does not require a CDP API key. Results are untrusted proposals, not authorization to spend.
2. **Choose:** The agent selects one resource and stores a reviewed binding: HTTPS URL, method/input schema, expected output schema, network, USDC contract, maximum per-call price, and pinned `payTo` when available. Validate the URL and metadata. Do not automatically pay for arbitrary search results.
3. **Authorize:** Resolve the calling agent from the authenticated Handsel account and require a funded wallet plus an explicit per-agent spend envelope. Check both the per-call maximum and rolling daily cap before requesting payment. Require human approval above the agent's configured automatic threshold.
4. **Pay as that agent:** Create a payment authorization whose payer is this agent's wallet, then submit it through the x402 client/facilitator handshake. Keep the facilitator and seller unable to choose the payer, network, asset, recipient, or amount outside the policy.
5. **Verify and record:** Confirm the settlement response and, where provided, on-chain receipt. Record agent ID, payer, resource URL, `payTo`, network, amount, nonce/transaction, timestamp, and result status in an append-only ledger. Return the paid result to the agent and attribute cost to that agent.

Coinbase documents the Bazaar as a public catalogue searchable by intent and filters; its MCP endpoint exposes `search_resources`, `proxy_tool_call`, and `validate_endpoint`. Search is free, while a paid proxy call starts the normal x402 payment flow. For Handsel, the safer initial integration is to use Bazaar for discovery and validation, then invoke the selected HTTPS resource through Handsel's guarded buyer runtime. Directly enabling Bazaar's paid `proxy_tool_call` would need to preserve the same per-agent signer and spend-envelope checks.

## Wallet choice and decision gate

**Preferred:** use the agent's existing smart account as payer, but only after proving that the selected x402 scheme, payment client, USDC token, and CDP facilitator accept the account's contract signature format on the target network. The generic ERC-3009 EOA path is not that proof. Add a signer adapter for the actual account implementation (currently Kernel/ZeroDev), and test it end to end on Base Sepolia with the production facilitator path before enabling mainnet.

**Fallback if the facilitator cannot accept that smart-account signature:** provision a dedicated x402 EOA sub-wallet for every agent. Give each it its own address, encrypted signing material and USDC balance; never reuse one deployment buyer key. Keep signing server-side in a KMS/HSM or similarly isolated signing service, with an API that accepts only a fully validated payment intent after Handsel policy checks. This is per-agent payment identity, but server custody remains a trust assumption and must be disclosed. Do not expose private keys to browser code, prompts, tool results or logs. Do not use the global agent-owner key as the fallback signer.

Do not call the existing `smartAccountAddress` a personal payer wallet until it is the actual payer in a settled x402 transaction. If neither the account's supported contract-signature path nor an isolated agent sub-wallet is available, keep paid Bazaar calls disabled.

## Implementation plan

1. Add a wallet/payment identity table keyed by agent ID: payer address, wallet type, signer reference (never plaintext key), chain, enabled state, and timestamps. Encrypt signer material outside ordinary application rows, or use a remote KMS/HSM signer. Migrate away from the single `X402_BUYER_PRIVATE_KEY` after validating each account; do not silently fall back to it.
2. Replace `createSigner(network, deploymentKey)` in the paid-call path with a signer resolver scoped to the authenticated `agentId`. Refuse if the selected payer does not match that agent's registered wallet.
3. Extend the spend envelope with per-agent rolling limits and approval thresholds. Reserve spend atomically before payment to prevent concurrent calls exceeding a daily cap; reconcile the reservation from the verified settlement receipt and release it on failure.
4. Add Bazaar discovery as a search/validate feature. Treat catalog descriptions and endpoint-supplied payment requirements as hostile input; require HTTPS, pinned network + USDC, amount cap, recipient pinning, and schema/response size limits.
5. Test no-payment cases first: unsupported network/asset/scheme, mismatched payer or `payTo`, over-cap amount, exhausted daily cap, duplicate/replayed nonce, denied signer, malformed 402, timeout, and failed settlement. Then test one low-value Sepolia transaction for each supported wallet type and verify payer/recipient/amount on-chain. Enable Base mainnet only after those checks and an explicit product risk review.

## Agent usage (target experience)

The intended flow is: connect/provision the agent wallet, fund that agent's x402 balance, set its per-call and daily spend policy, search Bazaar for a capability, review and pin a resource, then let the agent call it. The runtime shows the price and payer before approval, pays from that agent's own wallet, and records the result and spend. These per-agent wallet and Bazaar UX steps are design targets, not current shipped Handsel functionality.

## Sources

- [Coinbase x402 Bazaar discovery](https://docs.cdp.coinbase.com/x402/buyer/discover-services) — public discovery and query/filter behavior.
- [Coinbase Bazaar over MCP](https://docs.cdp.coinbase.com/x402/buyer/mcp-payments) — MCP tools and payment loop.
- [ERC-3009](https://eips.ethereum.org/EIPS/eip-3009) — typed authorization format and scope; the EIP explicitly excludes smart-contract accounts.
- Repository implementation: [`lib/x402-tool.ts`](../lib/x402-tool.ts), [`lib/x402-tool-server.ts`](../lib/x402-tool-server.ts), [`lib/onchain/account.ts`](../lib/onchain/account.ts), [`docs/bazaar-listing.md`](bazaar-listing.md).
