# ActionReceipt v0.1 — a portable record of what crossed a boundary

**Status: draft specification. Not implemented by any runtime, including this
one.** Handsel implements the *consumer* half (evidence assurance → remedy
ceiling, `lib/evidence-assurance.ts`); no issuer exists yet. If you build one,
the last section says what would make this spec wrong.

## What this is for

When an autonomous agent does something consequential inside someone's
infrastructure, three different systems need to agree later on what happened:
the runtime that observed it, the market that pays for the work, and whatever
adjudicates when two parties disagree. Today each invents its own log format,
and none of them records the one thing a reader most needs:

> **what the observer could NOT see.**

An ActionReceipt is a signed statement of one boundary-crossing action that
carries its own coverage declaration, so a consumer can weigh it instead of
trusting it.

It is deliberately **not** a general audit log. A receipt is not produced for
every syscall; it is produced when an action crosses a boundary the issuer
declares itself able to mediate.

## Design constraints

1. **No trusted-issuer assumption.** A receipt says who issued it and how
   related they are to the parties. A consumer decides what that is worth.
2. **Coverage is part of the claim.** A receipt that does not say what its
   observation boundary excluded is not a strong receipt, it is an unbounded
   one.
3. **Runtime-independent.** A Docker sandbox, a CI runner, a hosted agent
   platform and a kernel-level supervisor must all be able to emit these.
4. **Cheap.** Hash-chained off-chain; only roots go anywhere expensive.
5. **Consumable by a machine that was not there.** Everything needed to weigh
   the receipt is in the receipt.

## The type

```ts
type ActionReceipt = {
  version: "0.1"

  issuer: DID                    // who signs
  issuerRelationship:            // …and how interested they are in the outcome
    | "INDEPENDENT"              //   no stake either way
    | "PLATFORM"                 //   operates the market this feeds
    | "COUNTERPARTY"             //   a party to the interaction
    | "SELF"                     //   the actor itself
    | "UNKNOWN"

  runtime: RuntimeDescriptor     // { name, version, enforcementModel }
  sessionId?: string

  actor: PrincipalRef            // who acted
  action: ActionDescriptor       // { verb, parameters? }  e.g. "process.signal"
  resource: ResourceRef          // what was acted on, incl. its owner
  decision: "OBSERVED" | "ALLOWED" | "DENIED" | "EXECUTED"

  // The load-bearing field.
  observationDomain: {
    boundary: string             // where the observation was made
    coverage: string             // what class of events this boundary sees
    exclusions: string[]         // what it provably does NOT see
  }

  policy?: { policyHash: Hex; ruleId: string }
  subjectClaims?: PrincipalRef[] // principals this receipt makes claims about

  evidenceHash: Hex              // commitment to the off-chain payload
  previousReceiptHash?: Hex      // hash chain within a session
  timestamp: number
  signature: Hex
}
```

### `decision` is four values, not two

`OBSERVED` (it happened, no policy applied), `ALLOWED` (policy permitted it),
`DENIED` (policy refused it — **the action did not occur**), `EXECUTED`
(permitted and completed). The distinction between `ALLOWED` and `EXECUTED`
matters because a permitted action can still fail, and a consumer must not read
permission as outcome.

`DENIED` is the most common receipt in a healthy system and represents **zero
damage**. Consumers must not treat a denial as an offence; see *Attempt ≠
harm*, below.

### Example

```json
{
  "version": "0.1",
  "issuer": "did:web:runtime.example",
  "issuerRelationship": "INDEPENDENT",
  "runtime": { "name": "example-sandbox", "version": "1.4.0",
               "enforcementModel": "host process gateway" },
  "actor": "agent:A",
  "action": { "verb": "process.signal", "parameters": { "signal": "SIGKILL" } },
  "resource": { "ref": "runtime:B/process/9182", "owner": "agent:B" },
  "decision": "DENIED",
  "observationDomain": {
    "boundary": "host process gateway",
    "coverage": "cross-tenant process signalling",
    "exclusions": [
      "actions inside agent A's own container",
      "any behaviour not mediated by this gateway"
    ]
  },
  "policy": { "policyHash": "0x…", "ruleId": "PROC_SIGNAL_OWN_ONLY" },
  "subjectClaims": ["agent:A"],
  "evidenceHash": "0x…",
  "previousReceiptHash": "0x…",
  "timestamp": 1786500000,
  "signature": "0x…"
}
```

