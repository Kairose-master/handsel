# Verifying a Handsel work proof — without trusting Handsel

A Handsel proof is only worth something to another platform if that platform can
check it **on its own**, with no call to us to trust. This page is how. It is the
interop half of `docs/external-grading.md`: we do not run grading for you, we
hand you a proof you verify yourself.

## What a proof is

When a deliverable passes grading, the platform oracle signs an EIP-712 message —
the `WorkProof` — and stores it. `GET /api/proof/<id>` returns it as JSON:

```json
{
  "proof": {
    "schema": "handsel.work.v1",
    "jobRef": "job-42",
    "kind": "code",
    "contentHash": "0x…",     // keccak256 of the exact delivered bytes
    "worker": "…", "requester": "…",
    "verdict": "pass",
    "grader": "pytest",
    "gradedAt": 1800000000
  },
  "signature": "0x…",
  "attester": "0x…"
}
```

## Verify it in ~15 lines, no Handsel call at signing time

Fetch the recipe once (`GET /api/attestation`) — it publishes the EIP-712
`domain`, `types`, and the canonical `attester` address. Then everything is local
`viem`:

```ts
import { recoverTypedDataAddress } from 'viem'

// 1. The recipe — the domain, types, and the address a genuine proof must
//    recover to. Fetch once and cache; it changes only if the oracle key does.
const recipe = await (await fetch('https://handsel-main.vercel.app/api/attestation')).json()
if (!recipe.attester) throw new Error('this deployment cannot be verified (no oracle key)')

// 2. The proof you were handed (or GET /api/proof/<id>).
const { proof, signature } = handedToYou

// 3. Recover the signer locally. gradedAt is uint256 → bigint.
const recovered = await recoverTypedDataAddress({
  domain: recipe.eip712.domain,
  types: recipe.eip712.types,
  primaryType: 'WorkProof',
  message: { ...proof, gradedAt: BigInt(proof.gradedAt) },
  signature,
})

// 4. It is genuine iff it recovers to the published attester.
const genuine = recovered.toLowerCase() === recipe.attester.toLowerCase()
```

Tamper with any field — flip `verdict` from `pass` to `fail` — and step 3
recovers a *different* address, so step 4 fails. That is the entire security
model, and `tests/proof-verify.test.ts` pins it.

## Don't even trust the recipe endpoint

`/api/attestation` is served by us, so a fully paranoid verifier should not take
the `attester` address on our word either. The anchor that is **not** us: the
oracle signs ERC-8004 validations on-chain, so its address appears on-chain as
the validator. Pin the attester from that on-chain identity once, and from then
on you are verifying against a fact no Handsel endpoint can change.

## What this proves — and what it does not

Read this before you build anything on it, because the honest boundary is the
whole point.

- **It proves provenance.** The Handsel oracle signed "this `contentHash` was
  graded `verdict` by `grader` at `gradedAt`." It is non-repudiable: we cannot
  later deny we said it, and nobody can forge our signature.
- **It does not re-derive the verdict.** A valid signature does not prove the
  work *actually passes* the test — only that we said it did. For an LLM-lane
  verdict that is all there is (an opinion, signed). For a mechanical verdict
  (CI, test suite) the verdict *is* recomputable in principle — but only if the
  proof carries the test and the deliverable so you can re-run it yourself.
  Today the proof carries the deliverable's `contentHash`, not its contents, so
  independent **re-derivation** is the named next step, not something this page
  delivers. See `docs/external-grading.md`.

So: provenance now, recomputation next. Stated plainly so nobody ships a
"recomputable" claim this does not yet back.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/attestation` | the verification recipe: `schema`, `attester`, `eip712.{domain,types,primaryType}` |
| `GET /api/proof/<id>` | `{ proof, signature, attester, cid }` for one proof |
| `POST /api/proof/verify` | convenience: we recover it for you (`{valid, recovered, trustedAttester}`) — trusts our compute, unlike the local flow above |
