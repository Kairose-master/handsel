# securities-mcp

A small, paper-trading-only MCP server for Handsel's Securities Office
template (`/office` → "Hire a template office"). Two read-only tools backed
by real KIS market data — no tool here can place, modify, or cancel an
order; that capability doesn't exist anywhere in this code, not just in
its prompts.

## Why this exists instead of KIS's own official MCP server

Korea Investment & Securities publishes an official MCP server
([`koreainvestment/open-trading-api`](https://github.com/koreainvestment/open-trading-api),
`MCP/Kis Trading MCP/`). It's the real thing, and worth knowing about — but
its one tool per asset class (`domestic_stock`, `overseas_stock`, …) takes
two structured arguments, `api_type: str` and `params: dict`. Handsel's MCP
worker (`lib/mcp-client.ts`'s `callMcpTool`) always calls a tool with a
single string argument — the job's task text — so it can't drive that
server's schema directly today.

This server instead talks to the same real KIS REST endpoints directly
(`kis_client.py` — endpoint paths, TR IDs, and base URLs copied from KIS's
own official example scripts, not guessed), behind two tools shaped for
Handsel's one-string-argument model:

- **`kis_price_lookup(query)`** — pulls every KRX 6-digit ticker mentioned
  in `query` and returns real current price/volume for each. Feeds the
  **Chart Analyst** role.
- **`kis_account_balance(query)`** — returns your paper account's current
  holdings (`query` is accepted but unused). Feeds the **Rebalance Planner**
  role's "what do I currently hold" context.

Neither tool, and nothing in `kis_client.py`, ever calls an order-placement
endpoint or the real-money host (`openapi.koreainvestment.com:9443`) — the
only base URL defined anywhere in this code is the paper one
(`openapivts.koreainvestment.com:29443`). `test_kis_client.py` checks both
of those as structural invariants, not just behavior.

## 1. Get paper-trading (모의투자) credentials

Real account API keys are **not** what goes here. From
[KIS Developers](https://apiportal.koreainvestment.com):

1. Sign up / log in, then apply for **모의투자 (paper trading)** — a
   separate application from your real account's API access.
2. Once approved, issue a **paper-trading app key/secret pair**
   (separate from any real-account key you may already have).
3. Note your paper account number (형식 12345678-01 — the 8 digits before
   the dash are `CANO`, the 2 after are `ACNT_PRDT_CD`) if you want
   `kis_account_balance` to work — `kis_price_lookup` doesn't need it.

## 2. Run it

```bash
cd securities-mcp
cp .env.example .env
# fill in .env: KIS_PAPER_APP_KEY, KIS_PAPER_APP_SECRET, KIS_PAPER_ACCT_CANO,
# and a random MCP_ACCESS_TOKEN you generate yourself (e.g. `openssl rand -hex 32`)

uv venv && uv pip install -e ".[dev]"   # or: python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
uv run pytest   # or: .venv/bin/pytest — mocked, no network, no real credentials needed
uv run --env-file .env python server.py   # or: source .env && .venv/bin/python server.py
```

You should see `Starting securities-mcp (paper trading only) on 0.0.0.0:8787/mcp`.

## 3. Expose it publicly

Handsel's backend (Vercel) calls your server over HTTPS at claim/submit
time — no standing connection, no polling. It needs a real public URL, so
tunnel your local port, e.g. with [ngrok](https://ngrok.com):

```bash
ngrok http 8787
```

Copy the `https://….ngrok-free.app` URL it prints.

## 4. Wire it into Handsel

On `/office`, open **"Hire a template office"** → **"Connect real market
data"**:

- **MCP server URL**: your ngrok URL + `/mcp` (e.g.
  `https://abcd1234.ngrok-free.app/mcp`)
- **Auth header**: `Bearer <the MCP_ACCESS_TOKEN you generated>`
- **Chart Analyst tool name**: `kis_price_lookup`
- **Rebalance Planner tool name**: `kis_account_balance`
- Leave News Analyst and Quant Modeler blank — neither needs a live data
  tool (see `lib/office-world-data.ts`'s `mcpHint` for each role).

Hiring drafts the delegation plan but does **not** escrow anything —
review the exact subtasks and bounties on `/delegate` before confirming.
