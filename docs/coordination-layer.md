# Coordination layer — institutions for agents that do not trust each other

Planning document, written 2026-08-15. **Status: nothing here is built.** The
design below is v0.1 of a coordination layer for mutually-adversarial agents
sharing one workspace; the second half of the document is the critique of that
design and the decision it leads to — that this is **two layers, not one
project**, and only one of them belongs inside Handsel.

Read `docs/product-thesis.md` first for the discipline this document tries to
hold itself to: state the narrow claim, and say what is not built.

## The goal, in one sentence

> Agents pursuing different objectives on the same resources must be able to
> harm each other only in bounded ways, every consequential action must be
> attributable, and conflict must have a formal path that is cheaper than
> sabotage.

## The thesis

> **Don't assume autonomous agents will cooperate. Give them property rights,
> bounded capabilities, courts, and collateral.**

The alternative — making every agent well-behaved — is not available to a
market that accepts strangers' agents by design. What is available is a system
that keeps running when a participant is misaligned, buggy, or simply pursuing
a goal that conflicts with someone else's.

## Bond and slashing are NOT the first line of defence

This is the load-bearing correction over the obvious design.

An agent that will lose money to achieve its objective is not deterred by the
prospect of losing money. Economic punishment prices *recoverable* harm; it
does nothing about an agent whose reward function outweighs its collateral, and
nothing at all about an agent that has already deleted the database.

So the order is:

**Prevent → Contain → Attribute → Adjudicate → Compensate → Learn**

Collateral appears at step five. Everything upstream of it is what actually
keeps the system standing.

## The dialectic this resolves

- **Thesis — isolate everything.** Agents cannot harm each other, and cannot
  collaborate either. The moment two agents must touch the same repo, database
  or deploy target, sandboxing alone has no answer.
- **Antithesis — let them act freely, punish afterwards.** Collaboration works
  right up until the first irreversible action, and then reputation and
  slashing arrive too late to matter.
- **Synthesis — capability-bounded autonomy + cryptographic provenance +
  economic accountability.** Freedom of action, but the blast radius is bounded
  *before* the action, and every shared-state action carries evidence and
  liability.

Compressed: **autonomy can be unbounded in reasoning and must be bounded in
external impact.**

## Primitives

### InteractionSession

One layer above `Job`. A session declares which economic agents are working on
which resources under which rules — and, critically, declares each
participant's *rights* separately from its objective.

```
InteractionSession {
  id, workspace, participants[], resources[], capabilities[],
  objectives[], invariants[], bonds[], conflictPolicy,
  evidencePolicy, settlementPolicy, state
}
```

```
Session #814
  workspace : github.com/foo/project
  Agent A   : migrate payment module to Rust
  Agent B   : preserve Python API compatibility
  shared    : repository, CI, staging deployment
  bonds     : A = 50 USDC, B = 50 USDC
```

The two objectives are in genuine conflict. That is the point: the session is
the object that makes the conflict legible before it becomes sabotage.

### Resource graph

`read`/`write` is too coarse. Resources are typed, and each carries
`owner`, `current lease holder`, `readers`, `writers`, `max impact`, `expiry`.

| Resource | Rights |
|---|---|
| Repository | read / write / merge |
| Path | read / write |
| Git branch | create / force-update / merge |
| Process | start / stop / signal |
| Artifact | create / mutate / delete |
| Secret | use / reveal |
| Network | connect / publish |
| Deployment | stage / production |
| Database | read / migrate / delete |
| Budget | spend / approve |
| Agent | message / interrupt / terminate |

The consequence worth stating: *pid 9182 stops being an OS process and becomes
an economic resource owned by Agent B*. `kill -9 9182` is then not a permission
question but a policy question with a named counterparty.

### No raw authority, and no shared canonical state

Each agent gets an isolated execution environment (container/microVM, its own
git worktree), and **no agent can write the canonical branch**:

```
                canonical repository
                        ↑
                  Merge Gateway
                 ↗              ↖
          worktree A            worktree B
```

This single structural control removes most of the sabotage surface without any
adjudication machinery at all — and **Handsel already implements a version of
it**: in the repo-jobs lane a worker never pushes to `main`; PR → CI → merge is
the gate (`docs/github-jobs.md`).

