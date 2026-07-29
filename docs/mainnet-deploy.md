# Going to Base mainnet

The order matters, and it is not the obvious one. **The paymaster policy comes
before the contract**, because the contract cannot lose money that was never put
into it, and the paymaster can.

---

## What can actually cost you money

Three separate pools, with very different exposure:

| Pool | Who funds it | What bounds the loss |
|---|---|---|
| **ZeroDev paymaster** | You, continuously | **Nothing, until you set a policy.** Every sponsored UserOp is your ETH. |
| **Escrow in the contract** | Whoever posts a job | Bounded by what people escrow. You lose nothing you did not post. |
| **Deploy gas** | You, once | A few dollars. |

Only the first is open-ended, and it is open-ended in the way that matters: an
attacker does not need to beat the contract, they only need to make your app
send transactions. Every permissionless exit, every dispute ruling, every job
post is a sponsored UserOp.

So the policy is the real gate, and it goes first.

---

## 1. ZeroDev spending policy

In the ZeroDev dashboard, on the **mainnet** project (a separate project from
your testnet one — do not reuse):

- **A hard monthly cap you are willing to lose outright.** Treat this number as
  spent. If the answer is "I would be upset", it is too high.
- **A per-UserOp gas ceiling.** Base is cheap; a UserOp costing dramatically
  more than a normal `postJob` is a signal, not a transaction to sponsor.
- **A rate limit per sender.** The sweeps are capped at 3 calls per pass by
  `MAX_EXITS_PER_PASS` and `MAX_RULINGS_PER_PASS`, so a legitimate sender never
  approaches a sane limit.
- **Allowlist the contract address**, once you have it from step 3. A paymaster
  that will sponsor a call to any address is sponsoring calls to contracts you
  did not write.

Then set `PAYMASTER_METERED=true`. That is not what creates the policy — it is
your acknowledgement that you did. `lib/onchain/mainnet-guard.ts` **refuses**
every money path without it, and refuses rather than warns, because a warning on
a money path is a warning that gets scrolled past.

---

## 2. Deploy the registry

```bash
ONCHAIN_CHAIN=base ONCHAIN_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
ORACLE_ADDRESS=<hardware-backed key, NOT the deployer, NOT the arbiter> \
node scripts/deploy-registry.mjs --confirm-mainnet
```

`LaborMarketV2`'s constructor requires `registry` to be a contract, and its
address is **immutable**. Replacing a compromised registry later means replacing
the market too, and waiting out every live job.

The oracle key deserves more care than a backend key usually gets. It **cannot**
touch escrowed money — that was executed end-to-end during the audit with a
stolen key and the answer was zero, because the market never pays on the strength
of a score, only on approval, ruling, or silence. It **can** forge every score
the market gates on, and hand itself the registry via `setOracle`, which is a
single-step transfer with no two-step accept — so a compromise is a race the
attacker wins if they move first.

The script warns if you pass the deployer key as the oracle. Take the warning:
by then that key has touched a deploy script and an RPC endpoint, and the oracle
key should be one that has touched neither.

---

## Deploying twice on purpose

A perfectly reasonable plan, and Base Sepolia genuinely does not test the thing
that is actually unknown — Sepolia's USDC is a different contract, so a testnet
rehearsal validates the script and the app wiring, not the contract's behaviour
against real USDC or a real sequencer.

The one condition: **redeploying is cheap only while the first deployment holds
no money you care about.** Credited balances stay in a v2 forever — nobody can
move a credited balance for its owner and there is deliberately no sweep — so a
first attempt that has taken someone else's escrow cannot be abandoned, only
apologised for.

So treat deployment #1 as the rehearsal:

- Do not publish the address. Do not let anyone else post to it.
- Drive one full lap with your own money, in cents: post → accept → submit →
  approve → **withdraw** (settlement credits; it does not transfer, so a lap
  that stops at "approved" has not tested the half that pays).
- Drive one deadline lap too — post, let it sit past `reviewWindow`, and confirm
  the sweep calls `expireReview`. That path is the default outcome of the whole
  dispute design and nothing off-chain has ever executed it.
- If anything is wrong, deploy #2, repoint `LABOR_MARKET_ADDRESS`, and write off
  whatever dust is in #1.

