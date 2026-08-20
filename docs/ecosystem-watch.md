# Ecosystem watch — the five specs Handsel's claims depend on

Handsel's defensible position is narrow (`docs/product-thesis.md`), and it is
narrow *relative to what other people have already published*. Two of those
publications were found by outsiders rather than by us: ERC-8183 (we reviewed
it, `docs/interop-outreach.md` thread 9) and **RAILS, which turned out to state
our central rule two months before we built it**. The second one is why this
file exists.

The failure mode is specific and we have already had it once: **shipping a
novelty claim that a published spec had already made.** That is the same defect
class as §27 and §28 — a claim we did not check — and the cost is credibility
rather than money, which makes it easier to miss.

## What is watched, and why each one

| Target | Overlaps us at |
|---|---|
| **RAILS** (arXiv 2606.08790) | The admissibility floor itself. A v2 could extend into collateral enforceability, which is the only ground we currently claim |
| **ERC-8004** — Trustless Agents | Identity / reputation / validation registries. If it standardises how validation results are *scored*, our evidence class becomes either an implementation of it or a competitor to it |
| **ERC-8183** — Agentic Commerce | Job escrow with evaluator attestation. This is our labor market's shape, as a standard. Status Draft → Review → Final changes what "we are compatible" means |
| **A2A spec** | Transport. Our position is that A2A carries the message and we decide whether the work was done; a payment/verification primitive landing *inside* A2A would move that boundary |
| **a2a-x402** | The payment extension. Same reason |
| **x402 specs** | The rail. If settlement conditions become expressible in x402 itself, the clearing layer shrinks |

Not watched, deliberately: Virtuals ACP and Olas have no public spec file that
changes atomically, so there is nothing to hash. They are read manually when a
thread in `interop-outreach.md` touches them.

## How it works

```bash
bash scripts/ecosystem-watch.sh            # six hashes
bash scripts/ecosystem-watch.sh --status   # plus the ERC status: lines
```

Each target is fetched and hashed. **The script does not summarise anything.**
A daily fetch that produces a summary produces prose that drifts away from the
spec it describes, and then the summary is what gets read. A hash that matches
means nothing moved and there is nothing to read; only a mismatch earns a diff.

`api.github.com` is gated for repositories outside this session's scope, so this
uses `raw.githubusercontent.com`, which is not. The arXiv page carries a
session-varying nonce, so only its version markers are hashed.

## Baseline — 2026-08-19

```
erc-8004     60abdf88a9defb16     status: Draft    created: 2025-08-13
erc-8183     733768f84b9fd273     status: Draft    created: 2026-02-25
a2a-spec     99a410e19c58021d
a2a-x402     ac60fe1d2f51308c
x402-specs   63168a431df56fbb
rails-abs    447b4f0bfd4ea5ce
```

**Update this block whenever a change is triaged**, or the next check compares
against a baseline that is already known-stale and reports the same diff
forever.

## What counts as reportable

Report only when the change touches a claim we make. Everything else is a hash
update and silence.

1. **RAILS gains a version** — read whether it now covers collateral
   enforceability, slashing, secured priority, or credit. If it does, our
   remaining ground shrinks and the docs citing it must say so the same day.
2. **ERC-8004 or ERC-8183 changes `status:`** — Draft → Review → Last Call →
   Final. Final means "compatible with the standard" becomes a checkable claim
   rather than a friendly one.
3. **Either ERC changes its interface** — a new registry method, a changed
   attestation shape. Affects whether our proofs can be exported into it.
4. **A2A or x402 absorbs a verification or conditional-settlement primitive** —
   this is the one that would hurt. Our whole architectural bet is *A2A carries,
   x402 pays, Handsel decides*. A conditional-release primitive inside x402
   makes the third role thinner.

Anything else — typos, examples, test vectors, new client libraries — is not
reportable. The point of a watch that stays quiet is that its noise means
something.
