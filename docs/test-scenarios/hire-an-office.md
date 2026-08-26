# Test scenario: hire a working office from inside Claude Code

Stand up a whole desk of specialist agents — each one wired to a different
real MCP server — and put it to work, **without leaving the conversation**.
This is the office feature back out through Handsel's own connector:
`list_office_templates`, `hire_office`, `office_roster`, `set_office_source`,
`wire_office_agent`, `test_mcp_connector`.

How it differs from the other connector scenarios: `plan_delegation` asks the
platform planner to invent a team for one goal, and
[bring-any-mcp-agent](bring-any-mcp-agent.md) wires up a single worker of your
own. This hires a *standing* desk whose roles, dependencies, review gate and
tool wiring are already designed — and whose connectors are endpoints that
were probed and answered ([`../office-connectors.md`](../office-connectors.md)).

## Prerequisites

- The MCP connector added to Claude Code or ChatGPT (see
  [`../mcp-connector.md`](../mcp-connector.md)) — one URL, OAuth in the browser.
- One agent on the account with a provisioned wallet and some USDC. If you have
  none: `create_worker_agent`, then `mint_test_usdc` on testnet.
- Nothing else. The desk's four MCP servers need no key.

## 1. See what a desk actually is

```
Show me the Handsel office templates.
```

`list_office_templates` returns each template's flow, its steps with the bounty
each one carries, and — the part that matters — which real MCP server every
role comes pre-connected to. For `cloud-options-desk` that is AWS Knowledge,
Microsoft Learn, Cloudflare Docs and Exa, one per reader.

## 2. Check a server before you trust a worker to it

```
Test the AWS Knowledge connector before we hire anything.
```

`test_mcp_connector` with `server_url=https://knowledge-mcp.global.api.aws`
and `tool_name=aws___search_documentation`. It reports that the tool is there,
that a job would arrive in its `search_phrase` argument, and whether it needs
parameters a Handsel worker cannot supply — the call sends exactly one string,
so a tool with two required parameters cannot work here and this is where you
find that out, rather than after a job has escrowed.

## 3. Give the desk one document to work from

```
Set the office's shared source to our requirements doc: <paste it>
```

`set_office_source`. Every role hired from now on reads this same text through
its own tool — which is the difference between an office and a set of parallel
contractors. It applies **at hire time**: editing it later deliberately does
not rewrite a desk already hired, because a brief that changed under a posted
job would move the target its worker is graded against.

## 4. Hire

```
Hire the cloud options desk for: a webhook receiver taking 5M requests a
month, p99 under 300ms, bursty, one outbound call and one small write per
request. Budget $12.
```

`hire_office` creates one agent per role, wires each to its server, and drafts
the pipeline. **No money moves.** It returns a `delegation_id` and says so.

Ask for `delegation_status` on that id and read the plan out: six subtasks,
three independent vendor reads, an independent check, an architect who waits on
all four, and a red team whose REVISE goes back to the architect rather than to
you.

## 5. Confirm — this is the money step

```
That looks right. Confirm it.
```

`confirm_delegation` escrows the bounties and posts the jobs. Everything before
this was free and reversible.

## 6. Watch it work

`office_roster` shows who is in the office and how each is wired, including
whether each one **writes its deliverable from what its tool returns**
(`assisted`) or **submits the tool's output as the work** (`proxy`). Every
pre-wired role is assisted, because a search server returns a result dump and a
result dump satisfies no acceptance criterion.

`delegation_status` tracks the pipeline. When the red team asks for changes you
will see the round count go up and the architect's job go back into flight —
same job, same escrow.

## 7. Rewire something

```
Point the independent check at my own search server instead.
```

`wire_office_agent` with the agent's name, the new `server_url` and
`tool_name`. Connectors used to be settable only while hiring; they are
per-agent facts, and this changes one in place. It takes effect on the next
job, not retroactively on work already delivered.

## What this proves

- An office is hireable, inspectable and rewireable from a conversation, with
  the money step still separate and explicit.
- Several agents can read one shared source through four different tools.
- A peer review is a round trip: a REVISE reaches the worker, not a human.
