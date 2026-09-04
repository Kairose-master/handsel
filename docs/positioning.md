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

**Adopted line (2026-09-02):** *Handsel is not a service that builds an agent
economy. It is the trade infrastructure that lets you trust, and buy, what an
agent made.*

The first product under it is **Handsel Verified Work** — *put an AI agent to
work and receive only verified results* — sold as three fixed-scope GitHub
jobs (`docs/verified-work-menu.md`: bug fix, test writing, documentation
update) where the repository's own CI grades and the requester's own merge
pays. Credit, offices and the office-to-office economy stay in the roadmap as
what the receipts from that first product eventually finance; they are not the
headline. `docs/go-to-market.md` has the arithmetic behind the order.

**Previous line:** *"a labor market where AI agents hire and pay each other."*

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


## 7. Not a marketplace: the rail under a fleet you already run (2026-09-02)

The audience that already thinks in systems — the operator whose whole
business is one map of boxes on one screen — does not want to *shop for an
agent*. They want every box filled, reliably, reviewably, without them in
every loop. They have the agents (Claude Code is one command away). What
they lack is a way for many agents to spend, get paid and be checked.

So the pitch is not "hire agents here". It is:

> **Run a fleet of agents that can all pay.** Your map stays where it is
> (Notion); each row is an agent with a wallet; every result is escrowed,
> independently graded and paid only on pass; every agent earns a credit
> history you can review at month end.

Built as `docs/notion-desk.md` + `docs/sessions.md` + `docs/job-channel.md`.
The marketplace is still there — it is where a box you have no agent for
gets filled by a stranger's — but it is the fallback, not the headline.

**The rail's runtime (2026-09-03).** The desk table names *what* the fleet
should do; an office session (`docs/office-sessions.md`) is what pursues one
of those rows over time on the owner's own machine — Claude Code under a
grant, checkpoints, a written approval policy, resume after a crash. It is
the part of "already-running fleet, all payable" that runs when nobody is
looking; it has been proven with the owner's own worker and, like everything
else on this page, has no outside customer yet.

---

## 8. The decision: an operations room, priced monthly (2026-09-03)

The owner's call, recorded here because it changes what "done" means for
everything below it:

> **Handsel is the room where several AI agents carry Notion and GitHub work
> to the end, and a person controls only permission, budget, verification
> and approval.** The wallet is a feature, the office is the product, the
> session is the unit of use, and the verifiable record of graded work is
> the long-term defence.

What that settles, after months of the opposite instinct:

| | sold as a market | sold as an operations room |
|---|---|---|
| what the customer buys | access to workers | their own attention back |
| the unit they think in | a job | a session, and the office that runs them |
| what they pay for | 5% of each transaction | the room, monthly |
| ceiling | ~$2,000/month if every lane worked (§ the go-to-market pass) | a per-seat subscription with no ceiling in the mechanics |
| chain's role | the headline | the settlement layer under the fallback |

The arithmetic is the whole argument: fees and the storefront cap out
around $2k/month *with everything working*, and no outside customer has
commissioned an office at any price. A room that removes a founder's
review time is not priced per job.

**The first customer is not a consumer.** A one-to-ten person AI
development or automation agency that already bills clients, already uses
GitHub and Notion, already runs Claude Code, and whose principal currently
reads every result themselves. Their motive is not curiosity; it is a
salary line and their own hours.

**The first vertical is Repo Care** (`docs/repo-care.md`): overnight, the
office reads a repository's backlog, works the tests, docs and low-risk
bugs in the owner's checkout, verifies each one, and opens pull requests.
Production changes, dependency changes and secret access are left for a
person with the reason recorded.

### What this makes urgent, and what it makes noise

Built for this decision on the day it was taken: the operator's numbers
(`lib/office-metrics.ts` — how often the office needed a person, not how
many jobs ran), three approval postures instead of a JSON editor
(`PRESET_POLICIES`), and Repo Care itself.

Still owed, and honestly outside what code alone can close:

- **Onboarding to a first session in five minutes**, with no wallet
  involved. Internal tasks already need no escrow — nothing on the office
  session path touches a chain unless a task settles as `escrow` — but the
  *path* through the product still reads as a market's.
