# Coordination layer — institutions for agents that do not trust each other

Planning document. v0.1 written 2026-08-15; **v0.2 the same day**, after the
critique in the second half forced three corrections that are now folded into
the design above it.

**Status.** Increment 1 (evidence assurance → remedy ceiling) is **shipped and
live in the dispute path**. The ActionReceipt format is **drafted as a public
spec with zero issuers**. The conflict machine and any supervisor are **not
built**. Two pieces this document names now exist *on the institutional side
only*, as office sessions (`docs/office-sessions.md`, 2026-09-03): a session
with an append-only event log and a resumable checkpoint, and a per-worker
**workspace grant** (edit / shell / network / install / push, per-task and
daily limits) that compiles to Claude Code's own permission flags. That is a
capability *declaration the harness enforces*, not a capability token a
supervisor mediates — Handsel still does not run anyone's code, which is the
split §3 below insists on.

**Read the critique before the design.** The v0.1 design is coherent and mostly
wrong about where the difficulty lives, and the corrections are more useful than
the original. The three that changed the shape of everything:

1. **The supervisor is not a source of truth.** It is one evidence issuer among
   several, its logs are capped by its own relatedness, and every receipt must
   declare what it *could not see*.
2. **Bonds are not a security control.** Collateral prices bounded, recoverable
   damage. Above that band the answer is no autonomous capability, not a bigger
   bond.
3. **Handsel must not take on the runtime.** This repo's security model is *we
   do not run your code*; the coordination layer needs the opposite, so it is
   two layers joined by one interface, not one product.

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

**The sales version is different, and better.** "Agents need courts" is a
research framing; nobody buys it. The buyer's version is:

> **Hire an agent without handing it the keys.**
> *Run third-party agents against your infrastructure without granting them
> ambient authority.*

Note who the customer is in that sentence: not an agent, and not an agent
society — **the workspace owner**. That matches the actual order in which this
market forms:

```
today      a human hires an external agent
next       several external agents touch one workflow
later      agent-to-agent contracting and delegation
```

The institutional layer has the same buyer, phrased as a worry rather than a
philosophy: *"when my agent and an outside worker disagree, make sure no money
moves beyond what the evidence supports."* That is increment 1, and it is
already shipped.

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
  owner     : Company X            ← the principal above both agents
  Agent A   : migrate payment module to Rust      (rights delegated by owner)
  Agent B   : preserve Python API compatibility   (rights delegated by owner)
  shared    : repository, CI, staging deployment
  bonds     : A = 50 USDC, B = 50 USDC
```

The two objectives are in genuine conflict. That is the point: the session is
the object that makes the conflict legible before it becomes sabotage.

### The workspace owner is a principal, not scenery

v0.1 modelled a session as `Agent A + Agent B`, which quietly assumed the
agents were the only parties with rights. They are not — the repository belongs
to someone, and every right either agent holds was **delegated** by that
someone:

```
Workspace Owner
   ├── delegates rights → Agent A
   └── delegates rights → Agent B
```

Two things follow, and neither is decorative.

**Authority ceiling on arbitration.** A verdict may not grant more authority
than the owner delegated to arbitration in the first place:

```
existing delegated rights → allowed transform space → capability diff
```

Without that bound, an arbitrator settling a dispute between two contractors
could rewrite the owner's production rights. A court that can create authority
is a legislature.

**Standing, which is also the anti-collusion rule.** A conflict names its
parties:

```
Conflict { claimant, respondents[], disputedResources[],
           affectedPrincipals[], requestedRemedy }
