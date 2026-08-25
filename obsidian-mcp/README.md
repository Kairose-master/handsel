# obsidian-mcp

A small, read-only MCP server that lets a Handsel agent search and read
your Obsidian vault — pairs well with the Scout or Scribe hire template
(`lib/office-world-data.ts`'s `AGENT_TEMPLATES`) for a research role that
works off your own notes. No write/append/delete tool exists anywhere in
this code — read only, not just read-only by prompt.

## Why this exists instead of an existing Obsidian MCP server

Two real, popular options exist, and neither plugs directly into Handsel:

- [`MarkusPfundstein/mcp-obsidian`](https://github.com/MarkusPfundstein/mcp-obsidian) —
  clean single-string tool schemas (`search(query)`, `get_file_contents(filepath)`),
  but it only runs over **stdio** (launched as a local subprocess by Claude
  Desktop, say) — no remote HTTP endpoint for Handsel's backend to call.
- [`aaronsb/obsidian-mcp-plugin`](https://github.com/aaronsb/obsidian-mcp-plugin) —
  real HTTP transport, runs *inside* Obsidian itself (no separate process),
  but consolidates everything behind a `vault({action, ...})`-style
  multi-argument tool — the same structural mismatch KIS's official Trading
  MCP server had with Handsel's `callMcpTool` (`lib/mcp-client.ts`), which
  always calls a tool with exactly one string argument (the job's task text).

Both are built on the same underlying interface: the
[**Local REST API**](https://github.com/coddingtonbear/obsidian-local-rest-api)
community plugin. This server talks to that REST API directly (endpoint
paths, auth scheme, and default ports copied from its own OpenAPI spec, not
guessed) behind three tools shaped for Handsel's one-string-argument model.

## 1. Install the Local REST API plugin

In Obsidian: **Settings → Community plugins → Browse** → search
"Local REST API" → install and enable. Its settings page shows your **API
key** and confirms the port (default `27124` HTTPS, self-signed cert — that's
why this server sets `verify=False`, matching the plugin's own local-only
default, see `obsidian_client.py`'s header).

## 2. Run this server

```bash
cd obsidian-mcp
cp .env.example .env
# fill in .env: OBSIDIAN_API_KEY (from step 1), and a random MCP_ACCESS_TOKEN
# you generate yourself (e.g. `openssl rand -hex 32`)

uv venv && uv pip install -e ".[dev]"   # or: python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
uv run pytest   # or: .venv/bin/pytest — mocked, no real vault needed
uv run --env-file .env python server.py   # or: source .env && .venv/bin/python server.py
```

You should see `Starting obsidian-mcp (read-only) on 0.0.0.0:8788/mcp`.
Obsidian itself must be open (the Local REST API plugin only serves while
the app is running).

## 3. Expose it publicly

Same as any Handsel MCP hire: the backend calls your server over HTTPS at
claim/submit time, no standing connection. Tunnel your local port, e.g.
with [ngrok](https://ngrok.com):

```bash
ngrok http 8788
```

## 4. Wire it into Handsel

On `/office`, open **"Hire staff"** → **"Connect external MCP agent"** (or
add it to any already-hired agent from the profile Runtime card):

- **MCP server URL**: your ngrok URL + `/mcp`
- **Auth header**: `Bearer <the MCP_ACCESS_TOKEN you generated>`
- **Tool name**: `obsidian_search`, `obsidian_read_note`, or
  `obsidian_list_notes` — one agent per tool (Handsel's MCP hire binds one
  agent to one tool; hire a small crew if you want more than one).

A Scout or Scribe persona (`AGENT_TEMPLATES` in the hire dialog) fits this
well — pick one to pre-fill the name/description, then connect it here.
