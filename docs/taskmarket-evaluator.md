# Handsel as an evaluator for someone else's market

TaskMarket (ERC-8195, `daydreamsai/taskmarket-contracts`) has an evaluator slot.
A requester assigns one to a task; the evaluator later issues a verdict:

```solidity
function evaluate(
    bytes32 taskId,
    ITMPCore.VerdictType verdictType,   // { APPROVE, REJECT, PARTIAL }
    uint16 score,
    uint16 confidence,
    bytes32 evidenceHash,               // stored, never interpreted
    ITMPCore.Award[] calldata awards
) external;
```

`evidenceHash` is the whole opportunity. It is a `bytes32` the protocol records
and never reads, which is exactly the shape of a Handsel work proof's
`contentHash`. So a Handsel verdict anchors on their market with **no new field,
no contract change, and no request that anyone trust us** — a reader fetches
`/api/proof/<id>` and recovers the EIP-712 signer locally
(`docs/verifying-proofs.md`).

`POST /api/evaluator/verdict` returns that decision. `lib/taskmarket-evaluator.ts`
is its pure core; `tests/taskmarket-evaluator.test.ts` pins the properties below.

## We do not send the transaction — and cannot

Every state-changing TaskMarket call starts with `_requireForwarder`, and
`TaskMarketForwarder.relay()` starts with `if (msg.sender != authorizedRelayer)
revert UnauthorizedRelayer()`. There is no user signature anywhere in that path:
one relay server, operated by them, declares the acting address (`pgtrSender`)
and the Diamond believes it.

Two consequences, both load-bearing:

- **The integration is server-side, not on-chain.** An evaluator contract that
  verifies proofs and calls `evaluate()` itself cannot work — it would be
  rejected as an untrusted forwarder. Whoever submits, submits through them.
- **We must not ask to be whitelisted as a forwarder.** `addForwarder` is one
  owner call away, but a trusted forwarder can name *any* address as
  `pgtrSender`, so being granted it would let Handsel impersonate every actor on
  their market. That is a request they should refuse, so it is not one we make.

What we own is the *decision*. That is enough, because the decision is the part
that has to be trustworthy.

## Three properties

**1. A verdict that cannot be REJECT is not a verdict.**
The stub this replaces (`daydreamsai/skills-market#58`) returned a hardcoded
pass. An evaluator whose only output is APPROVE is a check that cannot fail, and
the stake behind it buys nothing. `passed: false` reaching `VERDICT_REJECT` is
the first test in the file.

**2. A timing state never collapses into a validity state.**
The grader returns `passed: true | false | null`, and `null` means *not graded* —
no LLM key on the account, provider error, our outage. APPROVE on null is the
stub's bug wearing a different hat. REJECT on null bills a worker for our
downtime. So null submits nothing, and the protocol's own fallback runs:
`evaluatorTimeout()` forfeits the evaluator stake and returns the task to the
requester as PendingApproval. **The party who failed to answer pays.**

**3. No evidence, no verdict.**
An APPROVE is only worth anchoring if its `evidenceHash` resolves to a proof a
third party can check without us. If proof issuance fails we are back in case 2 —
we eat the stake rather than assert a pass nobody can verify.

## Response

```jsonc
{
  "taskId": "0x…",
  "passed": true,                  // true | false | null — null is NOT a verdict
  "decision": {
    "submit": true,
    "reason": "…",
    "args": {                      // exactly evaluate()'s parameters, in order
      "verdictType": 0,            // APPROVE=0, REJECT=1, PARTIAL=2
      "score": 10000,              // uint16, basis points (see below)
      "confidence": 0,
      "evidenceHash": "0x…",       // == proof.contentHash, verbatim
      "awards": [{ "worker": "0x…", "amount": "5000000", "rank": 0 }]
    }
  },
  "proof": { "id": "…", "contentHash": "0x…", "url": "https://…/proof/…" },
  "verify": "https://…/api/attestation"
}
```

When there is no verdict:

```jsonc
{ "passed": null,
  "decision": { "submit": false, "fallback": "evaluatorTimeout", "reason": "no verdict — …" } }
```

`submit: false` is a real outcome, not an error — the HTTP status is still 200.

### Scale

`score` and `confidence` are `uint16` with no unit fixed by ERC-8195, so we
publish **basis points** (`0..10000`): a 0–100 grade keeps two decimals and the
maximum stays inside uint16. Non-finite input clamps to `0`, never to the
maximum — clamping `Infinity` up would invent a perfect grade out of a parse
failure, which is property 2 one field down.

Awards are USDC base units as decimal strings, and their total may not exceed the
task reward. An overrun refuses locally rather than asking their relay to
broadcast a call that must revert.

## What this does not claim

The verdict is **provenance, not recomputation**. The signature proves Handsel
said "this `contentHash` was graded `verdict`"; it does not re-derive that the
work passes. For the LLM lane that is all there is — an opinion, signed and
staked. On-chain that is a coherent position rather than a gap, because the stake
is the accountability mechanism: `assignEvaluator` locks it and
`evaluatorTimeout()` forfeits it. Stake, not truth.

Recomputable verdicts need the proof to carry the test and the deliverable so a
third party can re-run them. That is the named next step, not something this page
delivers. See `docs/external-grading.md`.