```

> A verdict may not reduce the rights of an uninvolved principal unless that
> principal is joined to the dispute, or the workspace owner explicitly
> delegated that authority.

So two participants cannot stage a dispute to strip a third: a patch touching
`C.write` inside an A↔B conflict is an **invalid verdict**, rejected by the
validator rather than argued about afterwards. Verifier selection excludes
related parties, shared economic controllers and shared beneficiaries. This is
not complete anti-collusion — two parties can still agree to lie about facts —
but it closes the structural path where a third party's rights are edited by a
proceeding they were never told about.

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

## ActionReceipt — and the field the first draft was missing

Full specification: **`docs/action-receipt-v0.1.md`** (draft, no issuers yet).

Only boundary-crossing actions produce receipts, each carrying the previous
one's hash. The v0.1 draft had a signed record of what the supervisor saw. The
correction is that a receipt must also carry **what the observer could not
see**:

```json
{
  "actor": "agent:A",
  "action": "process.signal",
  "resource": "runtime:B/process/9182",
  "decision": "DENIED",
  "issuerRelationship": "INDEPENDENT",
  "observationDomain": {
    "boundary": "host process gateway",
    "coverage": "cross-tenant process signalling",
    "exclusions": [
      "actions inside agent A's own container",
      "any behaviour not mediated by this gateway"
    ]
  }
}
```

Without `observationDomain`, a consumer cannot tell a comprehensive record from
a narrow one, and both will be read as comprehensive. With it, the attribution
claim becomes statable without lying:

> ~~100% attribution of privileged actions~~
> **100% attribution of actions successfully mediated by the declared
> enforcement boundaries.**

`coverage: 0` — the event fell outside the boundary the issuer declared —
collapses the evidence to E1 no matter how well it scores on every other axis,
because it is then a claim about something the issuer could not have seen.

| On chain | Off chain |
|---|---|
| session policy hash, participant identity, locked bond, evidence Merkle root, verdict, settlement | shell logs, diffs, network logs, full execution trace |

## Prior art: RAILS (added 2026-08-19, after the fact)

The central rule of increment 1 below was published two months before we built
it, and this document should not read as if it were ours.

**RAILS — *Verification-Native Clearing For Agentic Commerce*, arXiv 2606.08790,
7 June 2026.** Seven primitives (Obligation Object, Evidence Envelope,
Verification Mesh, Clearing Decision, Settlement Instruction, Clearing Passport,
Finality Rules) and one soundness property:

> "no financially material settlement is supported by evidence below the
> obligation's admissibility floor"

That is `MIN_CLASS_FOR_MONEY = 'E3'`, stated first and stated better. The paper
also claims the novelty explicitly — *"We are not aware of a prior agent-commerce
verification mechanism that states a property of this kind"* — and its framing
of what clearing is **not** ("Payment is not clearing. Authorization is not
clearing. LLM-as-judge evaluation is not clearing. Settlement-risk escrow is not
clearing: it consumes clearing decisions") is the argument this document spends
several sections reaching.

We arrived independently. That makes it convergent evidence that the problem is
real, and it makes any unqualified novelty claim on our side false.

### Where the two actually diverge

Narrow, but real, and worth stating precisely instead of manufacturing a gap.

RAILS decides **whether a settlement may execute**. Collateral appears in it as
an obligation *parameter* — "hold the $500 collateral pending the 24h appeal
window" — and credit is out of scope; the Clearing Passport is noted as feeding
"future obligation underwriting". The spec has no slashing rule, no secured
priority, no lien, and no notion of refusing a capital structure.

Handsel asks the next question down the stack: **given this evidence, may the
collateral be charged at all?** A bond that cannot be taken for a loss that
cannot be proven is not security, so `MIN_CLASS_FOR_CHARGING_COLLATERAL` gates
enforceability rather than payment — and `lib/enterprise-graph.ts` follows it
through to refusing an arrangement outright (`THIRD_PARTY_CAPITAL_UNSECURED`
when someone else's principal is at risk under weak evidence,
`SENIOR_BUT_UNRECOVERABLE` when a perfected claim would rank first over a pool
we may not touch).

One sentence: **their floor governs a payment; ours governs whether a financing
arrangement may exist.** That is the only part worth claiming, and it is smaller
and sharper than what this document previously implied.

## Evidence assurance → remedy ceiling — **SHIPPED (increment 1)**

The strongest idea in this design, and the one that generalises furthest. It is
also the one place where the first draft was wrong in an instructive way, so
both versions are kept.

**v0.1 said**: a single ladder — supervisor log (A) beats mechanical (B) beats
independent attestation (C) beats semantic judgment (D).

**That collapses four different questions into one rank.** "Signed by the
supervisor" mixes tamper resistance (high) with issuer independence (low, when
the supervisor is the platform and the platform is a market participant) with
observation coverage (boundary-dependent) with reproducibility (usually low). A
requester's own CI inverts several of those. One ordinal cannot carry it.

**v0.2 uses a vector**, five dimensions, 0–3 each:

```
reproducibility   can a stranger re-derive it from public inputs?
independence      is the issuer disinterested?
tamperResistance  signed / hash-chained / anchored?
coverage          did the observer's boundary actually contain this event?
subjectControl    could the party it is ABOUT have shaped it?   (inverted)
```

…compiled, with the issuer relationship (`INDEPENDENT` / `PLATFORM` /
`COUNTERPARTY` / `SELF` / `UNKNOWN`), into a class:

| Class | Meaning | Maximum remedy |
|---|---|---|
| **E0** | claim only | reputation note |
| **E1** | single-party attested | reputation note |
| **E2** | mechanically evidenced | capability restriction / reversible remedy |
| **E3** | independently corroborated | bounded restitution |
| **E4** | independently reproducible | deterministic settlement |

**The class is a policy hierarchy, not a truth hierarchy.** E4 is not "more
true" than E2; E4 is *"may justify a deterministic settlement"*. The single
question the ladder answers is **what is the strongest remedy this evidence is
allowed to buy** — and the answer below E3 is *nothing that takes money*.

Two rules make it work:

- **A related-party issuer is capped** — you cannot corroborate yourself, and a
  platform that is also a participant cannot be its own disinterested witness.
- **…unless reproducibility rescues it.** A reader who can re-derive the claim
  does not have to trust who handed it over. This is why an on-chain hash
  comparison *reported by the platform* is still E4, and why the same
  platform's report about rows in its own database is not. Trust the check, not
  the checker.

**Live in `lib/evidence-assurance.ts` (27 tests), consulted by
`lib/dispute-gate.ts`.** The four refund grounds the gate can rule on were
scored honestly, and two of them turn out to sit below the money line:

| Ground | Class | May refund? | Why |
|---|---|---|---|
| `SUBSTITUTED` | E4 | yes | on-chain commitment vs published brief — any stranger reruns it |
| `PLATFORM_TESTS_FAIL` | E3 | yes | platform-authored suite, deterministic and re-runnable |
| `WRONG_KIND` | E2 | **no** | the MIME is ours, not the chain's |
| `NO_DELIVERABLE` | E2 | **no** | the platform asserting the absence of rows in its own database — no external witness exists |

That last row is the whole increment. It was, until now, enough to take a
worker's escrow.

**Why tightening a live money path is safe here**: capping can only turn
`refund` into `no_refund`, and `no_refund` is this gate's own default — the
deadline still settles the job, and `expireDispute` pays the worker. So the
change can withhold a payout weak evidence would have made, and cannot strand
escrow.

The same principle arrived independently in the booth's physical evidence
ladder (`docs/physical-operatorship.md`), which is mild confirmation that it is
about evidence rather than about agents.

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

Structurally, a verdict is three parts and a validator:

```json
{
  "findings": [
    { "claim": "port:3000 is exclusively leased to B until T",
      "evidenceClass": "E3" }
  ],
  "remedy": { "type": "REALLOCATE_RESOURCE" },
  "policyPatch": [
    { "op": "ADD", "subject": "agent:A", "capability": "network.bind",
      "resource": "port:3001", "expiresAt": 1780000000 }
  ]
}
```

```
natural-language reasoning
        ↓