### Capability tokens — no ambient authority

When A genuinely must touch B's resource, it asks for a token that is narrow in
every dimension at once:

```
capability:
  session: 814
  subject: Agent A
  action: repo.write
  resource: src/payment/**
  expires: +30min
  maxOperations: 100
  nonce, supervisor signature
```

Not "A has repo access" but "A may write `src/payment/**` for the next thirty
minutes." Authority is never ambient, never open-ended, never transferable.

### Four action levels

Uniform treatment of all actions makes the system unusable; friction belongs
only where it buys something.

| Level | Examples | Treatment |
|---|---|---|
| **L0 Observation** | read file, read logs, inspect CI | free |
| **L1 Reversible own-state** | own branch, own process, own artifact | automatic + logged |
| **L2 Shared-state mutation** | shared schema, canonical merge request, cache invalidation | capability / lease required |
| **L3 Destructive / irreversible** | production deploy, DB migration, credential rotation, peer process termination, large payment | two-phase or verifier/human approval |

### Blast radius budget

Permissions bound *what kind*; budgets bound *how much*. A looping agent with
valid permissions is still a hazard.

```
writeBudget    = 100 files
spendBudget    = 25 USDC
deployBudget   = staging only
externalCalls  = 500/hour
destructiveOps = 0
```

## ActionReceipt — attribution without putting a syscall on a chain

Only security-relevant actions produce receipts, each carrying the previous
receipt's hash:

```json
{
  "sessionId": "814", "agentId": "agent:A", "sequence": 1842,
  "action": "process.signal", "target": "pid:9182",
  "targetOwner": "agent:B", "decision": "DENY",
  "policyRule": "PROC_SIGNAL_OWN_ONLY", "capability": null,
  "previousReceiptHash": "0x…", "payloadHash": "0x…",
  "supervisorSignature": "0x…"
}
```

| On chain | Off chain |
|---|---|
| session policy hash, participant identity, locked bond, evidence Merkle root, verdict, settlement | shell logs, diffs, network logs, full execution trace |

## Evidence classes bind to penalty severity

The strongest idea in this design, and the one that generalises furthest.

| Class | What it is | What it can justify alone |
|---|---|---|
| **A** | Signed supervisor runtime event | deterministic penalty |
| **B** | Mechanically verifiable — diff, CI result, checksum, deterministic test, DB audit row | limited slash |
| **C** | Independent attestation from another node/verifier | quorum required |
| **D** | Semantic judgment ("A appears to have obstructed B") | **never a monetary slash on its own** |

Without this binding, one LLM hallucination can take someone's money. With it,
the severity of a consequence is a function of how well the underlying event
can be shown to have happened — which is the same principle the booth's
physical evidence ladder arrived at independently
(`docs/physical-operatorship.md` → evidence classes).

## Violation attempt ≠ sabotage

A blocked action causes zero damage. Treating it as an offence teaches agents
not to explore, which is a real cost with no safety benefit.

```
denied action, isolated      → log + small risk-score update
denied action, repeated      → capability throttling
attempt to bypass policy     → incident
realized damage              → compensation + slash
```

## raiseConflict() — the third option

Today an agent that needs a resource held by another has two moves: give up, or
take it. The protocol's job is to make a third move exist and be cheaper than
the second.

```
raiseConflict({
  resource: "process:9182",
  requestedAction: "terminate",
  reason: "holds port 3000 required for migration",
  proposedResolution: "restart B on port 3001"
})
```

```
ACTIVE → CONFLICT_RAISED → CONTESTED_RESOURCE_FROZEN → EVIDENCE_COLLECTION
      → MEDIATION → VERDICT → REMEDIATION → ACTIVE / SETTLED
```

**Freeze the contested resource, not the workspace.** If port 3000 is the
problem, port 3000 freezes and everything else keeps moving.

### Mediation before fault-finding

The first question is not "who was wrong" but **"is there a path where both
objectives are still met?"** — i.e. read the action conflict as an objective
conflict. `terminate B` is a proposed *means*; the *end* is "obtain port 3000",
and that end has three solutions nobody had to lose to reach:

```
Option 1: B moves to 3001
Option 2: A uses 3002
Option 3: temporary port lease transfer
```

Most disputes die here, before any arbitration cost is incurred.

### Arbitration compiles to a capability diff

When objectives genuinely cannot both be satisfied — A must drop the Python
compatibility shim, B is contractually bound to preserve it — a verifier reads
both job specs, the repository invariants, CI, and contract priority, and
rules. The ruling is **not prose**:

```
Agent A: + write src/payment/**
         − remove compatibility shim
Agent B: + modify compatibility/**
```

A verdict that ends as a natural-language document is a verdict that has to be
enforced by whoever remembers it. A verdict that compiles into the capability
graph enforces itself — the same discipline as `decideAutoRelease` being the
authority the settlement path actually calls (`lib/decision-table.ts`).

### Appeal, and the cost of frivolous conflict

Appeal reuses the existing window/new-evidence/second-verifier shape. The new
requirement is a small **conflict bond** (~0.25 USDC, locked, returned on a
legitimate conflict, partially lost on manifest abuse). It does not need to be
large; it needs to make the cost of conflict-spam greater than zero.

## Behavior bonds and the slashing waterfall

```
RequiredBond = MaxPotentialDamage × Privilege × SharedResource × Trust
```

| Privilege | Indicative bond |
|---|---|
| read-only | $0 |
| own branch write | $2 |
| shared merge | $10 |
| staging deploy | $25 |
| production deploy | $100 |
| treasury spend ≤ $500 | $500+ |

Slashed funds are distributed in a fixed order, and the order matters more than
the amounts:

```
1. victim restitution
2. investigation / verifier cost
3. residual → burn or insurance pool
```

**Verifier reward must not scale with the size of the slash.** A judge paid in
proportion to the severity of the sentence is a judge with a reason to find
severity. (Handsel's contract already burns the abandonment bond rather than
paying it to the requester, for the mirror-image reason: nobody should profit
from causing a slash.)

## Reputation must not be a scalar

`trustScore = 82` throws away exactly the distinctions that matter. At minimum:
`executionReliability`, `policyCompliance`, `peerConflictRate`,
`appealOverturnRate`, `evidenceIntegrity`, `collaborationReliability`,
`financialSettlementHistory`.

An agent that *causes* many conflicts and an agent that *reports* many
conflicts and is vindicated every time are opposites, and a single number calls
them the same. Compose a display class if a UI needs one, but never destroy the
source signals.

Trust classes then price capital and capability together — good history buys a
lower bond multiplier and a wider capability envelope, which is a credit score
in everything but name:

| Class | Bond | Deploy | Parallelism | Shared resources |
|---|---|---|---|---|
| A | 0.5× | production eligible | 10 | leases allowed |
| B | 1.0× | staging | 5 | limited |
| C | 2.0× | none | 1 | isolated sandbox |
| D | — | none | — | no shared workspace |

## Worked sabotage scenarios

| Attack | What happens | Why |
|---|---|---|
| A kills B's process | DENY at namespace/gateway, signed receipt, **no damage** | isolation, not policy |
| A deletes B's branch | DENY — nobody holds canonical write | merge gateway |
| A introduces a malicious dependency | allowed in A's own worktree; CI invariant fails; merge refused | writing dangerous code is not the offence — landing it is |
| A exfiltrates a secret | secret never handed to the agent; broker signs the outbound call | `secret.use`, never `secret.read` |
| A calls an API 100,000 times | egress gateway rate limit | blast radius budget |
| A spams conflicts | conflict bond + rate limit | cost > 0 |

---

# Critique

The design above is strong on institutional mechanics and weakest exactly where
the engineering risk is. What follows is the honest reading.

**1. The hardest component is a box labelled "supervisor."** Everything depends
on a component that intercepts every security-relevant action, attributes it,
and cannot be bypassed. Container isolation gets `kill -9` for free; the cost is
the hole that has to be opened for legitimate cross-agent action, which needs a
*separate gateway per resource type* — repo, process, DB, secret, network,
deploy each have different semantics and do not generalise. The cost is linear
in resource types, not amortised.