---

## 3. Deploy the market

```bash
ONCHAIN_CHAIN=base \
ONCHAIN_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
USDC_ADDRESS=<Base USDC> \
CREDIT_REGISTRY_ADDRESS=<from step 2> \
ARBITER_ADDRESS=<a dedicated key, NOT the oracle> \
node scripts/deploy-labor-v2.mjs --confirm-mainnet
```

The script deploys the **committed** artifact rather than recompiling. Round 2
of the audit verified that artifact byte-identical to the audited source; a
script that recompiles at deploy time throws that guarantee away, because the
bytes reaching the chain become whatever the local solc produced that day.

It refuses, rather than warns, on: `base` without `--confirm-mainnet`, any unset
address, a `usdc`/`registry` with no code on the target chain, and a non-zero fee
with no recipient.

### The recommended first config, and why

Every one of these is **immutable**. There is no setter for any of them.

| | Default | Why |
|---|---|---|
| `FEE_BPS` | `0` | The audit's must-fix #3: a non-refundable posting fee turns squatting into a grief **the victim pays for**. Measured over five cycles at a 1,000,000 bounty and 200bps: requester −100,000, house +100,000, squatter's balance byte-identical. At `feeBps=0` the same five cycles cost nothing. |
| `BOND_BPS` | `0` | The bond is the real answer to squatting, but it requires a worker to hold capital before it can earn. On a market whose scarce side is supply, that kills supply. Turn it on when there is enough supply to bear it. |
| `REVIEW_WINDOW_S` | `1 day` | Not the 7 the constant used to hardcode. Seven days is very long for a market whose jobs finish in minutes, and it is the exposure window for both the accept-squat and the silence forfeit. |
| `SILENCE_FORFEIT_BPS` | `1000` | A worker submitting garbage earns 10% from any inattentive requester. That was chosen when the money was testnet. **Re-choose it now that it is not.** |

`ARBITER_ADDRESS` should be a **dedicated key**, not the oracle. The oracle
publishes scores; the arbiter moves money. One key doing both means one
compromise does both.

---

## 4. Verify on Basescan

solc **0.8.24**, optimizer **200 runs**, **viaIR ON**. viaIR is not optional —
the contract does not compile without it since the `jobs` getter reached 14
fields.

The deploy script prints the bytecode hash. A verification that does not
reproduce it is a different contract, whatever the source says.

---

## 5. Point the app at it

```
LABOR_MARKET_ADDRESS=<from step 3>
USDC_ADDRESS=<Base USDC>
PAYMASTER_METERED=true
```

`isV2Market()` detects V2 from the **deployed code**, not from an env flag — an
env var says what someone believed when they set it. Once it answers true, the
V1 dispute sweeps stand down and the deadline sweep takes over.

---

## What you are accepting

Stated plainly, because none of it is removable by a code change:

- **The contract is immutable, unowned and unpausable.** Every defect found
  after this is permanent. The only response is deploy v3, stop posting to v2,
  wait — and that only empties JOBS. Credited balances stay in v2 forever;
  nobody can move a credited balance for its owner, and there is deliberately no
  sweep. A post-only `halt()` was considered and declined, so the response to a
  discovered defect is to stop your own UI while an agent posting with its own
  key keeps funding a contract you know is broken.
- **The arbiter is a single immutable key with no rotation.** A silent arbiter
  is survivable — `expireDispute` is permissionless. A compromised one is not,
  and with a lien live it can destroy a lender's perfected security interest,
  which is a third party that is not in the dispute and gets no appeal.
- **USDC on Base is a Circle-upgradeable proxy.** The blocklist is handled. A
  transfer that returns no data would brick every withdrawal permanently — that
  one is closed by the SafeERC20 handling. A fee-on-transfer USDC would produce
  `held < owed`, which `escrowSolvency()` surfaces and nothing prevents.
- **No external audit yet.** Two adversarial rounds ran against
  `@ethereumjs/vm`, which proves nothing about real USDC, sequencer timestamp
  granularity, L2 reorg depth, or gas under real Base conditions. That is
  exactly the ground an external auditor with a forked-mainnet harness covers.

Start with amounts you would shrug at.
