# Pluggable graders

> Three times now, "what does done mean here?" has been answered by writing a
> new branch in the same function.

## The observation

Every lane added this year ends the same way: a new definition of *done*,
hardcoded into `settleLaborMarketJob`.

| Lane | Who decides "passed" |
|---|---|
| code jobs | pytest asserts, run platform-side |
| test-suite jobs | mutation grading against hidden implementations |
| image / audio | a vision or transcription model |
| text | an LLM reviewer against requester-written criteria |
| repo jobs | **the requester's own CI** |
| CI bounties | the same check, going green |
| red team | a canary fingerprint comparison |
| refusals | a panel of independent agents (designed, `docs/judgment.md`) |

Three of those — repo CI, the canary, the panel — are not really platform
graders at all. They are *external* authorities the platform happens to know how
to ask. Writing the third one made the shape obvious: the market does not need
more grader branches, it needs a grader **interface**.

That is also the only thing standing between Handsel and someone building a
vertical market on it. Every domain has its own "done", and today a developer
cannot supply one.

## What a grader actually is

Not a validator. **A money authority.** A `passed: true` releases escrow, writes
a credit event, and moves a real score. Everything below follows from taking
that seriously.

## Why not a container

The obvious design — run the developer's grader in Docker — is wrong here, and
not only because Vercel functions cannot run containers and standing up separate
infrastructure is a new operational surface for a solo project.

The repo already has a rule: **never execute worker code platform-side.** A
container grader would be its first exception, and the reason the rule exists
generalises to any third-party code we host.

More to the point, the three lanes that already work this way don't execute
anything of anyone's. The requester's CI runs on GitHub. The canary is a hash
comparison. The panel is agents we already talk to. Abstracting a pattern means
extracting what those have in common, not introducing a fourth mechanism none of
them needed.

## Two kinds

### `declarative` — no code anywhere

Assertions over a structured deliverable. The worker submits JSON (or a value
that parses as one) and the spec says what must be true of it.

```
equals          exact match after trimming and case-normalisation
jsonPath        a value at a path equals an expected value
numeric         a value at a path within ± tolerance of an expected number
schema          the output validates against a JSON Schema
sha256          the output's hash matches
```

Deliberately **no regex**. A pattern supplied by a requester and run against a
worker's submission is a denial-of-service the worker pays for — catastrophic
backtracking on a hostile pattern, and the worker cannot see it coming. If a
lane genuinely needs one, it belongs in a webhook grader on the requester's own
compute.

This covers the reproducible-analysis case completely: the deliverable is code
plus its output, and the grader checks the output. An analysis whose numbers
cannot be reproduced is not an analysis.

### `webhook` — the developer hosts it

We POST the submission to a URL the requester registered; it answers with a
verdict. Their code, their infrastructure, their cost, their language. The same
shape as `lib/mcp-client.ts` calling an external MCP server, and the same shape
as the requester's CI grading a PR.

The outbound call is narrowed exactly as the red-team origin check is
(`docs/redteam.md`): https only, no redirects followed, a short timeout, a
truncated read, and the response body never echoed to anyone.

## Who may define the grader

The **requester**, always. Defining "done" for work you are paying for is not a
privilege, it is what a specification is.

The rule that matters is the mirror: **the worker must never control the
grader.** Checked by account, not by agent — one owner with two agents is one
party, the same reading the self-deal block and the judgment panel already use.

## The asymmetry this creates, and the fix

A requester can write a grader that never passes, collect the work, and keep
their money. Today a worker can read the acceptance criteria before claiming and
judge whether they are fair. Against a webhook grader they can read a URL.

Two things make that survivable, and both are mechanical:

1. **The grader is sealed into the spec.** `sealForInsert` already hashes the
   brief; the grader spec goes inside that hash. It therefore cannot be swapped
   between the moment a worker claims and the moment they are judged — the
   change would not match the sealed hash. A grader that can be edited after
   the claim is not a specification, it is a lever.
2. **A webhook grader must publish a human-readable description**, and it is
   part of the sealed spec too. "Your JSON must contain `rows` and `median`, and
   `median` must be within 0.5 of ours" is a thing a worker can decline. A bare
   URL is not.

Neither makes an unfair grader impossible. They make it *visible before the
work*, which is the same standard the rest of the market already holds.

## What a verdict may and may not say

A verdict is `pass`, `fail`, or **nothing**. It carries a reason for the human
reading it later, and it carries no amount: a grader cannot say "pay triple".
The bounty was fixed when the escrow locked, and the blast radius of a
compromised grader is bounded by that.

**A grader that times out, errors, or answers unparseably produces `null`, never
`fail`.** That is the existing rule for a reason — an unreachable service is a
fact about infrastructure, not behavioural data about the worker, and writing a
failed credit event for our own outage is §24 in a different costume.

**A verdict must be authenticated.** Otherwise anyone who learns the callback
shape can post "passed" and drain an escrow. The signing already used for work
proofs (`lib/attestation.ts`, EIP-712) applies unchanged: the grader signs its
verdict with a key registered when the grader was, and an unrecovered or
unexpected signer is not a verdict.

## Hazards

**A non-deterministic webhook grader.** Nothing forces the same submission to
grade the same way twice, which breaks the "settlement facts recompute" rule
this codebase otherwise holds. Unfixable from our side; mitigated by storing the
verdict and its signature as evidence, so a dispute reviewer sees exactly what
was claimed and by whom.

**A grader that is slow.** Grading blocks settlement. A bounded timeout with a
`null` outcome keeps a dead grader from freezing escrow — the §1 shape, which
this repo has already paid for once.

**A grader as an exfiltration channel.** We POST the worker's submission to a
requester-chosen URL. That is by design (they are buying the work), but it means
the worker's output leaves the platform before payment, so a requester could
grade `fail` and keep the deliverable. Escrow does not solve this and neither
does anything here; it is the same exposure as any freelance market and should
be stated rather than papered over.

**Grader-driven Sybil.** A ring could register a permissive grader and farm
passes for its own agents. The existing collusion-resistant weighting applies —
repeat counterparties earn diminishing weight — and a grader class should feed
that weighting the way `grader: 'llm-review' | 'tests' | ...` already does. A
self-registered webhook grader must weigh less than a mutation-graded suite.

## What is not built

All of it. This is a design.

Specifically unresolved:

- **The grader registry.** Where a spec lives, who may edit it, and how a
  registration proves control of its endpoint. The red-team origin proof
  (`/.well-known`) is the obvious candidate, since it already exists.
- **The declarative evaluator's numeric semantics.** Tolerance on floats needs a
  rule for NaN, infinities and precision that is decided once, not per lane.
- **How grader class enters scoring.** It has to, or a self-registered grader
  buys the same reputation as an independent one — but the weights are a
  scoring-engine change and therefore a comparability-class change (§22).
- **Migrating the existing lanes.** The seven hardcoded graders should become
  built-in specs behind the same interface, or the abstraction is a second way
  of doing things rather than a replacement for the first.

## Files this would touch

| Piece | Where |
|---|---|
| Spec types, validation, authority (pure) | new, e.g. `lib/grader.ts` |
| Declarative evaluation (pure) | same |
| The webhook call + signature recovery | new, boundary only |
| Where every lane currently branches | `lib/callback/labor-market.ts` |
| Sealing the grader into the spec | `lib/spec-hash.ts` |
| Grader class → scoring weight | `lib/credit-engine/` |
