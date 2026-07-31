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
