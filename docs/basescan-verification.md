# Verifying the mainnet contracts on Basescan

Verification is the prerequisite for the public challenge: an attacker who
cannot read the contract is being asked to break a black box, not audited code.
The bytecode was already reproduced locally against the committed source
(`scripts/verify-bundle-labor-v2.mjs`); this is the last step, publishing that
match on Basescan so anyone can check it without trusting this repo.

This is an **operator action** — it needs your own Base RPC and a Basescan API
key, neither of which lives in the codebase. Everything you paste in is below.

## What to verify

| contract | address |
|---|---|
| `LaborMarketV2` | `0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c` |
| `AgentCreditRegistry` | `0x91acc4c081d3a364d3b713be8eec39a77f647290` |

## Compiler settings — must match exactly

Read off the committed standard-JSON (`docs/verify-labor-v2.standard.json`),
which is the input the deploy compiled from:

| setting | value |
|---|---|
| Compiler type | Solidity (Standard-JSON-Input) |
| Compiler version | **v0.8.24** |
| Optimizer | **enabled** |
| Optimizer runs | **200** |
| viaIR | **true** |

`viaIR: true` is not optional — the contract does not compile without it since
the `jobs` getter reached 14 fields. A verification attempt with viaIR off
produces different bytecode and fails, so if Basescan reports a mismatch, check
this first.

## The constructor arguments, already computed

Read off the live contracts on 2026-07-31 and ABI-encoded — paste these straight
into Basescan's "Constructor Arguments ABI-encoded" box, **without the `0x`**.
(Step 1 below regenerates them from scratch if you'd rather not trust this file.)

**LaborMarketV2** — `0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c`:

```
000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000091acc4c081d3a364d3b713be8eec39a77f64729000000000000000000000000081c76907812a098427e177b1ef9779157a3d3b6800000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000e818cf591e65c93600311e789f25301138299232000000000000000000000000000000000000000000000000000000000000753000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000753000000000000000000000000000000000000000000000000000000000000038400000000000000000000000000000000000000000000000000000000000278d00000000000000000000000000000000000000000000000000000000000001518000000000000000000000000000000000000000000000000000000000004f1a00000000000000000000000000000000000000000000000000000000000012750000000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000001
```

**AgentCreditRegistry** — `0x91acc4c081d3a364d3b713be8eec39a77f647290`:

```
00000000000000000000000081c76907812a098427e177b1ef9779157a3d3b68
```

### What those decode to (all read from the chain, all matching the runbook)

| | |
|---|---|
| usdc | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle USDC) |
| registry | `0x91acc4C081d3a364d3b713be8eEc39A77F647290` |
| arbiter | `0x81C76907812A098427E177B1Ef9779157a3D3B68` |
| feeRecipient | `0xe818cf591E65C93600311E789f25301138299232` |
| feeBps / flatFee | 500 (5%) / 30000 ($0.03) |
| bondBps / flatBond | 500 (5%) / 30000 ($0.03) |
| delivery window | 14400s (4h) floor · 2592000s (30d) ceiling |
| review / open / dispute | 86400s (1d) · 5184000s (60d) · 1209600s (14d) |
| silenceForfeitBps | 1000 (10%) |
| minBounty | 1 unit |

Two invariants confirmed while reading these, both worth re-checking after any
redeploy: **`market.arbiter == registry.oracle`** (otherwise `resolveDispute`
reverts `NotArbiter` and every dispute settles by timeout instead), and
**`feeRecipient != oracle`** (otherwise the fee stream is welded to the hot key
the server signs with).

## Step 1 — regenerate the constructor arguments

The constructor args are ABI-encoded from the values the chain actually holds,
so read them off the chain rather than retyping them:

```bash
export ONCHAIN_RPC_URL=<your Base mainnet RPC>
node scripts/verify-bundle-labor-v2.mjs 0x96064ef0a6742d5b7bc8abf2584273bd2f022c8c \
  --rpc "$ONCHAIN_RPC_URL" \
  --tx <the LaborMarketV2 deployment transaction hash>
```

It prints two things you need:

- **`ABI-encoded constructor arguments (paste WITHOUT the 0x)`** — copy this for
  the Basescan form.
- the **creation-bytecode keccak match** confirmation — if this line does not say
  the local source reproduces the on-chain code, STOP: verifying a mismatch just
  publishes the wrong source. It should reproduce `0xf9e4abc1…0bc3bcd`.

Pass `--tx` — without it the script reads 18 getters one at a time and a public
RPC will rate-limit partway through; with it the args come from the deployment
transaction's input in one request.

## Step 2 — submit

Two ways, same inputs.

### Web UI

1. Basescan → the contract address → **Contract** tab → **Verify and Publish**.
2. Compiler type: **Solidity (Standard-JSON-Input)**. Version **v0.8.24**.
3. Upload `docs/verify-labor-v2.standard.json`.
4. Paste the constructor args from Step 1 (no `0x` prefix).
5. Submit. Basescan recompiles and compares; a match publishes the source.

### API (scriptable, needs a Basescan API key)

```bash
export BASESCAN_API_KEY=<your key>
# POST module=contract action=verifysourcecode to https://api.basescan.org/api
# with codeformat=solidity-standard-json-input, the standard JSON as sourceCode,
# compilerversion=v0.8.24, constructorArguements=<step 1 output>.
```

The web UI is simpler for a one-time verification; the API only pays off if you
script it into the deploy.

## Step 3 — the registry

Same flow for `AgentCreditRegistry` at
`0x91acc4c081d3a364d3b713be8eec39a77f647290`. Its constructor takes the oracle
address; regenerate its args the same way (point the script at its address and
deploy tx) rather than retyping the oracle address.

## When it's done

Both contracts show a green **Contract Source Code Verified** check, and the
Read/Write Contract tabs render. That is the state the challenge page should
link to — "here is the money, here is the audited source, take it" only works
when the second clause is clickable.
