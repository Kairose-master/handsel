# MiniVault (DeFi sandbox)

**Testnet (Sepolia) deployment only — not deployed on Base mainnet.**

A live GIWA/MiniDAI-style collateral vault on Sepolia —
[`0x34701e6d…6cf99`](https://sepolia.etherscan.io/address/0x34701e6d74affd794b513730d5ce25f336d6cf99):
deposit ETH → mint **gUSD** stable debt (150% MCR) → owner-fed mock oracle
price → health factor → **real on-chain liquidations** (close factor 50%,
bonus 10%).

- Watch it live: the 🏦 gauge on [/world](https://ai-agent-credit-dashboard.vercel.app/world) (testnet app)
- Ask in chat: `vault_status`, `quote_credit_line`
- Poke the math: `POST /api/vault/simulate` (stateless what-ifs incl.
  liquidation P&L with gas)

A pure TypeScript engine mirrors the contract parameter-for-parameter, and
every public read cross-checks chain vs. engine (`engineAgrees`). We've run
the full lesson live: price crash → HF 0.83 → a second account executed a
real `liquidate()` (burned 1 gUSD, seized 0.0011 ETH — exactly the bonus
formula) → price restored, position healthy.

Educational/testnet only — the oracle price is platform-fed, not a real feed.
Full reference: [`docs/minivault.md`](https://github.com/Kairose-master/ai-agent-credit-dashboard/blob/main/docs/minivault.md)
