# Positioning — what is actually being sold

A re-split of the product against marketing fundamentals, written after
finding the same defect three times in one week: a thing that is complete,
correct, tested, and reaches nobody.

That is not only a code smell here. It is the product's central problem, one
level up.

---

## 1. The component split

Handsel is currently one bundle. It is really seven things, and they have very
different value on their own:

| # | component | value standing alone | who else has it |
|---|---|---|---|
| 1 | Job board / matching | near zero without both sides | everyone |
| 2 | On-chain escrow (Base, real USDC) | low — escrow is a commodity | many |
| 3 | **Independent grading** — deterministic tests, the requester's own CI, peer review, adversarial red-team | **high** | almost nobody, at this rigour |
| 4 | **Credit score from graded outcomes** | **high**, and compounding | nobody |
| 5 | Directory of attachable tools (MCP servers, harnesses) | zero as a list | fifteen registries |
| 6 | Office metaphor / 3D scene | attention, not revenue | nobody, and nobody asked |
| 7 | MCP connector (52 tools) | distribution | a real advantage |

**3 and 4 are the product. 1, 2 and 5 are the packaging. 6 is the ad. 7 is
the channel.** The site currently leads with 1 and 2.

---

## 2. The problem, stated without flinching

Handsel is a two-sided market with neither side present, and the current
answer to that is that the founder runs both sides. An account with 17 agents
hiring each other is a simulation of a market, not a market. Every metric it
produces is self-referential.

Two-sided markets do not get solved by building the market better. They get
solved by finding a **single-player use** — something one person gets value
from on day one, with nobody else on the platform — and letting the market
grow out of the exhaust.

So: what does Handsel produce that is worth something to someone who will
never post a job?

---

## 3. The wedge: the asset nobody else has

Every completed job here emits, without anyone opting in:

- a **grading verdict** from a grader that is not the worker,
- a **signed work proof** fingerprinting the exact bytes delivered,
- an **on-chain settlement** that either happened or did not,
- and a **credit movement** that cost the worker its own bond if it failed.

That is a benchmark where **the model is playing for money**, adversarially
reviewed, with receipts. Nothing else in the AI-tooling space has this:

- SWE-bench and friends are static, public, and contaminated — a model can
  have seen the answer.
- Vendor evals are self-reported and self-graded.
- Arena-style voting measures *preference*, not *whether the work was
  accepted and paid for*.
- Every MCP registry ranks by **stars and install count** — a popularity
  metric that says nothing about whether the tool does the job.

The repo-job path is the strongest version of it and should be the flagship:
the requester's **own CI** is the grader and their **own merge** is the
payment. Handsel is not the referee there. It cannot be accused of marking its
own homework, which is the first objection anyone will raise.

**One line: the only place where "is this agent any good" has receipts,
because it got paid or it did not.**

---

## 4. The ladder, and where the product currently starts

| rung | what a stranger does | what it costs them | what they get |
|---|---|---|---|
| 1 | **Reads** the record: which tools/harnesses actually pass, on what kind of work, over how many jobs | nothing, no account | an answer they cannot get anywhere else |
| 2 | **Attaches** their own MCP server or harness and lets it be graded | a few minutes | a public track record they can cite in their own README |
| 3 | **Hires** — posts a job with money on it | real USDC | work, graded, paid on pass |

The product currently starts at rung 3. Sign up, provision a wallet, fund it,
post a job, hope a worker exists. That is the highest-friction entry point on
the ladder used as the front door.

Rung 1 is the wedge. Rung 2 is where a **vendor** becomes a user, and vendors
are the best possible early adopters because a track record is *marketing for
them* — they will link to it, which is distribution Handsel does not pay for.

---

## 5. The MCP hub, reframed

The instinct — "make it a hub where many harnesses and many tools live" — is
right, but a directory alone is dead on arrival. Smithery, mcp.so, PulseMCP
and the official registry already exist. Being registry #15 is not a product,
and `/directory` today is literally a **mirror of ClawHub's list, ranked by
ClawHub's stars and installs**: somebody else's data, somebody else's
popularity metric, and nothing Handsel can vouch for.

The hub is only a category of one if it prints the column no other registry
can:

| tool | jobs | passed | median $ | median time | last graded |
|---|---|---|---|---|---|
| … | 41 | 78% | $1.20 | 6m | 2h ago |

Everything needed to produce that already exists and is running:

- `connect_mcp_worker` brings any MCP server in as a gradeable worker
  (`lib/mcp-client.ts`, `docs/external-agents.md`).
- `--harness` brings Claude Code, Codex, OpenCode, Cline or Gemini CLI in as
  a local worker (`lib/worker-harness.ts`, `docs/coding-harness.md`).
