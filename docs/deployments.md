# Deployments — one codebase, two kinds of chain

This codebase runs in two modes, and every user-facing label, guard and
funding path is decided by **which chain the environment points at** —
`isRealMoney()` in `lib/onchain/real-money.ts`, an allowlist of testnet chain
ids where an *unrecognised* chain counts as real money. Nothing asserts
"testnet" or "mainnet" anywhere; the chain does.

This page is the map. The per-mode guides are:

| I am deploying to… | read |
|---|---|
| A testnet (Base Sepolia / Sepolia) | [`deploy-testnet.md`](./deploy-testnet.md) |
| Base mainnet | [`mainnet-deploy.md`](./mainnet-deploy.md) (the reasoning) then [`mainnet-kernel-runbook.md`](./mainnet-kernel-runbook.md) (the executed runbook, with the live addresses) |

## The two live deployments

(Plus a third, minor one: `handsel-nu` — this repo on **Base Sepolia**, the
rehearsal deployment the mainnet contracts were byte-verified against. It
stays as the place to test V2 changes with faucet money.)

| | **Mainnet — Handsel** | **Testnet — Ledgermind (v1 archive)** |
|---|---|---|
| URL | https://handsel-main.vercel.app | https://ai-agent-credit-dashboard.vercel.app |
| Repo | `Kairose-master/handsel` (this repo) | `Kairose-master/ai-agent-credit-dashboard` |
| Chain | Base mainnet | Ethereum Sepolia |
| Token | Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | MockUSDC (freely mintable) |
| Market contract | `LaborMarketV2` `0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c` | V1 `LaborMarket` |
| Registry | `AgentCreditRegistry` `0x91acc4c081d3a364d3b713be8eec39a77f647290` | v1 registry |
| Money | **Real.** Fee 5% + 0.03 USDC, worker bond 5% + 0.03 USDC | None — test USDC, zero value |
| Settlement | Pull payment: credits `withdrawable`, a background sweep (or `withdraw()`) collects | Push on approval |
| Gas | **Self-paid** — `PAYMASTER_DISABLED=true`, each Kernel account holds a small ETH float | Sponsored (ZeroDev paymaster) |
| Funding an agent | Send real USDC to its deposit address | `mint_test_usdc` / mint button |
| Status | Live since 2026-07-30; first full job cycle settled on-chain the same day | Maintained as the public sandbox |

The v1 testnet deployment is not a staging environment for this repo — it is
the previous product, kept alive because a zero-value sandbox is the right
place to point someone who wants to try the mechanics before touching money.

## What is (and is not) live on mainnet

Deployed contracts are the market and the registry — **nothing else**. The
codebase carries more features than the mainnet deployment has switched on,
and each degrades gracefully when its env is absent (that is a repo
convention, not an accident):

| Feature | Mainnet today | Testnet | Gated by |
|---|---|---|---|
| Escrow / grading / settlement / credit scores | ✅ live | ✅ | `LABOR_MARKET_ADDRESS`, `USDC_ADDRESS` |
| Worker bond (stake on accept, returned on completion) | ✅ live | — (V1 has no bond) | deployed immutables |
| Gas sponsorship (paymaster) | ❌ off — pending a working mainnet paymaster | ✅ ZeroDev | `PAYMASTER_DISABLED`, `PAYMASTER_RPC`/`ZERODEV_RPC` |
| MiniVault / credit vault (borrowing against score) | ❌ not deployed | ✅ Sepolia sandbox | `MINIVAULT_ADDRESS`, `CREDIT_VAULT_ADDRESS` |
| On-chain governance (VeilPoll) | ❌ not deployed | ✅ | governance env |
| GitHub repo jobs (bounty label → PR → merge pays) | ❌ App not configured yet | ✅ | GitHub App env |
| Test-USDC minting | ❌ impossible (real USDC) | ✅ | chain (`mintBlocker`) |

If a doc, a UI string or a connector instruction claims one of the ❌ rows
works on mainnet, the doc is wrong — file it as a bug. The reverse claim
("testnet only, no real money") is equally wrong the moment it is written
without scoping to the testnet deployment; that exact sentence sat over real
mainnet balances for a day and is why this page exists.

## How the mode is decided, concretely

- `ONCHAIN_CHAIN` picks the chain; `isRealMoney()` classifies it.
- Real money **refuses** rather than warns: `realMoneyBlockers()` gates the
  money paths on the acknowledgements it requires (`PAYMASTER_METERED` ack or
  `PAYMASTER_DISABLED`, fee-charged-twice check, decimals check…).
- UI badges, footer notices, site metadata, `/connect`, `/start`, the MCP
  connector's instructions and the guided help all branch on the same
  function. A testnet deployment gets the "no monetary value" copy back
  automatically — none of it was deleted, it is just no longer asserted
  unconditionally.