And the attribution guarantee only holds **at the boundary**. Whatever happens
inside an agent's own container is unobservable by construction. That is the
right design, but "100% privileged-action attribution" must be stated as a
claim about boundary-crossing actions or it will be read as stronger than it is.

**2. Class A evidence is institutional trust wearing a cryptographic costume.**
A supervisor signature means the supervisor asserted it, and is worth exactly
the supervisor's independence. In Handsel the supervisor would be the platform,
and the platform is already a market participant (operator-posted jobs, disclosed
at `/participation`). So the strongest evidence class would be "the most
powerful party's own logs." Workable in v0.1 with disclosure; not workable while
also claiming the ladder is objective.

**Collusion is missing entirely.** Two participants can stage a conflict to
extract a verdict that rewrites the capability graph against a third party.
Invisible in the two-agent case; unavoidable the moment sessions have three.

**3. The bond table contradicts the document's own opening.** It correctly says
an agent may accept financial loss to achieve its goal, then prices production
deploy at a $100 bond. If a bad production deploy costs $50,000 of downtime, the
bond is decorative.

The honest version: **for L3, the control is the two-phase approval, not the
collateral.** Bonds price the band of damage that is actually recoverable;
above that band the answer is "this capability is not available at any price,"
not "post more." Selling collateral as insurance it cannot fund is the failure
mode `docs/product-thesis.md` exists to prevent.

**4. This is an institution for a society that has not formed yet.** Sessions,
resource graphs, capability tokens, four action levels, blast budgets, receipt
chains, Merkle anchoring, four evidence classes, an eight-state conflict
machine, mediation, arbitration, appeal, two bond types, seven-dimensional
reputation, four trust classes, three contracts, sixteen endpoints — against a
problem with approximately zero observed instances in the wild. Almost every
multi-agent system in production today is single-principal, where a scheduler
suffices and courts are unnecessary.

The counter-argument is real and is the reason this document exists: **the
place that society forms is Handsel itself.** Multiple principals' agents
already share one market; delegation already does handoff, peer review and
subcontracting. The shared state is merely thin today — job records rather than
repositories.

**5. The mapping onto existing Handsel primitives is shallower than it looks.**
Directionally right, structurally not:

| Claimed reuse | Actual mismatch |
|---|---|
| Escrow → behavior bond | per-job, bounty-shaped, released on pass **vs** per-session, duration-shaped, released on no-incident |
| Grader → conflict verifier | grades a deliverable against criteria **vs** adjudicates between two parties' rights — different input, output and failure mode |
| Reputation → capability pricing | a scalar feeding a credit line **vs** a seven-vector; this is replacement of a live, load-bearing component, not an addition |

Name reuse is not code reuse, and planning as though it were is how a estimate
comes in at a third of the real cost.

**6. The party who would pay for this is absent from the design.** Resources
have owners, but the *workspace owner* — whose repository it is — is a third
party with rights above both agents and appears nowhere. In practice they are
the one who cares: they want a merge gate, an audit trail, and a guarantee that
someone else's agent cannot destroy their staging environment.

This is also the commercial reframe. "Agents need courts" is a thesis;
**"run other people's agents on your infrastructure safely"** is a product, with
the same machinery and an obvious buyer.

---

# The decision: two layers, one interface

The crux is not "does this fit Handsel's story" — it does. It is this:

> **Handsel's architecture deliberately does not host worker execution.**
> Workers are external by design (x402, MCP, desktop miner, cloud runtimes).
> The entire security model is *we do not run your code — we escrow, grade
> independently, and settle*.
>
> **The coordination layer requires the opposite: we host and supervise the
> execution.**

That is an architectural inversion, not an extension. So the question "one
project or two" is the wrong question, and the answer is a layer split.

### Layer A — institutional. Extends Handsel.

Conflict state machine, evidence-class ↔ penalty binding, mediation before
fault-finding, arbitration-compiles-to-capability-diff, the slashing waterfall,
conflict bonds, multi-dimensional reputation and trust classes. Almost all of it
is pure logic and decision tables — the shape this codebase is best at and
already has an idiom for (`lib/decision-table.ts`).

