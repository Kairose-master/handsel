# Deploying to a testnet

The testnet deployment exists to run the code the mainnet deployment hopes
never to run: the timeout exits, the budget fuse blowing, the paymaster cap
tripping. Deploy it configured to make those things happen, not to imitate
production. (For what mainnet vs testnet means in this codebase, see
[`deployments.md`](./deployments.md); for the mainnet path, see
[`mainnet-deploy.md`](./mainnet-deploy.md).)

Two testnet shapes exist:

- **Base Sepolia** — the rehearsal for this repo's V2 contracts. Same deploy
  scripts, same Circle-shaped USDC, worthless ETH. This is the one this guide
  describes.
- **Ethereum Sepolia (v1 / Ledgermind)** — the original public sandbox at
  `ai-agent-credit-dashboard.vercel.app`, running the V1 contract with
  MockUSDC. It is a separate repo and stays as the zero-value demo; nothing
  here redeploys it.

## 1. Chain + token

```
ONCHAIN_CHAIN=base-sepolia
ONCHAIN_RPC_URL=<a Base Sepolia RPC>
USDC_ADDRESS=<Circle's Base Sepolia USDC>
```

Prefer Circle's testnet USDC over MockUSDC when rehearsing V2: it is the same
proxy-and-blocklist shape as mainnet, which is what the pull-payment design
defends against. MockUSDC is the right token only when you want the mint
faucet (`mint_test_usdc`, the profile mint button, the dogfood house wallet's
self-top-up) — those paths call `mint()` and exist **only** where the token
permits it. On real USDC they revert, and the UI knows to hide them.

## 2. Contracts — deliberately NOT at the defaults

The defaults in `scripts/deploy-labor-v2.mjs` are tuned for a real deployment.
Used on testnet they hide the two things a testnet exists to find.

**Every window at its floor.** `MIN_WINDOW` is 10 minutes; set every window to
`600` so all four permissionless exits are reachable the same afternoon:

    reclaimJob      accept, wait 10 min, never submit   → bond burned
    expireReview    submit, wait 10 min, never approve  → silence forfeit
    expireDispute   dispute, wait 10 min, never rule    → pays the worker
    expireOpen      post, wait 10 min, nobody accepts

**Fee and bond NON-ZERO.** They default to zero, and zero is exactly the
branch mainnet already exercises. Non-zero runs the code that needs the
rehearsal: `postJobV2` approving `bounty + fee` via `postCost()`, `acceptJobV2`
approving `bondFor()`, and `_burnBond` on reclaim.

| var | value | |
|---|---|---|
| `FEE_BPS` / `FLAT_FEE` | `500` / `30000` | 5% + 3¢ — the shape mainnet actually deployed. |
| `BOND_BPS` / `FLAT_BOND` | `500` / `30000` | Same. Token units: USDC has 6 decimals, `30000` = $0.03. |
| `MIN_DELIVERY_WINDOW_S` … `DISPUTE_WINDOW_S` | `600` each | The contract floor — every exit testable today. |
| `MIN_BOUNTY` | `1` | One token unit. |

Then the usual two steps, same scripts as mainnet minus `--confirm-mainnet`:

```bash
node scripts/preflight-addresses.mjs        # ARBITER must equal ORACLE; FEE_RECIPIENT must not
node scripts/deploy-registry.mjs
node scripts/deploy-labor-v2.mjs
node scripts/verify-bundle-labor-v2.mjs <address> --tx <deploy tx>
```

Cost: nothing. Faucet ETH, faucet USDC.

## 3. Gas — sponsorship ON, and set to fail on purpose

Testnet is where sponsorship runs, and where you rehearse its failure. Use a
ZeroDev project **separate from any mainnet project** and point `ZERODEV_RPC`
at it (or a `PAYMASTER_RPC` + `BUNDLER_RPC` pair — the app resolves either;
see `lib/onchain/paymaster.ts` for the precedence).

The one thing you must never meet for the first time on mainnet is your own
app hitting the cap. The designed behaviour — degrade to self-pay, keeper
reserve untouched — has to be *watched*, so set the dashboard TIGHT:

| setting | set to | why |
|---|---|---|
| daily cap | **$1** | Below the app fuse's ~$7 ceiling, so the provider cap blows FIRST. Backwards for production, exactly right here. |
| per-sender rate | **50/day** | A runaway loop trips it in minutes instead of overnight. |
| per-UserOp ceiling | leave generous | You are measuring cost, not bounding it yet. |
| contract allowlist | market + registry | Rehearse the step so it is not new on mainnet. |

**Dashboard units are ETH, not USD, on the gas-spend fields.** Entering `1`
against a "$1/day" intention is ~a full ETH of allowance. This mistake was
made here once; the numbers above are dollar intentions — convert them.

Then raise the daily cap above the app fuse and confirm the order flips: the
fuse degrades to self-pay and the sweeps keep running. Two runs, opposite
outcomes, both observed before any of it is worth money.

## 4. What a testnet deployment turns on that mainnet has off

Everything degrades gracefully by env (the repo convention), so "on" is just
setting the variable:

| feature | env | note |
|---|---|---|
| Mint faucet | MockUSDC as `USDC_ADDRESS` | `mintBlocker` allows it only off-mainnet. |
| MiniVault sandbox | `MINIVAULT_ADDRESS` | The GIWA-style collateral vault; lives on Sepolia. |
| Credit vault / reputation lending | `CREDIT_VAULT_ADDRESS` | Scores publish on-chain; limits become drawable. |
| Governance (VeilPoll) | governance env | Commit–reveal ballots. |
| Dogfood faucet jobs | `X402_JOB_REQUESTER_AGENT_ID` | House wallet self-mints top-ups — testnet only by nature. |

None of these belong on mainnet until they have their own deploy + audit
story; the mainnet feature matrix in [`deployments.md`](./deployments.md) is
the source of truth for what is actually live there.

## 5. The labels take care of themselves

`isRealMoney()` classifies the chain, and every badge, footer notice, consent
screen and MCP instruction follows it. A testnet deployment automatically gets
the "test USDC, no monetary value" copy and the mint-first onboarding; nothing
needs configuring, and nothing should be hardcoded — the day a hardcoded
"testnet" met a mainnet balance is documented in the git history of exactly
those files.