- Grading, settlement and work proofs run on every job already.

**The one thing missing is the aggregation axis.** The record is kept per
AGENT — a credit score belongs to one owner's agent. Nobody can ask "how does
the Exa MCP server do on research jobs?" or "does Codex or Cline close more
issues?", because the answer is scattered across private agents owned by
different accounts. `agent.mcpServerUrl` / `agent.mcpToolName` and the harness
id identify the tool on every job already; nothing groups by them.

That is a reporting change, not a new system. It is also the highest-leverage
thing on this list, because it turns four existing components into the one
thing that makes the other three worth visiting.

**Careful, and non-negotiable:** publishing per-tool numbers means publishing
about somebody else's product. It has to be per-tool aggregate only, never
per-customer; it has to state the sample size next to every rate (a 78% over
9 jobs is not a fact); and a tool's owner has to be able to see the jobs
behind their own number. Get this wrong and the first vendor to be ranked
badly becomes a public enemy instead of a user.

---

## 6. Positioning

**Current line:** *"a labor market where AI agents hire and pay each other."*

It describes a **mechanism**, not a benefit, and it is science-fiction-shaped,
which recruits spectators rather than customers. People retweet it; nobody
opens a wallet because of it.

**What the line should do** is name the job-to-be-done. Two honest candidates:

- *Evidence, for the buyer:* **"Which AI tool actually does the work? Ask the
  ones that got paid."**
- *Outcome, for the repo owner:* **"Label an issue with a bounty. Merge the
  PR, or don't pay."** — concrete, checkable, and the strongest existing
  mechanism (their CI grades it; their merge pays).

The agents-hiring-agents story stays. It is genuinely novel and it is the
*proof* that the grading is not a human rubber stamp. But it is the second
paragraph, not the headline.

---

## 7. What to cut, and what the risks are

**The 3D office is an advertisement, not a product.** It is the best
attention asset here and it should keep being made well — but it belongs
pointed AT the evidence, not standing in for it. An office that renders a
leaderboard's worth of real graded work is a demo with a point; one that
renders agents walking around is a screensaver.

**Honest risks, in the order they will bite:**

1. **Volume.** A leaderboard over 40 jobs is not evidence, and claiming it is
   destroys the one asset that matters. State N everywhere; refuse to rank
   below a threshold.
2. **Gaming.** The moment a public number matters, someone farms it. The
   defences exist (peer review, adversarial red-team, bonds at risk, the
   failure cooldown) — they need to be *visible*, because an unaudited
   leaderboard is worth exactly as much as a self-reported one.
3. **Referee and league.** Where Handsel grades, Handsel is both. Lead with
   the repo-job path where it is neither.
4. **Real money on mainnet.** Every claim on that deployment is a claim about
   somebody's actual USDC. This is a feature for credibility and a liability
   for mistakes, and it argues for the read-only rung being genuinely
   read-only.

---

## 8. The one thing to build next — **built**

`lib/tool-identity.ts` + `lib/tool-record.ts` (pure, tested) and
`lib/tool-record-server.ts` group the existing grading record by TOOL instead
of by agent. It renders above the mirrored list on `/directory`, and
`tool_record` answers it from inside Claude and ChatGPT where the buyer
already is. Local workers now report which harness they run, so a Codex or
Cline worker is attributable at all.

Three constraints from §5 and §7 are enforced in the code rather than left to
whoever writes the page:

- **`passRate` is null below 5 graded jobs.** Absent, not rounded — a caller
  cannot print a rate that isn't one.
- **Distinct hiring ACCOUNTS ride along with every row**, and a single-source
  record is listed but never ranked. One account running seventeen agents
  that hire each other is one source; counting agents would make exactly this
  market look independent when it is not.
- **Nothing account-identifying leaves the module.** The requester's owner is
  used only to count sources.

And a fourth found on the way: `job_spec` deliberately does not cache the
bounty, because a cached price drifts from the escrow and then promises money
the contract will not pay. So the price is read from the chain and left
ABSENT when that read fails — a `$0.00` median is a claim about price, and an
unavailable RPC is not evidence of one.

### The original plan



**Group the existing grading record by tool, and publish it.**

Not a new system: a query over `job_spec` and `agent`, grouped by
`mcpServerUrl`/`mcpToolName` and by harness id instead of by agent — plus a
public page that needs no account, and an MCP tool so the answer is reachable
from inside Claude and ChatGPT where the buyers already are.

It converts `/directory` from a mirror of somebody else's registry into the
only registry with receipts, gives rung 1 something to be, gives vendors a
reason to attach at rung 2, and makes every job the market runs pay for
itself twice — once as work, once as evidence.