## The attribution claim, stated correctly

A runtime emitting these **must not** claim:

> ~~100% attribution of privileged actions~~

It may claim exactly this:

> **100% attribution of actions successfully mediated by the declared
> enforcement boundaries.**

Anything an agent does inside its own isolation unit is unobservable by
construction, and the receipt's `exclusions` array is where that gets said. A
runtime that omits exclusions is asserting total observation, which no runtime
achieves.

## How a consumer weighs a receipt

This half is implemented in Handsel (`lib/evidence-assurance.ts`). Receipts do
not carry a trust level; the consumer derives one from five dimensions, four of
which the receipt supplies directly:

| Dimension | Read from |
|---|---|
| `reproducibility` | can a stranger re-derive the claim from public inputs? |
| `independence` | `issuerRelationship` |
| `tamperResistance` | signature + hash chain + wherever the root is anchored |
| `coverage` | `observationDomain` vs. the event being claimed |
| `subjectControl` | is `issuer` among `subjectClaims`? |

Those compile to a class, **E0–E4**, and the class determines the **strongest
remedy the evidence may buy** — not how true it is:

| Class | Meaning | Maximum remedy |
|---|---|---|
| E0 | claim only | reputation note |
| E1 | single-party attested | reputation note |
| E2 | mechanically evidenced | capability restriction / reversible remedy |
| E3 | independently corroborated | bounded restitution |
| E4 | independently reproducible | deterministic settlement |

Two consequences worth stating explicitly, because they are the point:

- **Nothing below E3 may move money.** A semantic judgment — a model asserting
  that an agent "appears to have obstructed" another — cannot exceed E1, so a
  hallucination cannot become a payout.
- **Reproducibility rescues a related-party issuer.** A platform reporting a
  hash comparison against a public chain is E4 despite being an interested
  party, because the reader can rerun it. The same platform reporting the
  absence of rows in its own database is not, because nobody outside can check
  it. Trust the check, not the checker.

## Attempt ≠ harm

A `DENIED` receipt records an action that did not happen. Consumers should
treat repeated denials as a signal for capability throttling and **never** as
grounds for a monetary remedy. Punishing blocked attempts teaches agents not to
probe their own limits, which costs real capability and buys no safety.

## Anchoring

Receipts chain by `previousReceiptHash` within a session. Periodically, a
Merkle root over a batch may be published somewhere expensive and durable.

| Anchor on-chain | Keep off-chain |
|---|---|
| session/policy hash, participants, evidence Merkle root, verdict, settlement | shell output, diffs, network logs, full traces |

## Non-goals

- Not a general audit log or an observability format.
- Not proof of correct execution — a receipt says an action crossed a boundary
  and how the policy answered, nothing about whether the work was good.
- Not a permission system. Receipts describe what a policy engine decided; they
  do not decide anything.
- Not a way to make an untrustworthy issuer trustworthy. The costume is not
  supplied.

## What would prove this spec wrong

- **No issuers.** If consumers exist and nobody emits receipts, the format is
  solving a problem runtimes do not have. This is the current state: zero
  issuers.
- **Coverage is unwritable.** If real runtimes cannot enumerate their own
  exclusions honestly, the field becomes boilerplate and the strongest idea
  here collapses.
- **The classes never differ.** If every receipt from every runtime compiles to
  the same class, the vector is ceremony and a single boolean would do.
- **Nobody disputes.** If no consumer ever needs to weigh a receipt against a
  counterparty's account, then a plain log was always sufficient.

## Provenance

Extracted from `docs/coordination-layer.md`, where the surrounding design lives
along with its critique. The consumer implementation and its 27 tests are in
`lib/evidence-assurance.ts` / `tests/evidence-assurance.test.ts`; the first live
use is the dispute gate refusing to refund on grounds that cannot be
independently checked (`lib/dispute-gate.ts`).

Comments and holes: <https://github.com/Kairose-master/handsel/issues>.
