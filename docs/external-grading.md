# External grading — what we expose, what we refuse, and why

A design decision, written down because the honest boundary is the product. It
answers one question a partner (daydreams/#57, #58) will ask: *"can I send you
arbitrary code and get a recomputable verdict?"* The answer is **no, not the way
it sounds**, and the reason is a security fact about our own runtime that we'd
rather state than paper over.

## The goal

Handsel's one differentiated claim is the *recomputable* verdict: CI, a test
suite, a canary — a check a third party can re-run and get the same answer. TMP's
own spec leaves this slot open (`erc-8195.md` §4: automated evaluation is
"optional", their evaluator is a trusted off-chain opinion). So exposing
recomputable grading externally is the natural offer.

## The security fact that decides the shape

The mechanical grader runs code in a subprocess on the platform runtime
(`agent-runtime/runtime/tools.py`, `server.py`). Its isolation is real but
bounded, and the code says so itself:

> `-I` isolated mode, a scrubbed environment (the child can't read
> `ANTHROPIC_API_KEY` / `RUNTIME_SHARED_SECRET`), a temp cwd, a 10s wall-clock +
> CPU limit, a 512 MB memory cap. **"It is NOT a security boundary against a
> determined attacker with network access."**

There is no network-egress denial, and no namespace/seccomp/container jail. Today
that is acceptable because the only code that reaches it is a **bonded worker's
submission** graded against a **requester-authored test** — both known, staked
parties in the market flow.

An external, token-gated "grade my arbitrary code" endpoint is a different threat
entirely: any token holder running arbitrary code with open network egress on our
infrastructure. That is SSRF (cloud metadata/IMDS, internal services), exfil to
an attacker host, crypto-mining, and DDoS amplification — bounded to 10s/run and
a per-user rate limit, but those cap the *blast radius per call*, not the fact
that the call is a determined attacker with network access, which is exactly the
condition the runtime documents itself as not defending against.

**Decision: we do not expose arbitrary-code mechanical grading as an external
service on the current runtime.** Shipping it to satisfy a partner request would
be building precisely the vulnerability the runtime already warns about.

## The reframe that keeps the value

Recomputability does not require us to be a code-execution service. It is a
property of the **proof**, delivered to the consumer:

- Handsel grades work produced through **its own market flow** (bonded worker,
  requester test) — the trusted path the sandbox was scoped for — and issues a
  signed, content-addressed proof at `/proof/<id>`.
- For the mechanical lane, that proof carries (or content-addresses) the
  **testCode and the deliverable**, so **anyone can re-run the check in their own
  sandbox** and confirm the verdict matches the signature.
- Our execution stays at **once per issued proof, on trusted-flow inputs**.
  Everyone else's verification runs on *their* infra, not ours.

So a partner does not commission arbitrary grading from us. They **consume
recomputable proofs** we already issued, and verify them independently. That is a
cleaner product boundary and a stronger one: the recomputation is the consumer's,
so they never have to trust that we ran it honestly — they re-run it.

## What this means for the daydreams integration

| Lane | External offer | Status |
|---|---|---|
| **model** (LLM review, `/api/grade`) | An independent *opinion* — grader ≠ solver, billed to the caller's key. Not recomputable. | Live. `ExternalEvaluatorBridge` calls it, labelled `lane: 'model'`. |
| **recomputable** (CI / test / canary) | A self-contained proof the consumer re-runs. Not a "run my code" service. | Proofs exist for market-flow jobs; a *public verifier* (re-run + signature check, no Handsel infra) is the next honest build. |
| **arbitrary external code execution** | — | **Refused** on the current runtime. See above. |

## The gate, if we ever do offer external execution

Not planned, recorded so the bar is explicit and nobody quietly lowers it under
deadline:

1. **Network egress denied** in the sandbox (nsjail / gVisor / no-egress
   container). This is the load-bearing one — everything else is secondary to it.
2. Real process/filesystem isolation (namespaces + seccomp), not just rlimits.
3. Per-user **compute quota and cost cap**, not only a request-rate limit — code
   execution is a cost surface, and a rate limit bounds calls, not spend.
4. The recomputable-proof design above shipped first, so external execution is
   *once per proof*, never an open interpreter.

Until #1 exists, the answer stays no, and the LLM-lane bridge plus consumable
proofs is the whole of what we offer.

## Invariant

*A grader runs code, and a boundary that is "not a security boundary" by its own
comment cannot become an external one because a partner asked nicely. The proof
is the product; the execution is ours to keep small.*
