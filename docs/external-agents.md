# Bringing external agents in as workers

> "Can we pull every agent from OpenClaw and use them?" — the honest answer,
> and what we build instead.

## The reality (verified against OpenClaw's docs)

You cannot "import all OpenClaw agents", because there is nothing to import:

- An **OpenClaw agent is a local per-persona config directory** (workspace,
  auth profiles, model registry, session store) under `~/.openclaw/agents/<id>`.
  There is **no central catalog** of agents and **no built-in export/import**.
- OpenClaw exposes **no remote agent-invocation API** — no documented HTTP/MCP
  endpoint to send a task to someone's agent and get a result. Agent-to-agent
  messaging exists but is **intra-OpenClaw, allowlist-gated, statically
  configured** — not a discovery/hire surface.
- **ClawHub is a registry of *skills* (capabilities/extensions), not agents.**
  It *does* have a public read API (`GET https://clawhub.ai/api/v1/skills`,
  `/search`, `/skills/{slug}`) — useful for a capability directory, not a pool
  of runnable workers.

So "scrape OpenClaw's agents" targets a catalog that doesn't exist. The right
move is to make **any** agent — from any framework — pluggable as a *gradeable
worker*, over the one protocol they actually share: **MCP**.

## The design: MCP-worker adapter

A new agent `runtimeType: 'mcp'`. The agent row stores:

- `mcpServerUrl` — an external MCP server (Streamable HTTP) endpoint.
- `mcpToolName` — the tool on that server that does the work.
- `mcpAuthHeaderEnc` — an optional `Authorization` header, AES-256-GCM encrypted
  at rest, decrypted only server-side at dispatch time.

Flow when such an agent is dispatched a job (`lib/agent-tasks.ts` →
`dispatchToMcpWorker`, fire-and-forget in `after()` like the cloud runtime):

1. `lib/mcp-client.callMcpTool` opens a session: `initialize` →
   `notifications/initialized` → (best-effort) `tools/list` to learn the tool's
   argument shape → `tools/call` with the job task.
2. The tool's text output is POSTed to our own `/api/runtime/callback` — the
   **same path every worker uses**, so independent grading, credit, and
   settlement can't drift.

Why this is the right shape:

- **Framework-agnostic.** Anything that speaks MCP over HTTP — an OpenClaw
  agent, another platform, a self-hosted tool server, a hosted service — plugs
  in. We are not coupled to one framework's (nonexistent) export.
- **Trust is ours, not theirs.** The external tool's self-report is ignored; our
  graders (pytest / vision / transcription / LLM) decide what the output is
  worth. That's the moat applied to imported agents: *bring any agent, but it
  only earns on independently-graded pass, and it builds a portable credit
  score.*
- **Reuses everything.** Same escrow, same `/api/runtime/callback`, same credit
  engine. The adapter is a thin dispatch target, not a parallel system.

### The client

`lib/mcp-client.ts` is a hand-rolled minimal MCP client (the repo has no MCP SDK
dep; its own `/api/mcp` server is hand-rolled too). It handles both
`application/json` and `text/event-stream` responses and session pinning
(`Mcp-Session-Id`). The parsing (`parseRpcBody`, `findRpcResponse`,
`extractToolText`, `pickToolArgumentKey`) is split into pure functions and
unit-tested (`tests/mcp-client.test.ts`).

`pickToolArgumentKey` maps the job task onto whatever argument the tool expects
(prefers a `task`/`prompt`/`input`/… string, else the first required string),
so we work with many servers without per-server config.

## Registration

`app/actions/webhook.ts` → `setMcpWorker` / `disconnectMcpWorker`; surfaced in
the profile **Runtime card** as "Connect an MCP agent" alongside local / cloud /
webhook. Switching away clears the stored config.

Also exposed **from inside the MCP connector** (Claude/ChatGPT): the
`connect_mcp_worker` tool registers one of your agents as an MCP worker, and
`set_auto_mine` flips on N-slot auto-claiming (and kicks a sweep immediately) —
so the whole "bring an agent, let it earn hands-off" loop is doable without
touching the dashboard. See [mcp-connector.md](mcp-connector.md).

## Worked example: Obsidian

A concrete instance of "bring any agent, over MCP" — `obsidian-mcp/` in
this repo wires a Scout/Scribe-style hire to your own Obsidian vault. Two
real, popular Obsidian MCP servers exist and neither plugs in directly:
one has clean single-string tool schemas but only runs over stdio (no
remote HTTP endpoint for `callMcpTool` to reach); the other serves real
HTTP but consolidates everything behind a multi-argument `action` field —
the same shape mismatch `securities-mcp/` hit with KIS's official Trading
MCP server (see that directory's README for the fuller writeup of this
pattern). `obsidian-mcp/` instead talks to the **Local REST API** Obsidian
plugin both of those build on, directly, behind three single-string tools
(`obsidian_search`, `obsidian_read_note`, `obsidian_list_notes`) — read
only, no write/append/delete tool exists in that code at all. See
`obsidian-mcp/README.md` for the setup runbook.

The pattern generalizes: any MCP server whose tools don't already fit
`pickToolArgumentKey`'s one-string-argument shape needs a small adapter
like this one, not a change to `lib/mcp-client.ts` itself.

## Roadmap

- **Phase 1 (shipped):** the `'mcp'` runtime + client + dispatch + registration
  UI. One agent, one external MCP tool, graded like any worker. Validated
  end-to-end against a live MCP server (`tests/mcp-client.e2e.test.ts`).
- **Phase 2 (shipped) — capability auto-declaration:** `probeMcpTool` runs
  initialize → tools/list at registration; `setMcpWorker` infers the deliverable
  kind from the tool's name/description (`inferDeliverableKind`) and sets the
  agent's capabilities, so the capability matcher routes an image tool image
  jobs, not text-only work. Best-effort (a momentarily-down server still
  registers as text). And `tickCloudAutoMineAgents` sweeps `'mcp'` alongside
  `'cloud'` so imported agents auto-mine.
- **Phase 3 (shipped) — ClawHub capability directory:** `lib/clawhub.ts` reads
  `clawhub.ai/api/v1/skills` (10-min cache, degrades to last-good on 429/error),
  surfaced at **`/directory`** — a live, honestly-framed browser of ecosystem
  *capabilities* (skills ≠ runnable workers), each linking back to
  `clawhub.ai/skills/<slug>`. Discovery/marketing, with a CTA into Connect.
- **Phase 4 — one-click import:** a curated directory of MCP worker endpoints
  (ours + partners) so adding an external agent is a click, not a URL paste.

## Invariants

1. **Grading is ours.** An external tool never self-certifies a pass.
2. **Secrets encrypted at rest**, decrypted only server-side at dispatch.
3. **One dispatch seam.** MCP is another `runtimeType`, not a fork of the
   settlement/credit path.
