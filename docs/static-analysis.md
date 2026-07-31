# Static analysis: Slither and Mythril on the mainnet contracts

Run on 2026-07-31, against the exact source that is verified on Basescan.

**This is the first time either tool has been run on this code.** It was
prompted by a question on the r/ethdev challenge thread — *"You contract passed
slither and mithril?"* — which is a fair thing to ask of anyone offering $100 to
break their contract, and the honest answer at the time was "I don't know."
Recording that here rather than quietly running them and claiming a clean sheet:
the date this document starts is the date the question was asked, not the date
the contract was deployed.

Static analysis is weak evidence. It finds the classes of bug it has detectors
for, on the code as written, with no notion of what the code is *for* — none of
it substitutes for an external audit, and none of it is why the $100 is sitting
on mainnet. `docs/security-audit.md` (the self-audit) and
`docs/open-challenge.md` (the bounty) are the other two, also weak, also stated
as such.

---

## Summary

| target | tool | findings | High | Medium |
|---|---|---|---|---|
| `LaborMarketV2` | Slither 0.11.6 | 36 | **0** | 3 |
| `AgentCreditRegistry` | Slither 0.11.6 | 2 | **0** | 0 |
| `LaborMarketV2` | Mythril 0.24.8 | 62 | 52 † | 1 |

† **Every one of Mythril's 52 "High" findings is SWC-101 on code that has no
arithmetic in it** — 25 of the 47 flagged functions are argument-less getters
like `arbiter()` and `MAX_FEE_BPS()`. §Mythril below shows the evidence rather
than asking you to accept the dismissal.

Slither reports no High-impact finding on either contract. One Low finding on
the registry is **real and unfixed** (§Registry below) — it is not a fund-loss
path, and the contracts are immutable, so it is documented rather than patched.

## Reproducing

`solc` must be **0.8.24** — the same compiler the deployment used
(`0.8.24+commit.e11b9ed9`) — and `--via-ir` is not optional: without it the
contract hits "Stack too deep" and does not compile at all.

```bash
pip install slither-analyzer solc-select
solc-select install 0.8.24 && solc-select use 0.8.24

# `contracts/foundry.toml` makes Slither auto-detect Foundry and shell out to
# `forge`, which isn't installed; force the plain-solc path.
slither contracts/src/LaborMarketV2.sol \
  --compile-force-framework solc \
  --solc-args "--optimize --optimize-runs 200 --via-ir"

slither contracts/src/AgentCreditRegistry.sol \
  --compile-force-framework solc \
  --solc-args "--optimize --optimize-runs 200 --via-ir"
```

---

## `LaborMarketV2` — Slither

`0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c`. 3 contracts, 102 detectors,
36 results: **0 High, 3 Medium, 22 Low, 11 Informational.**

### The 3 Medium findings — all `incorrect-equality`, all false positives

```
LaborMarketV2._credit(uint256,address,uint256)     #1069-1075
LaborMarketV2._burnBond(uint256,address,uint256)   #1110-1114
LaborMarketV2._withdrawTo(address)                 #1232-1242
```

Each is the same line shape, and in all three cases the flagged expression is
`amount == 0`:

```solidity
function _credit(uint256 jobId, address to, uint256 amount) private {
    if (amount == 0) return;
    ...
```

`incorrect-equality` exists to catch strict equality against values an attacker
can nudge — `address(this).balance == 1 ether`, `block.timestamp == x`. Here
`amount` is a locally computed accounting number, and the comparison is an
early-return guard, not a condition anything of value hangs on. Making the
detector quiet (`> 0`, `!= 0`) would change no behaviour and would be a change
made to satisfy a tool rather than to fix a defect, so the code stands and the
finding is recorded as noise.

**Stated plainly so it can be checked rather than trusted:** that judgement is
mine, and I wrote the code the tool is complaining about. The line numbers are
above; the source is verified on Basescan. If one of these is a real bug I am
waving off, that is exactly the kind of thing the challenge is paying for.