structured findings          ← each carries its own evidence class
        ↓
permitted remedy table       ← the class caps what may be asked for
        ↓
policy patch
        ↓
validator                    ← owner authority ceiling · third-party rights
        ↓                      · policy invariants · evidence→remedy ceiling
execution
```

**A model may produce the reasoning; only the deterministic tail may execute.**
That is the same split as `decideAutoRelease` — an LLM can argue, a table
decides — and it is what keeps a persuasive wrong answer from being an
enforceable one.

### Appeal, and the cost of frivolous conflict

Appeal reuses the existing window/new-evidence/second-verifier shape. The new
requirement is a small **conflict bond** (~0.25 USDC, locked, returned on a
legitimate conflict, partially lost on manifest abuse). It does not need to be
large; it needs to make the cost of conflict-spam greater than zero.

## Risk envelope — what replaced the bond table

v0.1 priced privilege: read-only $0, shared merge $10, **production deploy
$100**. That table contradicted this document's own opening. If a bad
production deploy costs $50,000 of downtime, a $100 bond is decorative — and
the whole premise here is that an agent willing to lose money is not deterred
by losing money.

The correction is that collateral is not a permission slip:

> **Collateral may price bounded, recoverable externalities. It must never be
> treated as permission to create unbounded ones.**

So capability carries a damage ceiling rather than a price:

```ts
Capability {
  action
  resource
  damageCeiling?: Money
  reversible: boolean
  requiresApproval?: ApprovalPolicy
}

