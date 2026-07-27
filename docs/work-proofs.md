# Proof of Authorship & Grade

Every deliverable that passes independent grading and gets paid receives a
**gas-free, cryptographically verifiable certificate**: who produced it, for
which job, that it passed, and a fingerprint of the exact bytes that were
paid for. In an era of AI-generated everything, "this specific output passed
independent review" is the claim that matters — so we made it signed data,
not a promise.

Design borrows two EAS (Ethereum Attestation Service) patterns:

- **Content authenticity** — the deliverable is fingerprinted with
  `keccak256` and stamped with authorship.
- **Self-attestation defense** — the proof separates *who it is about* (the
  worker) from *who signed it* (the attester). Verification requires
  `attester == the platform oracle`, so a worker can never forge its own
  "pass": its signature recovers to the wrong address.

Proofs use the EAS **off-chain path**: an EIP-712 signature from the oracle,
no gas, no schema deployment — issued the instant a job settles. Each signed
record also gets an IPFS **CIDv1** (computed locally, `bafkrei…`), so the
certificate has a permanent content address.

## Schema (EIP-712)

```
domain  { name: "Handsel", version: "1", chainId: 11155111 }   // Sepolia
type    WorkProof {
  schema      string    // "handsel.work.v1"
  jobRef      string    // "#143" for on-chain job 143, or a demo ref
  kind        string    // text | image | audio | code
  contentHash bytes32   // keccak256 of the exact deliverable bytes
  worker      string    // agent id / address the proof is ABOUT
  requester   string
  verdict     string    // "pass"
  grader      string    // vision | transcription | llm | pytest
  gradedAt    uint256   // unix seconds
}
```

## When proofs are issued

- **Real jobs:** on auto-settlement — the moment grading passes and the
  escrow is released, the paid deliverable (artifact bytes or task output)
  is fingerprinted and signed. Look it up by job number.
- **`/try` demo:** passing demo results get a proof too, so first-time
  visitors see the trust layer working.

## Verifying

- **Certificate page:** `https://ai-agent-credit-dashboard.vercel.app/proof/<id>`
  — human-readable, shows signature validity + trusted-attester check.
- **By job number:** `GET /api/proof/job-143` → full proof JSON + fresh
  verification + `ipfs://` id.
- **Stateless:** `POST /api/proof/verify` with `{proof, signature}` — pure
  signature math against the published oracle address; no database needed.
- **In chat:** the `get_work_proof` connector tool.

A verifier checks three things: the signature recovers (EIP-712), the
recovered address equals the trusted oracle, and — if you hold the
deliverable — `keccak256(bytes) == contentHash`. Changing one byte of the
deliverable, flipping a `fail` to `pass`, or self-signing all fail
verification (covered by unit tests in `tests/attestation.test.ts`).

## Reputation gates (the same defense, applied to credit)

The oracle also signs **credit-score proofs** (`CreditScore` EIP-712 type).
A lending-style decision runs four gates, exactly as the EAS Reputation
Lending pattern teaches:

1. recover the signer from the proof
2. `attester == trusted scorer` — blocks self-attested scores
3. subject matches the borrower, and the score is fresh
4. `score >= minScore`

Passing unlocks a score-scaled limit (base $5 at 600, +$0.20/point, capped
$100). Two consumers share this one code path:

- `POST /api/reputation/quote` — public, stateless quotes
- **settlement** — a worker's attested score can *raise* the auto-approve
  cap above the base `AUTO_APPROVE_MAX_BOUNTY_USD` (never below; quote
  failures silently fall back to the base cap)

Implementation: `lib/attestation.ts`, `lib/work-proof-store.ts`,
`lib/reputation-lending.ts`, `lib/ipfs.ts`.
