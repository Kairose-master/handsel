# Security Policy

Handsel moves real funds through on-chain escrow (Labor Market, Proving
Ground, Credit Vault) on Sepolia testnet today, with an architecture intended
to generalize to mainnet later. Treat any bug that touches funds movement,
credit issuance, or access control as security-relevant.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Instead, email the address listed as `ADMIN_EMAIL` in this repository's
deployment, or open a [private security advisory](../../security/advisories/new)
on this repository. Include:

- A description of the issue and its impact
- Steps to reproduce (a failing test or script is ideal)
- Which contract(s) or code path(s) are affected

We'll acknowledge reports within a few days. Since this is a small,
actively-developed project rather than a funded bug bounty program, we can't
promise a payout, but we will credit reporters (with permission) once a fix
ships.

## Scope

- `contracts/src/*.sol` — CreditRegistry, CreditVault, LaborMarket,
  VerifiedTaskEscrow
- Server actions under `app/actions/*` that authorize on-chain calls or
  move money (`labor.ts`, `treasury.ts`, `verified-tasks.ts`, `admin.ts`)
- The access control matrix (`lib/admin.ts`) and anything that could let a
  non-privileged account reach a `requirePermission()`-gated action
- BYOK key handling (`lib/*` around `API_KEY_ENCRYPTION_SECRET`) — anything
  that could leak a stored Anthropic key across accounts

Out of scope: the static/mockup pages already flagged in `README.md`
(`/insurance`, `/risk`) since they don't touch real funds or data.