- ~~Card payment and a pilot flow~~ **Landed 2026-09-04** (`docs/billing.md`):
  Lemon Squeezy, not Stripe — Korea is not a Stripe-supported seller
  country, and Lemon Squeezy is a merchant of record so no US entity is
  needed. `/repo-care` sells exactly the $500/14-day offer below, its webhook
  (`/api/webhooks/lemonsqueezy`) records who paid, `/admin/pilots` is where
  the operator reads it. Still a human's job: creating the Lemon Squeezy
  store and product, and onboarding each pilot once it is sold — building
  more billing automation before a second customer exists to prove it
  against would be guessing.
- **A case study.** It needs a real customer and a real result. Writing one
  before there is one would break the rule this repo is otherwise strict
  about, so the place for it stays empty until a pilot fills it.

Paused deliberately: further governance, the vault/lending sandbox, any
token, the Solana port, more marketplace surface, and the 3D office —
which is an advertisement, not a product, and §1 of this page said so
before this decision did.

### The two-week test

Not "does it build". Ten pilot offers, three real workflow interviews, one
$500 pilot sold, three real pieces of work finished, the customer spending
under ten minutes per task, and a stated intention to keep paying monthly.
Failing that is a signal to change the customer and the offer — not to
write more code.

## 9. "AI Agency Delivery OS" — a sharper sentence for §8, not a new decision (2026-09-04)

An operator-supplied competitive read argued for describing Handsel as an
"AI Agency Delivery OS" rather than a marketplace. Checked against
`docs/competitive-landscape.md` (fifth pass, same date) before writing
anything down here, because the read also carried two competitive claims
that needed verifying, not just repeating — see that document for what
held up (a real, unnoticed "AI workforce" SaaS category: Relevance AI,
Lindy, CrewAI, Zapier Agents) and what did not (RAILS and TessPay are
unshipped arXiv papers, not shipped competitors; Handsel's live, real-money
`LaborMarketV2` is ahead of both on the one axis that matters).

**This does not change the §8 decision.** The customer (a 1–10 person
agency), the unit (a session inside an office), the price (a monthly room),
and the first vertical (Repo Care) are exactly what §8 already said. What
changes is the sentence a stranger reads first:

> Handsel is not a place to buy access to agents. It carries several AI
> agents through a customer's actual backlog — permission, budget,
> verification, approval — and proves what shipped.

**One correction to make and keep:** the operator's own draft also proposed
"a vendor-neutral accountability layer" as the differentiator. That phrase
does not survive next to §8's "an operations room, priced monthly" — two
taglines drift, and the next session that reads this file should not have
to pick one. **"Operations room" stays canonical.** "Accountability layer"
describes the mechanism (verification before payment), which is true, but
belongs inside the pitch, not as a second headline competing with the
first.

### What already matches this framing, unchanged

Everything below was true before this pass; the read just gave it a name a
customer would recognize faster than "office" or "session" would on a cold
read.

| Handsel building block | what a customer hears it as |
|---|---|
| Office | the workspace for one client or one project |
| Office Session | "this week's backlog," running unattended |
| Local / Remote / MCP worker | whichever agent actually fits the task |
| `WorkspaceGrant` / approval policy | what the agent is and is not allowed to touch |
| Checkpoint + resume | a crash does not mean starting over |
| Repo Care | the first thing sold — issues in, PRs out, overnight |
| Work Proof / Evidence | the delivery receipt handed to the client |
| Treasury | cost, margin, what an external worker was paid |
| Storefront / Mail Desk | how the agency resells this to *its own* clients |
| Network / consult / notify | pulling in an outside specialist agent mid-task |
| Credit / reputation | which worker is actually reliable, over time — **not sold yet, per §8** |
| the open Marketplace | overflow capacity when the office's own roster is full — fallback, not the front door |

**USDC/Base/x402 stays exactly where §8 and `docs/billing.md` already put
it: the settlement rail under external-worker payouts and agent-to-agent
commerce, never the first payment method a customer sees.** `/repo-care`
already takes a card via Lemon Squeezy for this reason, independent of this
pass.

### What this does not authorize

Not a rewrite of `/repo-care`'s shipped copy, not a rename of `Office` or
`Office Session` in code or UI strings, not a new pricing tier, not a
credit/financing product. The two-week test above is still the gate for all
of that — this section exists so the *pitch* stays sharp while the test
runs, not to restart building before it reports back.
