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

| | Suggested | Why |
|---|---|---|
| `FLAT_FEE` | **the measured gas envelope** | See below. This is the number that makes sponsorship solvent. |
| `FEE_BPS` | `200` | Scales with the value at risk. It cannot cover gas on its own — see below — but it is the right shape for the part that *is* proportional. |
| `FLAT_BOND` | **≈ `FLAT_FEE`** | Makes `acceptJob` cost something at every bounty size. Returned in full unless the job is reclaimed. |
| `BOND_BPS` | `500` | The proportional half of the same. |
| `REVIEW_WINDOW_S` | `1 day` | Not the 7 the constant used to hardcode. Seven days is very long for a market whose jobs finish in minutes, and it is the exposure window for both the accept-squat and the silence forfeit. |
| `SILENCE_FORFEIT_BPS` | `1000` | A worker submitting garbage earns 10% from any inattentive requester. That was chosen when the money was testnet. **Re-choose it now that it is not.** |

### Why a percentage alone cannot work

**Revenue is per-POST; cost is per-ACTION.** A job's fee is charged once, at
`postJob`. Its gas is spent five or six times — post, accept, submit, approve,
and the withdrawals — and each of those is a sponsored UserOp the operator pays
for.

Worse, that expense is **flat**. A $0.05 job and a $100 job burn the same gas. A
bps fee scales with bounty; the cost does not. So:

| bounty | fee at 200bps | gas envelope (≈5 UserOps) | |
|---|---|---|---|
| $100 | $2.00 | ~$0.05 | solvent |
| $1 | $0.02 | ~$0.05 | underwater |
| $0.05 | $0.001 | ~$0.05 | **50× underwater** |

And it cannot be fixed by raising the percentage: `MAX_FEE_BPS` is 500, so the
most a deployment can ever charge on a $0.05 job is $0.0025. The ceiling is a
fraction of a number that is already tiny. **`MIN_BOUNTY`'s own comment says the
mainnet plan turns on cent-scale bounties**, which is precisely where the
proportional model has no solution.

`FLAT_FEE` is the fix: a floor sized at the gas envelope, charged once, never
refunded — because the gas was spent posting, and a refundable gas reimbursement
is a loan.

### And why the bond needs the same treatment

The identical arithmetic breaks the defence on the worker side. 5% of a $0.05
bounty puts $0.0025 at risk, which deters nobody — so `acceptJob` stays
effectively free exactly where the market is thinnest. **A free `acceptJob` is
the one action an attacker can repeat at zero cost while the operator pays gas
for every one of them**, which is the DDoS shape the ZeroDev cap exists to
survive rather than prevent.

`FLAT_BOND` prices it. An honest worker locks it for the length of one job and
gets every unit back; only `reclaimJob` — a deadline passed with an empty
`resultHash`, no judgement involved — takes it.

### How the money actually gets back to the paymaster

The fee accrues as **USDC**, credited to `feeRecipient` inside the contract. The
loop is manual and it does close: `withdraw()` the accrued USDC → convert to ETH
→ top up the ZeroDev paymaster. Watch it on `/admin/health`; if fee revenue is
not keeping pace with paymaster burn, `FLAT_FEE` was set below the real envelope
and the only fix is a redeploy.

### Sizing FLAT_FEE

Deployment #1 is how you measure it. Drive one full lap, read the actual gas from
Basescan, multiply by the number of sponsored UserOps in a job's lifecycle, add
margin, and set `FLAT_FEE` on deployment #2. This is a concrete reason the
two-deployment plan is the right one rather than a concession: **the first
deployment produces the number the second one needs.**

Token units, not dollars. USDC has 6 decimals, so $0.03 is `30000`.

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