### The 22 Low findings

- **18 × `timestamp`** — "uses timestamp for comparisons". This contract is a
  deadline machine: `reclaimable`, `expireOpen`, `expireReview`,
  `expireDispute`, `reviewExpirable`, `disputeExpirable` all compare
  `block.timestamp` against a stored deadline, which is what they are for. The
  windows are hours to days (4h floor, 30d ceiling, 1d review, 14d dispute) and
  the miner-manipulable slack is seconds, so nothing here is decided by the
  drift. **Six of the eighteen do not involve `block.timestamp` at all** — the
  detector also caught the same `amount == 0` guards as above, plus the
  `!ok || (ret.length != 0 && !abi.decode(ret,(bool)))` return-value check in
  `_safeTransfer` / `_safeTransferFrom`. That is detector over-fire, and it is
  worth knowing that a raw "18 timestamp findings" line overstates the count by
  a third.
- **1 × `reentrancy-benign`** and **3 × `reentrancy-events`** — in `postJob`,
  `acceptJob`, and `_withdrawTo`. All three write state before the token call
  (checks-effects-interactions) and the flagged residue is event emission
  ordering after an external call. The token is Circle USDC, which is not
  reentrant; `_withdrawTo` zeroes `withdrawable[msg.sender]` *before* the
  transfer specifically so that the one thing this contract must never do —
  pay the same balance twice — does not depend on that assumption.

### The 11 Informational findings

- **7 × `naming-convention`** — `SCREAMING_CASE` immutables
  (`DISPUTE_WINDOW`, `MIN_BOUNTY`, `SILENCE_FORFEIT_BPS`, …) flagged as "not in
  mixedCase". Deliberate: they read as constants at every call site because
  they never change after construction.
- **3 × `low-level-calls`** — `_safeTransfer`, `_safeTransferFrom`,
  `usdcBalance`. Deliberate, and the reason is the one that motivated
  SafeERC20 in the first place: tokens that return nothing on success. The
  decode is guarded on `ret.length != 0`.
- **1 × `cyclomatic-complexity`** — the constructor, complexity 15. It is a
  wall of config validation (fee/bond bps ceilings, window floors and
  ceilings, non-zero addresses). Complexity in a constructor that runs once and
  then cannot be re-entered is a different risk than complexity in a settlement
  path.

---

## `AgentCreditRegistry` — Slither

`0x91acc4c081d3a364d3b713be8eec39a77f647290`. 1 contract, 102 detectors,
2 results: **0 High, 0 Medium, 2 Low**, both `missing-zero-check`.

```
AgentCreditRegistry.constructor(address)._oracle   #22 → oracle = _oracle
AgentCreditRegistry.setOracle(address).newOracle   #32 → oracle = newOracle
```

**The `setOracle` one is real, and it exists in this document because someone
asked a question.** It was found on the first Slither run, which happened
because of the r/ethdev comment quoted at the top — one sentence from a reader
produced a finding that eighteen days of writing this contract did not. That is
worth recording as its own data point about what self-review is worth.

`setOracle` is `onlyOracle`, so a call with
`address(0)` is a single transaction that permanently removes the only account
able to publish credit limits — the registry keeps serving its last written
`creditLimit` / `creditScore` values forever and can never be updated again.
No funds are at risk (the registry holds none, and `LaborMarketV2` reads it
only to gate `minScore` on job acceptance), but it is a one-keystroke brick.

It is not being fixed, and the reason is worth stating rather than eliding:
**the contracts are immutable and unpausable** — there is no upgrade path, so
"fix" means "redeploy and migrate", which is a larger action than the defect
warrants while the registry's oracle key is a single operator-controlled
address that never needs rotating to zero. It goes on the v2-plan list
(`docs/v2-plan.md`) instead.