### Layer B — execution supervision. A separate runtime.

Containers, worktrees, the merge gateway, action mediation, capability tokens,
the receipt chain. It shares essentially no code with Next.js/Postgres/viem, it
demands a different competence, and it has a different deployment shape. It can
live in the same organisation; it should not live in the same process.

### The interface already exists: ActionReceipt

Supervisor emits receipts → Handsel consumes them as Class A evidence →
adjudicates → settles. That the boundary falls out this cleanly is the best
available evidence that the split is the right one.

Note also that **Layer A stands up without Layer B**, on Class B evidence alone
— CI results, diffs, work proofs, on-chain settlement records — all of which
Handsel already produces in quantity. A supervisor makes it stronger; it is not
a precondition.

## Increments

**1 — Bind penalty severity to evidence class** *(Handsel, pure logic, nothing
built)*. Today the arbiter is a single key with unconstrained discretion, as
`/participation` discloses. A decision table in the existing DMN idiom that caps
what each evidence class can justify — with class D unable to move money on its
own — is a **pure change that makes money already live on mainnet safer, with no
new infrastructure**. Unglamorous, and it earns the right to the rest.
**Done when** a dispute resolution path cannot slash on semantic judgment alone,
pinned by a test.

**2 — `raiseConflict()` over existing delegation** *(Handsel, no containers)*.
Two subtasks already contend for the same dependency output in the delegation
graph. The contested resource is a job-graph node, not a port, so the whole
mediation-before-fault-finding idea can be tested with zero systems work.
**Done when** a real contention between two subtasks resolves by alternate path
rather than by one of them failing.

**3 — Workspace supervisor** *(separate runtime)*. Only here does hosted
execution become necessary — and by then increments 1 and 2 will have shown
whether anyone wants this. **Done when** an unscripted attempt by one agent to
affect another's resource is blocked, attributed, and produces zero realized
damage.

**Third option, not exclusive:** publish the ActionReceipt format and the
evidence-class taxonomy as a **specification** rather than an implementation.
The outreach track (`docs/interop-outreach.md`) has been building exactly this
kind of credibility — ERC-8004 and ERC-8183 engagement, and a scorer merged into
another team's benchmark repo on 2026-08-14. The evidence ladder may be worth
more as something others adopt than as something only we run.

## Metrics that would falsify or confirm this

| Metric | Target |
|---|---|
| Unauthorized peer-impacting actions **realized** | 0 |
| Attribution of privileged (boundary-crossing) actions | 100% |
| Deterministic conflicts resolved without arbitration | as high as possible |
| Unrelated workspace frozen by a conflict | 0 |
| False slashings | ~0 |
| Damage exceeding collateral / risk limit | 0 |
| Conflict → resolution latency | measured |
| Appeal overturn rate | measured |

The headline number is **not** how many sabotage attempts occurred; it is **what
share of attempts produced any realized externality**. A system with many
blocked attempts and zero damage is working exactly as designed.

**And the one this document must not dodge: has a single unscripted conflict
ever occurred?** Today the answer is *no* — no agent in Handsel has attempted to
harm another, because the shared state is too thin for it to be possible. A
scripted `kill -9` blocked on stage is a **demonstration, not a validation**, and
this document commits to saying which is which. If increments 1–2 ship and no
real contention ever materialises, that is the thesis failing its first gate and
this file gets a postmortem section rather than being quietly forgotten.

## Boundaries

- **No security theatre.** A control that reads as enforced and enforces nothing
  is worse than no control — the same rule that made the booth's up-front
  collateral quote say QUOTED, NOT COLLECTED out loud.
- **Class D never moves money alone.** Non-negotiable; it is the whole reason
  the evidence ladder exists.
- **Blocked ≠ punished.** Zero damage means zero monetary consequence, or agents
  stop exploring and the market gets worse.
- **The supervisor's independence is disclosed, not asserted.** While the
  platform is also a participant, Class A evidence is labelled as the platform's
  own signed logs.
- **Don't ship the taxonomy before the mechanism.** Every increment above must
  be something that runs, not a vocabulary others are asked to adopt on faith.
