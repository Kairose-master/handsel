# Collecting the protocol fee

The one balance this platform does not collect for you, why it is that way, and
the four commands that move it.

## Why there is no button

LaborMarketV2 **credits, it does not transfer.** Every payout — worker earnings,
refunds, and the posting fee — lands as a number in `withdrawable(address)` and
stays there until that address calls `withdraw()`. Pull, not push, so one
blocklisted recipient cannot revert somebody else's settlement.

`lib/withdraw-sweep.ts` makes that second transaction automatically, and it
covers exactly one population: rows in `agent` that have a smart account. The fee
recipient is not one of those. It has no kernel account, the paymaster does not
sponsor it, and no code in the running system has ever called `withdraw()` on its
behalf.

That is deliberate. Automating it means putting the key that owns the entire fee
stream into a server environment — and `scripts/preflight-addresses.mjs` already
refuses the neighbouring version of that idea, warning if `FEE_RECIPIENT` is set
to the same address as the oracle, *"the oracle key lives in the server's
environment … and this one owns the fee stream permanently."* The price of
keeping it out is that a human runs this by hand.

**`feeRecipient` is `immutable`.** No setter, written once by the constructor.
Lose that key and the fees accrue correctly and forever.

## What you need

| | |
|---|---|
| `LABOR_MARKET_ADDRESS` | the deployed LaborMarketV2 — public, it is in [`deployments.md`](deployments.md) |
| `ONCHAIN_RPC_URL` | any RPC for the chain (`https://mainnet.base.org` works) |
| `ONCHAIN_CHAIN` | `base` or `base-sepolia` |
| `FEE_RECIPIENT_KEY` | **only for the actual withdrawal.** The private key of the fee recipient |
| a little ETH | on the fee recipient. Nothing here is sponsored; it pays its own gas |

## 1. Look, without a key

Nothing below this line signs anything. Run it first — it tells you whether there
is anything to collect and whether the collection would work.

```bash
export LABOR_MARKET_ADDRESS=0x…            # from docs/deployments.md
export ONCHAIN_RPC_URL=https://mainnet.base.org
export ONCHAIN_CHAIN=base

node scripts/fee-withdraw.mjs
```

```
LaborMarketV2 0x…
chain         base (8453)  — REAL MONEY
feeRecipient  0x…  (immutable, read from the contract)

withdrawable  11.075 USDC   ← credited by settlement, not yet collected
already held  0.100 USDC    ← previously collected
gas balance   0.005 ETH
```

Read `feeRecipient` off the line the script prints, not out of your notes. It
comes from the contract, and **the contract is the authority** — the address in
your environment is a claim about the deploy, the address in the immutable is
what the money is actually credited to. If you also have `FEE_RECIPIENT` exported
the script compares them and says so when they disagree.

`export` and not `A=… B=…` on a line of its own: bare assignments set shell
parameters that are never exported, so the `node` on the next line sees none of
them. Every variable missing at once is almost always this and not four separate
mistakes — the script says so when it happens.

## 2. Collect it

```bash
export FEE_RECIPIENT_KEY=0x…               # never as an argument. see below
node scripts/fee-withdraw.mjs --send --confirm-mainnet
```

Or straight to a different wallet, which is one transaction rather than two:

```bash
node scripts/fee-withdraw.mjs --send --to 0xYourColdWallet --confirm-mainnet
```

`--confirm-mainnet` is required whenever `ONCHAIN_CHAIN=base`, the same guard
`scripts/deploy-labor-v2.mjs` uses. Not a prompt — a prompt is something you
learn to press through.

Before broadcasting, the script:

1. derives the address from your key and **refuses if it is not the contract's
   fee recipient**;
2. simulates the call, so a revert costs nothing and arrives with a reason;
3. re-reads `withdrawable` afterwards and prints what it is now.

Step 1 is the one that matters. `withdraw()` takes no arguments and moves
**`msg.sender`'s** balance, so signing with the wrong key does not revert — it
succeeds, withdraws zero, and reports a transaction hash. Without that check the
failure looks exactly like the success.

## 3. Put the key away

```bash
unset FEE_RECIPIENT_KEY
```

Never pass the key as a command-line argument. `argv` is readable by every
process on the machine and lands in your shell history; the environment is not.
This is the same rule the rest of the repo follows for child-process secrets.

## When it doesn't work

| What you see | What it means |
|---|---|
| `withdrawable 0` | Settlement has credited nothing since the last withdrawal. There is no backlog to find — this is the normal state between jobs. |
| `Could not read feeRecipient()` | The address is not a LaborMarketV2, or it is on a different chain than `ONCHAIN_CHAIN` says. The second is the quiet one: a market deployed to Base Sepolia, read on Base, answers every call with a revert. |
| `! 0 ETH` | The fee recipient cannot pay for its own transaction. Send it a cent or two. Nothing here is paymaster-sponsored. |
| `! The fee recipient is a CONTRACT` | Fees are pulled, so the recipient has to be able to make the call itself. A private key cannot sign for a plain contract, and this script cannot collect them. `preflight-addresses.mjs` warns about this *before* deploy for exactly this reason. |
| `FEE_RECIPIENT_KEY signs for 0x… but the contract's fee recipient is 0x…` | Working as intended. See step 2. |
| `Simulation reverted` | Nothing was sent. The message carries the contract's own reason. |

## What this does not do

It does not collect **worker** earnings. Those are the same mechanism —
`withdrawable` on the agent's smart account — but they belong to a different
population and `lib/withdraw-sweep.ts` already collects them on the ops cycle,
sponsored, largest-balance-first, capped at `MAX_WITHDRAWALS_PER_PASS` per pass.
If an agent's earnings are not arriving, that sweep is where to look, not here.
