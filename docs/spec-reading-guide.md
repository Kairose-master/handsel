# Reading ERC-4337 and ERC-8004 against this codebase

A study guide, not a summary. Read the spec; use this to find where each concept
is already running in code you own, and what it cost to learn the hard way.

**Read 4337 first.** 8004 is a Draft and still moving. 4337 is what real money
is already sitting on, and two of this repo's defect classes came from not
having read it closely enough.

How to use it: take one row, read that part of the spec, then open the file and
find the thing. The question column is what to hold in your head while reading —
a spec read with a question sticks; a spec read cover-to-cover does not.

---

## Part 1 — ERC-4337 (Account Abstraction)

### The shape

An agent here is not a private key. It is a **Kernel v3.1 smart contract
account** at EntryPoint v0.7, derived deterministically from one owner key plus
a per-agent index. Every agent's address is a contract.

| Concept | Where it lives | Hold this question |
|---|---|---|
| Account derivation | `accountIndex()`, `getAgentAccountAddress()` in `lib/onchain/account.ts` | One key, N accounts — where does the index enter, and why can the address be computed without a bundler? |
| Building the account + client | `getAgentKernel()` | What is `signerToEcdsaValidator` doing, and what is the `sudo` plugin? |
| Sending a call | `sendAgentCall()` / `sendAgentCalls()` | Where does a plain `{to, data}` become a UserOperation? |
| EntryPoint | `const entryPoint = getEntryPoint('0.7')` | Why is there a singleton contract in the middle at all? |

### The three roles that arrived behind one URL

This is the single most useful thing to understand, because getting it wrong
cost real debugging time.

**Bundler ≠ Paymaster ≠ Node.** They are separate services. `ZERODEV_RPC` was
all of them at once, so when sponsorship broke it looked like a choice between
keeping account abstraction and keeping sponsored gas. They are not coupled.

Read: `lib/onchain/paymaster.ts` — the whole file, header comment included.

```
resolvePaymaster():
  PAYMASTER_DISABLED  → none      (operator says no sponsorship; a stale URL must not override)
  PAYMASTER_RPC       → erc7677   (explicit configuration is a deliberate act)
  ZERODEV_RPC         → zerodev   (where sponsorship lived before this file existed)
```

Spec side: paymaster communication is **ERC-7677**
(`pm_getPaymasterStubData` / `pm_getPaymasterData`), and viem ships a generic
client for it. A Kernel account does not care who signs the sponsorship.

On mainnet this deployment runs `PAYMASTER_DISABLED=true` — every Kernel account
pays its own gas from a small ETH float. Read `getAgentKernel`'s comment on what
self-pay actually means for who holds the ETH.

### Why "unconfirmed" had to become a first-class state

**This is the payoff.** `docs/failure-modes.md` opens with one confusion behind
four separate defects:

> "no response" was treated as "failed"

That is not a bug in our code so much as a property of 4337 that our code had
not internalised. A UserOperation is handed to a **bundler**, which accepts it
into a mempool and includes it later. A receipt that does not arrive is not a
revert — the operation is usually seconds from landing.

Read the spec on the UserOperation lifecycle, then read:

- `UserOpPendingError` and `isUserOpPending()` in `lib/onchain/account.ts` — the
  named third state, and the comment explaining why callers must not write
  terminal state on it
- Every `catch` in `lib/callback/labor-market.ts` and
  `app/api/jobs/external/route.ts` that checks `isUserOpPending` first

Question to hold: *which of these outcomes is "reverted", and which is "not yet"?*
If the spec had been read this way first, four defects would have had a name
before they had a symptom.

### Nonces, and why sends are serialised

A smart account has **one nonce**. Two concurrent operations from the same
account collide (`AA25`). Read `serializedSend()` and the `sendUserOperation`
wrapper in `getAgentKernel` — sends per address are chained so the bundler hands
out sequential nonces.

Question: *is the nonce a property of the signer or of the account?* (It is the
account. That is why self-pay vs. sponsored does not change this.)

### The part that produced a real bug — ERC-1271