The constructor finding is the same check at deploy time. It was satisfied in
practice — `oracle` on the live registry reads
`0x81C76907812A098427E177B1Ef9779157a3D3B68`, which is also
`LaborMarketV2.arbiter`, the invariant `docs/basescan-verification.md` records.

---

## `LaborMarketV2` — Mythril

Mythril symbolically executes bytecode rather than reading source, so it was
run against the runtime bytecode produced by the **same standard-JSON input
that Basescan verified** (`docs/verify-labor-v2.standard.json`, 8,943 bytes of
runtime code), not against a separate compile:

```bash
python3 -m venv myth-venv && ./myth-venv/bin/pip install mythril "setuptools<81"
./myth-venv/bin/myth analyze -f LaborMarketV2.runtime.hex --bin-runtime \
  --no-onchain-data --execution-timeout 3600 -t 3 --parallel-solving -o json
```

(`setuptools<81` is needed because `py-evm` still imports `pkg_resources`; on
Debian the build also needs a clean venv rather than the system Python.)

**62 issues: 52 High, 1 Medium, 9 Low.** All 52 Highs are the same detector,
SWC-101 "Integer Arithmetic Bugs", and **the reason to disbelieve all of them
is visible without trusting my judgement**:

| flagged function | body |
|---|---|
| `arbiter()`, `usdc()`, `registry()`, `feeRecipient()` | `return <immutable address>` |
| `MAX_FEE_BPS()`, `MIN_BOUNTY()`, `REVIEW_WINDOW()`, … | `return <constant>` |
| `jobCount()`, `totalEscrowed()`, `totalWithdrawable()` | `return <storage slot>` |

**25 of the 47 distinct functions Mythril flags for arithmetic overflow contain
no arithmetic operator at all** — they are argument-less getters, and the
transaction sequence Mythril produces to "reproduce" each one is a bare 4-byte
selector with no arguments. A detector that reports an overflow in
`return arbiter;` is reporting on the compiler's own code — under `--via-ir`
the ABI encoder does free-memory-pointer arithmetic on every call path — and
once that is established the class carries no signal for the other 22 either.

Independently, and this is the stronger argument: **the contract contains zero
`unchecked` blocks** under `pragma ^0.8.24`. Every arithmetic operation in the
source is compiler-checked and reverts with `Panic(0x11)` on overflow or
underflow. The hazard SWC-101 names — silent wraparound producing a wrong
number that then moves money — is structurally impossible here. The worst a
real instance could mean is "this call reverts", which is a liveness question,
not a solvency one.

- **1 Medium, SWC-123 "requirement violation"** in `usdcBalance()`. It is a
  `staticcall` to the USDC address, and the run used `--no-onchain-data`, so
  that address has no code and the nested call reverts. An artifact of running
  the analyzer detached from chain state, not a property of the contract.
- **9 Low, SWC-116 "dependence on predictable environment variable"** — the
  same `block.timestamp` deadline comparisons Slither found, in `expireOpen`,
  `expireReview`, `raiseDispute`, `submitWork` and friends. Same disposition:
  the windows are hours to days and miner-manipulable slack is seconds.

**So: Mythril reports 52 High and I am dismissing all 52.** That is the least
credible-sounding sentence in this document, which is why the evidence for it
is a table anyone can check against verified source rather than an assurance.
If a real overflow is hiding in there, the $100 on job #3 is what it is for.

---

## What this does and does not establish

It establishes that two widely used detectors, pointed at the deployed source
and bytecode, do not report a High-impact issue, and it puts every Medium and
Low finding in public with a written reason for each disposition.

It does not establish that the contract is safe. Static analysis has no model
of what "the requester's escrow" means, so the bugs it cannot see are exactly
the ones that matter most here: a settlement path that pays the wrong party, a
window that lets someone reclaim money twice, an accounting drift between
`totalEscrowed` and the real balance. Those need either an auditor or an
adversary, and the $100 on job #3 is an attempt to buy the second one cheaply.
