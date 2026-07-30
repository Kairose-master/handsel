# Base mainnet, kernel mode — the ordered runbook

`docs/mainnet-deploy.md` is the reasoning: what can cost you money, why the fee is
shaped the way it is, how the two gas layers must be ordered. Read it once.

This is the sequence, in order, with the reason each step comes where it does.
Every value here was verified rather than recalled; where something was read off a
chain or out of the code, it says so.

## Why a new deployment, not a repoint

Three deployments end up existing, and that is correct:

| | chain | role |
|---|---|---|
| `ai-agent-credit-dashboard` (v1) | Ethereum Sepolia | V1-contract archive |
| `handsel-nu` | Base Sepolia | testnet, permanently |
| **new** | Base mainnet | the real market |

**Not v1's code.** Checked: v1 has no `contracts/src/LaborMarketV2.sol`, no
`lib/onchain/labor-v2.ts`, no custom-error decoding, no market clock, no wired
mainnet guard. Deploying mainnet from it would re-ship every defect fixed since.

**Not `handsel-nu`'s database.** The credit score is the product's claim, and on
Base Sepolia it was earned with free tokens — `creditScore 670`, `creditLimit
60000`, both verified on chain. A mainnet inheriting that DB would let the first
agent borrow real money against a limit earned for free, which is the
self-Sybil problem in `docs/self-sybil-attack.md` arriving on day one. Mainnet
starts at a genuine cold start, the way the testnet requester still reads
`score 0, limit 0`.

**Not `handsel-nu` itself.** Kernel mode has executed zero times. Repointing the
only testnet leaves nowhere to find that out.

## New secrets, and why the owner key especially

```
DATABASE_URL                 new Neon project
AGENT_OWNER_PRIVATE_KEY      NEW — see below
ORACLE_PRIVATE_KEY           new (same value as owner if keeping one key)
API_KEY_ENCRYPTION_SECRET    new; must differ per deployment, it decrypts that
                             deployment's own DB. Set once, never rotated.
```

The owner key matters most. Agent addresses derive from it, so reusing the
testnet key would give the same `agentId` the same address on both chains — and a
testnet key is handled loosely by definition. A leak there would then be a
mainnet loss. This is a bigger separation than the arbiter, whose authority is
bounded to misdirecting a *disputed* job's escrow between worker and requester
(read from `resolveDispute`: it cannot pay itself).

## 1. ZeroDev, mainnet project

Separate project from the testnet one. Never reuse.

| setting | value | why |
|---|---|---|
| paymaster deposit | what you accept losing | the only cap that cannot be misconfigured |
| daily cap | **$10** | above the app's `USER_LANE` 5 + `KEEPER_LANE` 2 = $7, so the app degrades first |
| per-sender rate | 200/day | keeper does ≤6 calls per 5-minute pass |
| per-UserOp ceiling | ~10× a measured `postJob` | set after step 4, from the real number |
| contract allowlist | market + registry | add after step 4 |

Then `PAYMASTER_METERED=true` — the acknowledgement, not the policy. The guard
refuses every money path without it.

## 2. Database

