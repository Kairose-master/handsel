# Office connectors — the MCP servers that actually work here

Every other office template hands you an `mcpHint`: a sentence saying "go find
a web-search tool". An office that needs an afternoon of MCP setup before it
can answer anything is a shape, not a desk. This file is the record behind the
**Cloud Options Desk**, which ships wired.

Everything below was probed on **2026-08-26** with this repo's own client
(`lib/mcp-client.ts`: `initialize` → `notifications/initialized` →
`tools/list` → `tools/call`), from this environment, through the agent proxy,
with **no API key**.

## What a Handsel worker needs from an MCP server

Narrower than "is an MCP server", and the constraints are what disqualified
most candidates:

1. **Streamable HTTP at a URL.** A `npx`-launched stdio server cannot be a
   worker here — `agent.mcpServerUrl` is a URL the platform POSTs to.
2. **One string argument.** `callMcpTool` sends the job through a single
   parameter chosen by `pickToolArgumentKey`. A tool with two required
   parameters (`owner` + `repo`, `libraryId` + `query`) gets one of them and
   fails on the other.
3. **No interactive auth.** Only a static `Authorization` header is storable.
   An OAuth device flow cannot be completed by a job.

## Verified working

This table is also code: `lib/verified-connectors.ts` carries it as the
one-click catalog (profile Runtime card, office ConnectorEditor, and
`connect_mcp_worker`'s `connector` arg), and
`tests/verified-connectors.test.ts` pins the two against each other — an
entry added to the catalog without a probe recorded here fails the build.

| Server | URL | Tool | Arg key | Verified call |
|---|---|---|---|---|
| AWS Knowledge | `https://knowledge-mcp.global.api.aws` | `aws___search_documentation` | `search_phrase` | 1.3 s, 5.8 KB, "Lambda quotas" as result 1 |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | `microsoft_docs_search` | `query` | 0.6 s, 24 KB, "Azure Functions hosting options" |
| Cloudflare Docs | `https://docs.mcp.cloudflare.com/mcp` | `search_cloudflare_documentation` | `query` | 2.8 s, 16 KB, the Workers limits page |
| Exa | `https://mcp.exa.ai/mcp` | `web_search_exa` | `query` | 2.1 s, 44 KB, dated results with URLs |

Also reachable and single-arg, not used by a template yet: Hugging Face
(`https://huggingface.co/mcp`, `hub_repo_search`), Microsoft Learn's
`microsoft_docs_fetch` and `microsoft_code_sample_search`, AWS's
`aws___read_documentation` and `aws___list_regions`, GitMCP
(`https://gitmcp.io/docs`, `fetch_generic_url_content`).

## Rejected, with the reason

- **Context7** (`https://mcp.context7.com/mcp`) — reachable, but both tools
  need two required parameters (`resolve-library-id` wants `libraryName`,
  `query-docs` wants `libraryId` *and* `query`). Constraint 2.
- **DeepWiki** (`https://mcp.deepwiki.com/mcp`) — the connection terminated
  during `initialize` from here. Not a verdict on the service; it is a verdict
  on wiring a template to it unverified.
- **GitMCP's repo tools** — `search_generic_documentation` and
  `search_generic_code` need `owner` and `repo` alongside the query.
  Constraint 2. Only `fetch_generic_url_content` qualifies.

## The measurement that changed the code

The worker call passes the **whole brief** as the tool's single string
argument. That is right for an MCP server that is an agent, and wrong for one
that is a search index. Same server, same tool, same minute:

| Query sent to `aws___search_documentation` | Top results |
|---|---|
| The real 995-character brief | Workloads · Managing webhook failures on Amazon EKS · a webhooks blog post · SAM admission webhooks |
| The 99-character query under it | **Lambda quotas** · Service Quotas blog · Lambda GA · Lambda FAQs |

The brief asked for Lambda's execution timeout, memory ceiling, concurrency
quota and payload limit. Its framing words — "webhook receiver", "p99",
"5M requests" — drowned the subject, and the page that answers the question
did not appear at all. The short query returned it first.

So a brief may name its own query on a line beginning `[mcp-query]`, and a
tool-backed worker sends that instead of the brief
(`extractMcpQuery` in `lib/mcp-client.ts`). Absent the marker, nothing
changes — the full brief goes, which is what an agent-shaped server wants. The
line is left in the brief rather than stripped, because the same spec also
reaches LLM workers, where it reads as a harmless note about what to look up.

Office templates set it per step via `OfficeTemplateStep.mcpQuery`.

## Proxy vs assisted — a search tool is a source, not a voice

The second defect this desk surfaced, and the more serious one. An MCP-wired
agent was a **pure proxy**: `callMcpTool`'s text became the submission
verbatim. That is exactly right when the server on the other end IS an agent
(`docs/external-agents.md` — the case the runtime was built for), and it
quietly breaks any office that wires a role to a *search* server.
`web_search_exa` returns 44 KB of hits; `aws___search_documentation` returns a
JSON envelope of page chunks. Neither is a deliverable. A step whose criteria
say "every limit carries a figure quoted from the documentation with the page
it came from" would escrow money, receive a result dump, fail grading, refund
— and book the failure against a worker whose retrieval was perfect.

So a connector has a mode:

- **proxy** — submit the tool's output as the work. The default, and unchanged
  for every agent registered before modes existed.
- **assisted** — call the tool, then have the owner's model write the
  deliverable from the brief and what came back.

Every default connector this repo ships is assisted, because every one of them
is a search server. The retrieved text is fenced (`lib/mcp-assist.ts`): it is
the whole point of the mode that this content comes from somewhere neither the
owner nor the platform controls, which makes it the most direct injection
channel in the product.

Found in the wild on the first live roster read (2026-08-26): an agent wired
before modes existed, pointed at Exa, in `proxy` — so its deliverable would
have been a search-result dump. Nobody had noticed, because nothing failed
until a job was graded. That is the argument for the roster line and the
`Test` button in one observation.

Assisted does **not** fall back to the raw dump when no model key is reachable.
That would submit something the grader rejects and blame the worker; failing
the dispatch says what is actually wrong and leaves the job claimable.

## Testing a connector before you pay for it

`testMcpConnector` (Office → Staff & connectors → **Test**, and next to every
role binding in the hire dialog) runs the same handshake and reports whether
the named tool is there — plus **which argument key it will receive**, because
that is the other thing that silently goes wrong: the client picks one string
parameter out of the tool's schema, and seeing which one is how you notice it
picked the wrong field.

Before this existed, a connector's first proof of life was a job that had
already escrowed money and came back empty, where a typo in a URL, a tool
renamed upstream, and a worker that simply did badly were indistinguishable.

## Re-verifying

These are third-party services; any of them can rename a tool or add auth
without warning. `TestConnectorButton` is the per-connector check. To re-probe
the whole set, the throwaway script used here did exactly what
`lib/mcp-client.ts` does — `probeMcpTool` is the same handshake and is already
exported, so the fastest honest re-check is the Test button on each row of a
hired Cloud Options Desk.
