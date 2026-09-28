# Agent-owned x402 payments through Bazaar

*Implementation note, updated 2026-09-28. This documents the per-agent EOA implementation and its release gate.*

## What exists today

Handsel has an x402-paid HTTP tool binding (`connect_x402_tool`) with a URL, GET/POST method, per-call price ceiling (currently at most $1), and optional pinned recipient. `search_x402_bazaar` provides discovery only; it never authorizes a call or payment. Before paying, the runtime reserves the agent's spend envelope atomically, pins network and USDC, refuses a challenge above the binding's price cap or to a different configured recipient, and records settlement against the agent. The payment flow is in [`lib/x402-tool-server.ts`](../lib/x402-tool-server.ts).

Each agent now gets a dedicated EOA payer; it is separate from `smartAccountAddress`. A random 32-byte `X402_WALLET_ENCRYPTION_KEY` enables wallet creation. Signer material is encrypted with AES-256-GCM before storage in `agent_x402_wallet`; no private key is returned through tools or API responses. The server decrypts it only to sign that agent's x402 request. `X402_BUYER_PRIVATE_KEY` is never used as a fallback. This is server custody: anyone able to read the encryption key and database can control these wallets. Operators must safeguard and back up the encryption key; replacing it without re-encrypting existing rows makes those agents unable to pay. Production x402 payment configuration was absent in the 2026-09-27 deployment check; see [product and risk notes](product-and-risk.md).

Agents also have `smartAccountAddress` values provisioned by Handsel. That address alone is not a signer. In the current Kernel setup, the owner key backs agent accounts; it must not be repurposed as a shared Bazaar buyer secret. The existing direct HTTP buyer uses x402's `exact` flow. ERC-3009 itself specifies EOA typed-data signatures and explicitly says it does not apply to smart-contract accounts. Therefore do not assume that the current Kernel account can pay through the present x402 facilitator without a supported contract-signature scheme and an end-to-end compatibility test.

## Recommended product flow

1. **Discover:** An agent searches Coinbase's x402 Bazaar by intent. Discovery does not trigger a payment. Results are untrusted proposals, not authorization to spend.
2. **Choose:** The agent selects one resource and stores a reviewed binding: HTTPS URL, method/input schema, expected output schema, network, USDC contract, maximum per-call price, and pinned `payTo` when available. Validate the URL and metadata. Do not automatically pay for arbitrary search results.
3. **Authorize:** Resolve the agent from the authenticated Handsel account and require a funded wallet plus an explicit per-agent spend envelope. Reserve the per-call cap atomically against its rolling 24-hour ceiling before requesting payment. A call over the auto-approve threshold is refused pending operator action.
4. **Pay as that agent:** Create a payment authorization whose payer is this agent's wallet, then submit it through the x402 client/facilitator handshake. Keep the facilitator and seller unable to choose the payer, network, asset, recipient, or amount outside the policy.
5. **Verify and record:** Record the paid amount against the agent's append-only spend ledger after the payment response. A timeout after selecting a payment challenge holds the reservation for 24 hours so uncertain settlement cannot reopen budget immediately.

Coinbase documents the Bazaar as a public catalogue searchable by intent and filters; its MCP endpoint exposes `search_resources`, `proxy_tool_call`, and `validate_endpoint`. Search is free, while a paid proxy call starts the normal x402 payment flow. For Handsel, the safer initial integration is to use Bazaar for discovery and validation, then invoke the selected HTTPS resource through Handsel's guarded buyer runtime. Directly enabling Bazaar's paid `proxy_tool_call` would need to preserve the same per-agent signer and spend-envelope checks.

## Wallet custody and compatibility

The current Kernel account is not used as payer. Its contract-signature compatibility with the x402 exact flow has not been proven. Each x402 payer is an EOA generated independently for its agent.

Fund the address returned by `connect_x402_tool` with the matching network's USDC. This implementation keeps encrypted key material in the application database and uses a server environment secret for encryption; it does not use a KMS/HSM. Server custody is a trust assumption and must be disclosed. Do not expose private keys to browser code, prompts, tool results or logs. Do not use the global agent-owner key as payer.

Do not call the existing `smartAccountAddress` the x402 payer. If `X402_WALLET_ENCRYPTION_KEY` is not a valid 32-byte key, paid x402 calls fail closed.

## Implementation plan

1. **Release gate:** set and back up a random 32-byte `X402_WALLET_ENCRYPTION_KEY` in each Vercel environment; never reuse `X402_BUYER_PRIVATE_KEY` as an agent wallet.
2. Before enabling mainnet, exercise the no-payment cases: unsupported network/asset/scheme, mismatched payer or `payTo`, over-cap amount, exhausted daily cap, denied signer, malformed 402, timeout, and failed settlement. Then test one low-value Sepolia transaction and verify payer/recipient/amount on-chain. Mainnet enablement requires an explicit product risk review.

## Agent usage (target experience)

The flow is: search Bazaar, review a service, call `connect_x402_tool` with its HTTPS URL, method, cap and recipient pin, then fund the returned agent-specific address with USDC. Set the agent's spend envelope before dispatching jobs. Bazaar search and binding setup are available through MCP; the paid path remains disabled on deployments without the encryption key. No private key is shown to the caller.

## Sources

- [Coinbase x402 Bazaar discovery](https://docs.cdp.coinbase.com/x402/buyer/discover-services) — public discovery and query/filter behavior.
- [Coinbase Bazaar over MCP](https://docs.cdp.coinbase.com/x402/buyer/mcp-payments) — MCP tools and payment loop.
- [ERC-3009](https://eips.ethereum.org/EIPS/eip-3009) — typed authorization format and scope; the EIP explicitly excludes smart-contract accounts.
- Repository implementation: [`lib/x402-tool.ts`](../lib/x402-tool.ts), [`lib/x402-tool-server.ts`](../lib/x402-tool-server.ts), [`lib/onchain/account.ts`](../lib/onchain/account.ts), [`docs/bazaar-listing.md`](bazaar-listing.md).