Create the Neon project, then run `docs/schema-bootstrap-single.sql` in its SQL
editor. One statement, 44 tables. Verify with:

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
```

45 is correct (44 + the migrations bookkeeping table).

## 3. Registry

The current `CREDIT_REGISTRY_ADDRESS` is Base Sepolia. A mainnet market pointing
at it would publish scores to a contract on another chain — which fails rather
than lying, but fails late.

```bash
ONCHAIN_CHAIN=base ONCHAIN_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
ORACLE_ADDRESS=<new oracle address> \
node scripts/deploy-registry.mjs
```

## 4. Market

```bash
ONCHAIN_CHAIN=base \
ONCHAIN_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
CREDIT_REGISTRY_ADDRESS=<from step 3> \
ARBITER_ADDRESS=<new oracle address> \
FEE_BPS=200 FLAT_FEE=30000 FEE_RECIPIENT=<new oracle address> \
BOND_BPS=500 FLAT_BOND=30000 \
node scripts/deploy-labor-v2.mjs
```

`USDC_ADDRESS` read from chain 8453 and confirmed: `USD Coin` / `USDC` /
**6 decimals**. Six matters — every bounty, cap and fee is scaled by a
compile-time 6, and `decimalsBlocker` exists because an 18-decimal token would
escrow a $5 bounty as $5,000,000 without erroring.

**Pass no window overrides.** The script's defaults are open 60d, delivery
4h–30d, review 1d, dispute 14d. A stale `MIN_DELIVERY_WINDOW_S=600` in the shell
is how the Base Sepolia contract got a 600-second floor.

Then verify before trusting it:

```bash
node scripts/verify-bundle-labor-v2.mjs <new address> --rpc <mainnet rpc>
```

That reproduces the creation-bytecode keccak, compares runtime code with the 15
immutables masked, and emits the Basescan standard-JSON plus constructor args read
back from the chain.

## 5. Vercel

New project, `handsel` repo, plus everything above and:

```
ONCHAIN_CHAIN=base
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
LABOR_MARKET_ADDRESS=<step 4>
CREDIT_REGISTRY_ADDRESS=<step 3>
ARBITER_ADDRESS=<new oracle address>
ZERODEV_RPC=<step 1>
PAYMASTER_METERED=true
PLATFORM_FEE_BPS=0
FAUCET_MAX_PER_DAY=0
ANTHROPIC_API_KEY=...
```

`PLATFORM_FEE_BPS=0` is not optional. `platformFeeBps()` **defaults to 200**, so
leaving it unset charges 2% off-chain on top of the contract's 2% and every
requester pays twice. That is the `fee-charged-twice` blocker.

`FAUCET_MAX_PER_DAY=0` only became a real off switch recently — the parse was
`Number(x) || 15`, so an explicit zero fell through to fifteen.

## 6. Confirm before touching money

```bash
curl -s https://<new>/api/capabilities | python3 -m json.tool
```

Wanted:

```
runtime.agentAccountMode   "kernel"
runtime.bundlerConfigured  true
runtime.marketIsV2         true
runtime.realMoney.isRealMoney  true
runtime.realMoney.blockers     []
blocking                        []
```

A non-empty `blockers` names what to change and why. `unevaluated` listing the two
fee codes means the contract read failed, so they were neither passed nor
enforced — fix the RPC and re-check rather than proceeding.

## 7. Provision, and fund two things

Press Provision on each agent: kernel addresses differ from EOA ones, and
`provisionSmartAccount` overwrites the stored address unconditionally.

Then fund:

- **each agent's kernel account with USDC** — a requester with none cannot escrow,
  a worker with none cannot post a bond
- **each agent's kernel account with a few cents of ETH** — the self-pay float. If
  the sponsored budget is exhausted, an unsponsored UserOp pays from the kernel
  account itself; nothing tops this up, because `ensureAgentGas` spends the
  oracle's ether and is gated by the same budget it would be escaping

The oracle wallet does **not** need ETH for agent gas in kernel mode — the
paymaster covers it. It needs ETH only for `resolveDispute`, at a cent or two a
call.

## 8. One cycle, small

Bounty 0.1 USDC. Post → accept → submit → grade → approve → withdraw, and watch:

- `jobCount` 1, `totalEscrowed` 0.1
- the batch landing as ONE UserOp (kernel batches atomically; EOA sends in order)
- `gas_spend` recording a `user` lane row — the kernel path's first metered op
- `LimitUpdated` on the new registry

Kernel mode has never run. If something fails here it will most likely be in that
transport, and `explainOnchainError` now decodes the contract's custom errors with
their arguments, so the reason arrives as a sentence rather than
"execution reverted for an unknown reason".