A contract **cannot** produce a signature that `ecrecover`s to its own address.
It validates one, via **ERC-1271** `isValidSignature(bytes32,bytes) → 0x1626ba7e`
(Final).

Every first-class actor here is a contract account. Verifying a signature with
`recoverMessageAddress` alone therefore excludes the most likely signer there is.
That was live in `lib/redteam-grade.ts` this morning: an owner registering their
own agent as the attester would have had every signal rejected forever, with a
message blaming them for a forgery that was our bug.

Read: `resolveSigner()` in `lib/redteam-grade.ts` — ECDSA first because it is
free and offline, then ERC-1271 against the **sealed** attester, bounded and
skipped when no RPC is configured.

Then look at the places that still recover only: `verifyWorkProof` in
`lib/attestation.ts` and `lib/reputation-lending.ts`. Both currently expect an
**EOA oracle**, which is correct today — but that is an assumption worth knowing
you are making rather than one you inherited.

---

## Part 2 — ERC-8004 (Trustless Agents)

Three registries. We publish into all three, best-effort: a registry failure
never blocks the underlying action, and the DB ledger stays authoritative.

Read the whole of `lib/onchain/erc8004.ts` — it is 179 lines and it is one file
per registry function.

| Registry | What it stores | Our call | The interesting part |
|---|---|---|---|
| **Identity** | agent identity as **ERC-721** | `registerAgentErc8004()` | The agent registers *itself* — its own account signs, so registry owner == agent address |
| **Validation** | `response` uint8 **0–100** + `tag` string | `publishValidation()` | The number cannot express *how* the verdict was reached |
| **Reputation** | `giveFeedback` value + two tags | `publishCreditFeedback()` | The registry rejects feedback from the agent's owner — grader ≠ solver, enforced on-chain |

### The three things worth arguing with

**1. Identity is a transferable ERC-721.** Reputation accrues to the token id.
So a track record can be *bought* rather than forged. The spec resets
`agentWallet` on transfer, but the score does not reset — a new owner re-attaches
a wallet and inherits the history.

ERC-5192 (soulbound, Final) looks like the fix and is not: `locked()` is a
point-in-time boolean and can be unlocked, so it collapses "was never
transferable while the reputation was earned" into "is not transferable right
now". That is the same collapse this repo already has a name for — *a timing
state must never collapse into a validity state.* The working answer needs no
new standard: ERC-721 emits `Transfer`, so continuity is reconstructible from
logs.

**2. Validation stores one number.** The spec says outright that a
mechanically-proven result and a subjective judgement are "structurally
equivalent on-chain — distinction emerges through validator reputation, not
protocol-level flags". Empirically that fallback is 73–90% Sybil
([arXiv 2606.26028](https://arxiv.org/pdf/2606.26028)).

Our answer rides in the `tag` the registry already has: see `lib/grader-class.ts`
and the `gradeTag()` call in `lib/callback/labor-market.ts`.

**3. `getSummary()` folds flat.** Any consumer averaging these numbers inherits
its weakest input. `trustWeightedScore()` in `lib/grader-class.ts` is the
reference fold that does not.

---

## Part 3 — read the reference implementations too

EIP prose assumes context the reader often does not have. For 4337 the
EntryPoint contract is faster to understand than the spec text, and the ZeroDev
SDK's Kernel account is where `validateUserOp` becomes concrete.

You have something most readers do not: **a live system implementing both.** For
every concept, the exercise is the same — find it in the spec, find it in the
file, and check whether what the code does is what the spec says. That is
exactly how the ERC-1271 gap surfaced.

---

## Suggested order

1. 4337: UserOperation lifecycle → `sendAgentCalls`, `UserOpPendingError`
2. 4337: bundler/paymaster/EntryPoint separation → `lib/onchain/paymaster.ts`
3. ERC-1271 → `resolveSigner()`, then audit the remaining `recover*` callsites
4. 4337: account derivation + nonce → `getAgentKernel`, `serializedSend`
5. 8004: the three registries → `lib/onchain/erc8004.ts`
6. 8004: Validation's single number → `lib/grader-class.ts`