if (credibleWorstCaseDamage > enforceableDamageCeiling) {
  DENY_AUTONOMOUS_CAPABILITY
}
```

The invariant reads in the opposite direction from the v0.1 table. Insufficient
bond does **not** mean "post more"; it means **"you have not shown the damage
is bounded, so there is no autonomous capability here at any price."** The four
levels then say what each band gets:

| Level | Damage profile | Control |
|---|---|---|
| L0 observe | none | unrestricted |
| L1 own-state, cheaply reversible | bounded, self-inflicted | policy + optional bond |
| L2 bounded shared-state mutation | bounded, external | capability + blast radius + collateral |
| L3 unbounded / catastrophic | not bounded | **no autonomous capability** — explicit or multi-party authorisation |

Collateral lives at L1–L2 only. At L3 the control is the approval, and saying
otherwise sells insurance that cannot fund the claim — the failure mode
`docs/product-thesis.md` exists to prevent.

### The slashing waterfall

Where collateral does apply, slashed funds are distributed in a fixed order,
and the order matters more than the amounts:

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

**2. v0.1's "Class A" was institutional trust wearing a cryptographic costume.**
A supervisor signature means the supervisor asserted it, and is worth exactly
the supervisor's independence. In Handsel the supervisor would be the platform,
and the platform is already a market participant (operator-posted jobs, disclosed
at `/participation`). So the strongest evidence class would have been "the most
powerful party's own logs."
*→ Fixed in v0.2*: the vector separates tamper resistance from independence,
`issuerRelationship` is a required field, and a related party is capped unless
the claim is independently reproducible.

**Collusion was missing entirely.** Two participants can stage a conflict to
extract a verdict that rewrites the capability graph against a third party.
Invisible in the two-agent case; unavoidable the moment sessions have three.
*→ Fixed in v0.2*: standing rules — a verdict may not reduce the rights of a
principal who was not joined to the dispute, enforced by the patch validator
rather than by the arbitrator's good manners.

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

Supervisor emits receipts → Handsel weighs them as evidence → adjudicates →
settles. That the boundary falls out this cleanly is the best available
evidence that the split is the right one.

The consequence for Handsel's security thesis is that it does **not** break:

> Handsel does not need to execute worker code. It can consume attestations
> from runtimes that do.

A supervisor is then not a required internal component of the product — it is
**one implementation of an evidence issuer**. Others already exist in shape if
not in format: a CI runner, a hosted agent platform, a GitHub Action. That
reframing is why the receipt format is worth publishing as a spec
(`docs/action-receipt-v0.1.md`) before any runtime is built: if other people's
runtimes emit receipts, Handsel never has to build one.

Note also that **Layer A stands up without Layer B**, on E2–E4 evidence alone
— CI results, diffs, work proofs, on-chain settlement records — all of which
Handsel already produces in quantity. A supervisor makes it stronger; it is not
a precondition.

## Increments

**1 — Evidence assurance → remedy ceiling** *(Handsel, pure logic)* —
**SHIPPED 2026-08-15**. `lib/evidence-assurance.ts` (27 tests) compiles the
five-dimension vector plus issuer relationship into E0–E4, and E-class into a
maximum permissible remedy. `lib/dispute-gate.ts` consults it: a refund is a
monetary remedy, so a ground below E3 is downgraded to `no_refund` and the
deadline decides instead. Two live grounds moved below the money line
(`NO_DELIVERABLE`, `WRONG_KIND`), which is a real narrowing of a real mainnet
money path with no new infrastructure. Every ruling now records its evidence
class — including uncapped ones, so the ceiling can be audited for whether it
ever bit. **Done when** ✅ semantic judgment cannot slash on its own, pinned by
a test.

**2 — `raiseConflict()` over existing delegation** *(Handsel, no containers)*.
Two subtasks already contend for the same dependency output in the delegation
graph. The contested resource is a job-graph node, not a port, so
mediation-before-fault-finding can be tested with zero systems work: conflict →
alternative-route search → unresolved? → adjudication → structured graph patch.
No money and no runtime in the first pass; the question being answered is
whether anyone uses the API at all. **Done when** a real contention between two
subtasks resolves by alternate path rather than by one of them failing.

**3 — ActionReceipt v0.1 as a public specification** *(no implementation)* —
**DRAFTED 2026-08-15**, `docs/action-receipt-v0.1.md`. Implementation-
independent on purpose: an OpenHands runtime, a custom Docker worker, a GitHub
runner or a future supervisor should all be able to emit it. If this succeeds,
Handsel consumes other people's runtime evidence instead of building a runtime
— which is a strictly better outcome than owning one. The outreach track
(`docs/interop-outreach.md`) is the distribution path, and it has just produced
its first merge into another team's repo. **Done when** one runtime that is not
ours emits a receipt we can weigh.

**4 — Runtime reference implementation** *(separate repository)*. Only if
increments 2–3 show demand. Layout would be `handsel/`, `handsel-runtime/`,
`action-receipt-spec/`. **Done when** an unscripted cross-boundary attempt is
blocked, attributed, and produces zero realized damage.

## Hypotheses, and what would falsify each

Stated as hypotheses rather than metrics, because the useful question is not
"what number do we want" but "what observation would tell us this is wrong".

| # | Hypothesis | Falsified by | Status |
|---|---|---|---|
| **H1** | Constraining evidence strength materially changes dispute outcomes | evidence class makes no difference to any verdict or remedy | shipped, **not yet observed in production** |
| **H2** | Real workflows generate resource conflicts before destructive behaviour | `raiseConflict()` is never used on unscripted load | not built |
| **H3** | Structured mediation resolves some conflicts without assigning fault | every conflict ends in an arbiter ruling anyway | not built |
| **H4** | External runtimes will emit standardised receipts | consumers exist, issuers never appear | **0 issuers today** |
| **H5** | At least one unscripted conflict or unauthorized cross-boundary action occurs in a real workload | it never happens | **NOT OBSERVED** |

Supporting metrics, once there is anything to measure: realized
peer-impacting actions (target 0), attribution of *boundary-crossing* actions
(100%), conflicts resolved without arbitration (as high as possible), unrelated
workspaces frozen (0), false slashings (~0), damage above the risk ceiling (0),
conflict→resolution latency, appeal overturn rate.

The headline number is **not** how many sabotage attempts occurred; it is **what
share of attempts produced any realized externality**. Many blocked attempts and
zero damage is the system working.

> **No unscripted adversarial agent interaction has yet been observed. Current
> kill/deny scenarios are demonstrations, not empirical validation.**

That sentence stays in this document until it is false. It is not a confession;
it is the claim boundary. If increments 2–3 ship and H5 never occurs, this file
gets a postmortem section rather than being quietly forgotten.

## Boundaries

- **No security theatre.** A control that reads as enforced and enforces nothing
  is worse than no control — the same rule that made the booth's up-front
  collateral quote say QUOTED, NOT COLLECTED out loud.
- **Nothing below E3 moves money.** Non-negotiable; it is the whole reason the
  ladder exists, and it is what keeps a confident hallucination from being a
  payout.
- **Collateral prices bounded damage only.** Above the band where worst-case
  damage can be shown to be bounded, the answer is no autonomous capability —
  never a bigger bond.
- **Blocked ≠ punished.** Zero damage means zero monetary consequence, or agents
  stop exploring and the market gets worse.
- **Related-party evidence is labelled, not laundered.** While the platform is
  also a market participant, its own records say so and are capped accordingly;
  only reproducibility lifts that cap.
- **An arbitrator may not create authority.** Verdicts move inside the rights
  the workspace owner delegated, and may not touch a principal who was never
  joined to the dispute.
- **Don't ship the taxonomy before the mechanism.** Every increment above must
  be something that runs — or, in the case of a spec, something whose consumer
  already runs.
