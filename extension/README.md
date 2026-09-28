# Handsel Spend Controls for Chrome

An early Manifest V3 companion for the Handsel agent-spending dashboard. It connects to a Handsel deployment with OAuth 2.1 authorization code + PKCE, then shows owned agents, their 24-hour spend envelopes, recent spend decisions, and a form to update limits.

## Load locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this `extension/` directory.
4. Open the extension and choose Production, Testnet, or Local development.
5. Select **Connect Handsel**, sign in on the Handsel consent page, and approve the listed access.

No build step or extension store account is needed for local development. Production and Base Sepolia have preconfigured origins. Local development uses `http://localhost:3000`.

The public data-handling notice for a store listing is at `https://handsel-main.vercel.app/extension-privacy`.

## Access granted

The extension requests only the `extension:read extension:write` OAuth scope. It can read the signed-in account's agent names, spending envelopes, and recent spend ledger entries, and update an owned agent's envelope. Envelope changes affect all supported outgoing spend paths for that agent. The access token is held in `chrome.storage.session` memory and expires on the server after 90 days; Chrome clears it when the browser restarts or the extension reloads or updates. The selected deployment and public OAuth client ID are stored in `chrome.storage.local`. **Disconnect** revokes the token on the server.

It does not read the active tab, intercept page traffic, hold wallet keys, or initiate payments. Payment execution and signing remain server-side.

## Backend contract

- `GET /api/extension/dashboard` — account email, owned agents with their envelope and rolling 24-hour spend, and up to 40 recent spend ledger entries.
- `PATCH /api/extension/dashboard` — update the envelope for an owned agent. Requires a valid extension-scoped bearer token and enforces `auto-approve ≤ per-payment ≤ daily`.
- `DELETE /api/extension/dashboard` — revoke the current extension token.
- OAuth: `/api/oauth/register`, `/oauth/authorize`, and `/api/oauth/token`, using S256 PKCE and the Chrome identity redirect URI.

The extension's OAuth scope is separate from MCP access. Extension tokens cannot authenticate to `/api/mcp`.

## Updating supported deployments

Keep the fixed deployment list in `manifest.json` (`host_permissions`) and `popup.html` (deployment selector) in sync. Local development is an optional host permission requested only after the user selects localhost. Avoid broad `<all_urls>` host access; request only Handsel origins that users can select.
