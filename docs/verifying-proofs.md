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
- **The signature alone does not re-derive the verdict.** A valid signature
  does not prove the work *actually passes* — only that we said it did.

That gap is what **schema v2** (`handsel.work.v2`) closes, to the extent it is
honestly closable. A v2 proof signs one extra field:

```
evidenceHash = keccak256(canonicalJson({
  schema: "handsel.evidence.v1",
  spec,            // what the deliverable was judged against
  deliverable,     // { text } or { base64 } — hashes to the signed contentHash
  grader,
  graderClass      // "reproducible" | "mechanical" | "model"
}))
```

`GET /api/proof/<id>` serves the bundle alongside the proof (`evidence` field;
null on v1 proofs). A third party checks three things, all local: the
signature recovers to the attester (the proof's own `schema` field — which is
*inside* the signature — selects the v1 or v2 types from `/api/attestation`);
the bundle's canonical-JSON keccak256 equals the signed `evidenceHash`; and
`contentHash(bundle.deliverable)` equals the signed `contentHash`. Canonical
JSON = object keys sorted recursively, no whitespace, UTF-8.

What "re-derive" then means depends on the grader class — and the class is
**inside the hash**, so an opinion cannot be quietly relabelled as a
computation after the fact:

- `reproducible` / `mechanical` — re-run the spec against the deliverable and
  you get the same verdict (pin toolchain versions for `mechanical`).
- `model` — re-judging with your own model yields an independent **opinion**.
  The evidence lets you re-derive the *inputs* of the judgment, not the
  judgment itself. This is the class the external lanes issue today
  (`/api/grade` with `publicEvidence: true` — opt-in, because it makes the
  submitted text public; `/api/evaluator/verdict` always, because an evaluator
  verdict exists to be checked).

So: provenance for every proof; recomputation where the grader class supports
it, with the class itself signed. Market-flow jobs stay v1 deliberately —
their deliverables were not submitted with publication in mind.
`tests/proof-evidence.test.ts` pins all of this, including that every
already-issued v1 proof verifies exactly as before.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/attestation` | the verification recipe: `schemas` (per-version domain/types), `attester`, `evidence` (canonicalization + grader classes) |
| `GET /api/proof/<id>` | `{ proof, signature, attester, cid, evidence }` for one proof |
| `POST /api/proof/verify` | convenience: we recover it for you (`{valid, recovered, trustedAttester}`) — trusts our compute, unlike the local flow above |
