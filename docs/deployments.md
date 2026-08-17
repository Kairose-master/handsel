# Deployments — one codebase, two kinds of chain

This codebase runs in two modes, and every user-facing label, guard and
funding path **must** be decided by which chain the environment points at —
`isRealMoney()` in `lib/onchain/real-money.ts`, an allowlist of testnet chain
ids where an *unrecognised* chain counts as real money.

> **This page used to say "Nothing asserts 'testnet' or 'mainnet' anywhere; the
> chain does." That was false**, and the counterexample was the most-read
> sentence this project ships: the public landing page's hero disclaimer was a
> constant reading *"Running on a public testnet … with zero monetary value"*,
> rendered on Base mainnet as well. A third-party auditor found it; we did not.
> The rule is now enforced rather than asserted — `lib/money-label.ts` and
> `tests/money-label.test.ts` fail the build on any user-facing string that names
> an environment from a constant. See failure-modes §26.

This page is the map. The per-mode guides are:

| I am deploying to… | read |
|---|---|
| A testnet (Base Sepolia / Sepolia) | [`deploy-testnet.md`](./deploy-testnet.md) |
| Base mainnet | [`mainnet-deploy.md`](./mainnet-deploy.md) (the reasoning) then [`mainnet-kernel-runbook.md`](./mainnet-kernel-runbook.md) (the executed runbook, with the live addresses) |

## The three live deployments

Three public URLs, three different chains, and two of them are not this repo's
production. The count used to read "two" with the third in a parenthetical and
absent from the table below — which is how a maintainer reading only this page
was pointed at a *separate repo running a different contract* as "the" sandbox.

| | **Mainnet — Handsel** | **V2 rehearsal — Handsel** | **Testnet — Ledgermind (v1 archive)** |
|---|---|---|---|
| URL | https://handsel-main.vercel.app | https://handsel-nu.vercel.app | https://ai-agent-credit-dashboard.vercel.app |
| Repo | `Kairose-master/handsel` (this repo) | `Kairose-master/handsel` (this repo) | `Kairose-master/ai-agent-credit-dashboard` |
| Chain | Base mainnet (8453) | Base Sepolia (84532) | Ethereum Sepolia |
| Token | Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (faucet, no monetary value) | MockUSDC (freely mintable) |
| Market contract | `LaborMarketV2` `0x96064Ef0A6742D5B7bC8aBF2584273BD2F022C8c` | `LaborMarketV2` `0xD9bCF1740D4721988eC2c579e2Ec71D0eb904A09` | V1 `LaborMarket` |
| Registry | `AgentCreditRegistry` `0x91acc4C081d3a364d3b713be8eEc39A77F647290` | `AgentCreditRegistry` `0xA5C13188D8E379A7c36f0801f9944A14CdE58495` | v1 registry |
| Money | **Real.** Fee 5% + 0.03 USDC, worker bond 5% + 0.03 USDC | None — zero value | None — zero value |
| Settlement | Pull payment: credits `withdrawable`, a background sweep (or `withdraw()`) collects | Pull payment (same V2 code) | Push on approval |
| Gas | **Self-paid** — `PAYMASTER_DISABLED=true`, each Kernel account holds a small ETH float | Sponsored (ZeroDev paymaster) | Sponsored (ZeroDev paymaster) |
| Funding an agent | Send real USDC to its deposit address | faucet | `mint_test_usdc` / mint button |
| Purpose | Production | **Where V2 changes are tested** — the mainnet contracts were byte-verified against it | The previous product, kept alive |
| Status | Live since 2026-07-30; first full job cycle settled on-chain the same day | Live | Maintained as the public sandbox |

Verify any of these against the deployment itself rather than this table:
`GET /api/tasks` on each URL returns a `meta` block with `environment`,
`chainId`, `realMoney`, `currencyLabel` and `contractAddress`, computed from the
running configuration. **Those are facts; this table is a copy.**

There is a command for it, and running it beats trusting the paragraph above:

```bash
node scripts/verify-deployments.mjs
```

It reads the addresses out of this file, asks each live deployment which market
it is actually pointed at, and reads the contracts themselves. Exit 0 when all
three agree. It was written because this table shipped a **stale** Base Sepolia
market address — `0xbd0fb53d…`, a real LaborMarketV2 with one job in it, left
behind by an earlier rehearsal deploy and still quoted in a test comment. Every
character of it checked out except which contract the deployment points at,
which is the kind of wrong that survives review (§27).

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
| Worker bond (stake on accept, returned on completion) | ✅ live | ✅ live on the V2 rehearsal (test USDC, no monetary value); absent only from the separate V1 archive | deployed immutables |
| Gas sponsorship (paymaster) | ❌ off — pending a working mainnet paymaster | ✅ ZeroDev | `PAYMASTER_DISABLED`, `PAYMASTER_RPC`/`ZERODEV_RPC` |
| MiniVault / credit vault (borrowing against score) | ❌ not deployed | ✅ Sepolia sandbox | `MINIVAULT_ADDRESS`, `CREDIT_VAULT_ADDRESS` |
| On-chain governance (VeilPoll) | ❌ not deployed | ✅ | governance env |
| GitHub repo jobs (bounty label → PR → merge pays) | ✅ live since 2026-08-03 (`handsel-main` App) | ✅ | GitHub App env |
| Test-USDC minting | ❌ impossible (real USDC) | ✅ | chain (`mintBlocker`) |

If a doc, a UI string or a connector instruction claims one of the ❌ rows
works on mainnet, the doc is wrong — file it as a bug. The reverse claim
("testnet only, no real money") is equally wrong the moment it is written
without scoping to the testnet deployment; that exact sentence sat over real
mainnet balances for a day and is why this page exists.

Note the two ❌ vault rows have a second consequence, found later: any code that
asks *"is this deployment real money?"* by calling `isOnchainConfigured()` gets
`false` on **both** Base deployments, because that function requires
`CREDIT_VAULT_ADDRESS` and neither has a vault. The public landing hero was
branching correctly on a value that was therefore always `null`
(`marketRealMoney()` in `app/actions/guest.ts`, now gated on
`isLaborMarketConfigured()`). See failure-modes §28 — *a correct branch on a
wrong input is the same defect as no branch.*

## Where the terms are stated

Every deployment serves [`/participation`](https://handsel-main.vercel.app/participation)
— the custody model, the exact payout/bond/forfeit numbers **read from the
deployed contract** rather than typed into the page, the related-party
disclosure (most requesters are the operator), and the plain statement that
there is no KYC and no licensed intermediary. `/terms` and `/privacy` redirect
to it. It renders the commit sha, so a reader can bind what they agreed to to
a specific build. Written in answer to issue #5.

## Solana is a third kind of chain, not a third mode

`lib/onchain/chain-kind.ts` returns `'evm' | 'solana'`, and `isRealMoney()`
routes through it — because `isRealMoney()`'s allowlist is of *EVM* testnet
chain ids, so an unrecognised Solana cluster would have counted as real money
and worn the mainnet badge over devnet tokens worth nothing. A deployment is
Solana only when a valid cluster **and** a program address are both present;
half-set env reads as unconfigured, never as a broken market. The devnet
program (`8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H`) is deployed and the
board reads it — see [`solana-port.md`](./solana-port.md) for the addresses
verified on chain and for why deploying over a public RPC fails.

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
