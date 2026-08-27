# Typed normative transport

Implements the framework in *Beyond Personal Identity: A Typed Transport
Theory of Normative Succession under Fission and Merger* (v3), in
`lib/normative-transport.ts`.

The paper's claim, in one line:

> A verdict about whether the successor **is** the predecessor neither settles
> nor is needed to settle what happens to any particular claim, duty, power,
> liability or immunity.

## Why this is not an abstraction here

Biological persons instantiate only 1→1. Corporate persons instantiate
fission and merger rarely, under heavy procedure. **Handsel agents instantiate
all four topologies routinely, cheaply, and often without record** — which is
exactly the asymmetry §3.2 identifies.

- `hire_office` reuses an agent (1→1) or mints a fresh one
- `create_worker_agent` copies a role
- agents are retired and their ETH withdrawn
- an office reused into a second template merges two histories

Every one of those sites already answers a succession question, implicitly and
differently. `hire_office` decided that instructions carry over and wallets
stay; nothing wrote down why, and nothing checked that answer against the one
`failedWorkerIds` gives.

§11.2 of the paper asks for precisely what this file is: incidents carrying
their grounding event, counterparty and transfer conditions as metadata,
"created deliberately" because artificial agents have no register of title.

## What a Handsel agent actually holds

| Incident | Kind | Rival | Indexical | Unique by reliance |
|---|---|---|---|---|
| USDC balance | claim | ✔ | | |
| Staked bond on an accepted job | duty | ✔ | ✔ | |
| Credit score | claim | | ✔ | |
| MCP signing / wiring authority | power | | | ✔ |
| Failed-lineage disqualification | liability | | ✔ | |
| Job reservation (award) | claim | ✔ | | ✔ |
| Gas pool designation | power | | | ✔ |

The table is the point. Under one transformation these do **different** things,
and no verdict about whether the successor "is" the predecessor tells you which.

## The rules, in priority order

1. **Persistence decides nothing.** 1→1 preserves everything.
2. **Indexical incidents extinguish** (Principle 5) — checked *first*, before
   the liability rule. See below.
3. **Reliance-unique incidents preserve** (Principle 4), unless the relying
   parties waive.
4. **Liabilities are conditional** (Principle 6): replicate when the fission
   was in contemplation of them, divide when it was not, and replicate while
   that is `unknown` — because `unknown` is not `no`, and dividing on an
   unresolved motive is the incentive the penalty default exists to remove.
5. **Rival incidents divide** (Principle 3), with conservation.
6. **Non-rival incidents replicate**.
7. **Merger composes rather than aggregates** (Principle 7), and this module
   refuses to rank colliding obligations rather than inventing a meta-rule the
   paper explicitly declines to supply.

### Why indexical is checked before liability

A disqualification arising from prior conduct is *both* indexical and a
liability, and the two principles appear to point different ways. They do not.

`extinguish` is a claim about **successors** (N⁺ = ∅). It says nothing about
the predecessor, who keeps the incident. So a fresh agent does not inherit a
disqualification it did not earn — and the predecessor is not released.

Reading them as competing produces the wrong answer: passing a
disqualification to an agent that did not do the thing.

## The anti-avoidance rule Handsel can actually decide

§9.3 needs a finding about an agent's *reasons* for fissioning. The paper is
candid that this imports a mental-state inquiry it otherwise avoids (§10.2).

Handsel cannot make that finding, and does not need to. Replace the question
with one that has an answer:

> Would this transformation leave the **same controller** free of a burden it
> was under a moment ago?

`escapesByRestructuring()` asks that. Principle 6 without §10.2's cost.

## What it fixed

`failedWorkerIds` records **agent ids**. A new agent gets a new id. So an owner
whose agent failed a lineage could take the repost with a second agent of their
own — `create_worker_agent`, or `hire_office` with `freshAgents` — and the gate
would see an id it had never heard of. The disqualification was lifted by a
unilateral act of the party under it.

`lib/failed-lineage.ts` closes it at the controller. Deliberately narrow: the
same lineage, to the same controller, and nothing else. A different owner
taking reposted work is the market functioning, and an unresolved controller
lookup blocks nobody — that must not become a way for a database hiccup to
close the board.

The two refusals say different things on purpose. Told the agent-level message,
an owner's rational next move is to mint another agent — the exact behaviour
being refused.

## The controller

`verifierIndependence()` in `lib/trade-instruments.ts` and
`escapesByRestructuring()` here both needed the same primitive, and neither
had it. `lib/economic-identity.ts` supplies it:

```
agent  →  operator (account)  →  organisation
```

Independence is judged at the **highest level two parties share**, not at the
agent — two agents may share an organisation without sharing an account, and
that is still a conflict.

The membership rule is asymmetric, and that asymmetry is what makes it
resistant rather than decorative:

> A claim that **increases** your constraints is believed. A claim that
> **reduces** them requires attestation by the party it binds.

Declaring "these agents are mine" narrows what they may do — an admission
against interest, taken at face value. Gating conflict detection on
attestation would be the hole: everyone stays unattested and every check
clears.

`strongestControlKey()` is what `failed-lineage` compares. It never falls back
to the agent id: an agent is the thing being controlled, and falling back
would report every pair of agents as different controllers — the answer that
clears an attacker.
