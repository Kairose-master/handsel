# MiniVault — the on-chain DeFi sandbox

> MiniVault exists only on the Sepolia testnet deployment — these endpoints
> and the `vault_status` tool are inert on the Base mainnet deployment.

A GIWA/MiniDAI-style collateral vault, live on **Sepolia** at
[`0x34701e6d74affd794b513730d5ce25f336d6cf99`](https://sepolia.etherscan.io/address/0x34701e6d74affd794b513730d5ce25f336d6cf99):
ETH collateral → mint **gUSD** (a minimal ERC-20 stable) → owner-fed mock
price oracle → health factor → **real liquidations**. Educational/testnet —
the oracle price is pushed by the platform, not a production feed.

## Parameters (contract ⇄ TS engine, intentionally identical)

| param | value |
|---|---|
| MCR (mint gate) | 150% — `debt ≤ collateralValue / 1.5` |
| Liquidation ratio | 120% — `HF = collateralValue / (debt × 1.2)`, HF < 1 → liquidatable |
| Close factor | 50% of debt per liquidation |
| Liquidation bonus | 10% on seized collateral |

The pure TypeScript engine (`lib/mini-vault.ts`, unit-tested incl. AMM math)
mirrors the contract parameter-for-parameter, so every on-chain number can be
cross-checked off-chain — the public endpoint reports `engineAgrees` on each
read.

## Endpoints

| endpoint | what |
|---|---|
| `GET /api/vault/onchain[?user=0x…]` | Live contract state + position + engine cross-check (keyless; defaults to the demo position) |
| `POST /api/vault/simulate` | Stateless what-if: position + price → max debt, HF, draw preview, liquidation preview with gas-aware liquidator P&L |
| `GET /api/vault/quote-collateral?agent=<name>` | An agent's real earned USDC previewed as collateral at $1 |
| `POST /api/admin/minivault?action=…` | Ops (CRON_SECRET): `deploy` · `set-price` · `demo` (deposit+mint) · `liq-prep` · `liq-run` · `read` |

Connector tools: `vault_status`, `quote_credit_line`. Live gauge: the
**🏦 MiniVault card on [/world](https://ai-agent-credit-dashboard.vercel.app/world)
(the testnet app)**.

## The recorded live walkthrough (all real Sepolia txs)

1. **Deploy** at $3,000/ETH
2. **Deposit 0.002 ETH + mint 2 gUSD** → value $6, max debt $4, HF 2.5
3. **Crash the oracle to $1,000** → HF 0.833 → `LIQUIDATABLE`
4. **A second account** (the demo liquidator, funded with gas + 1 gUSD)
   calls `liquidate()` → burns 1 gUSD, seizes 0.0011 ETH
   (= 1 × 1.10 / 1000 — exactly the bonus formula)
5. **Restore $3,000** → position 0.0009 ETH / 1 gUSD, HF 2.25, healthy
6. `engineAgrees: true` at every step

Re-run it any time: `action=liq-prep` then `action=liq-run&crash=1000&restore=3000`.

## Build & deploy pipeline

- `contracts/MiniVault.sol` — single compact contract (ERC-20 gUSD + vault +
  oracle + liquidation, reentrancy-guarded, checks-effects-interactions)
- `node scripts/compile-minivault.mjs` — solc-js → committed ABI+bytecode
  artifact (`lib/onchain/minivault-artifact.ts`), so the server deploys
  without bundling solc
- Deployment runs **server-side with the platform oracle wallet** via the
  admin route; the address is persisted in `platform_secrets`
  (`minivault_address`) — no env var or redeploy needed to adopt it.
