"""
securities-mcp — a tiny MCP server exposing two PAPER-TRADING-ONLY, read-only
KIS market-data tools, shaped for Handsel's single-string-argument MCP worker
model (lib/mcp-client.ts's callMcpTool sends one string argument — the job's
task text — so each tool here takes one `query: str` and does its own
parsing, rather than the multi-argument schema KIS's own official MCP server
uses). See kis_client.py's header for why this exists as its own client
instead of wrapping that server.

Two tools, matching the Securities Office template's two data-consuming
roles (lib/office-world-data.ts's OFFICE_TEMPLATES):
  - kis_price_lookup   → Chart Analyst
  - kis_account_balance → Rebalance Planner (read-only context, never an order)

There is no third tool, and no argument on either of these two reaches an
order-placement endpoint — see kis_client.py, which doesn't define one.

Auth middleware copied from KIS's own official "Kis Trading MCP" server
(module/mcp_auth.py in koreainvestment/open-trading-api) — same Bearer-token
check Handsel's setMcpWorker authHeader already expects.
"""

from __future__ import annotations

import logging
import os

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware, MiddlewareContext

try:
    from fastmcp.server.dependencies import get_http_headers
except ImportError:  # pragma: no cover - older fastmcp fallback
    get_http_headers = None

import kis_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class BearerAuthMiddleware(Middleware):
    def __init__(self, access_token: str):
        self.access_token = access_token

    async def on_request(self, context: MiddlewareContext, call_next):
        if get_http_headers is None:
            raise ToolError("Unauthorized: HTTP authentication is not available")
        headers = get_http_headers(include={"authorization"}) or {}
        auth_header = headers.get("authorization") or headers.get("Authorization", "")
        if auth_header != f"Bearer {self.access_token}":
            raise ToolError("Unauthorized: invalid or missing MCP access token")
        return await call_next(context)


mcp = FastMCP(
    name="securities-mcp",
    instructions=(
        "Paper-trading-only KIS market data for Handsel's Securities Office template. "
        "Read-only: no tool here can place, modify, or cancel an order."
    ),
)


@mcp.tool
def kis_price_lookup(query: str) -> str:
    """Look up current price/volume for every KRX 6-digit ticker mentioned in
    `query` (e.g. "chart analysis for 005930, 000660"). Real paper-account
    market data from KIS — never invented."""
    codes = kis_client.extract_krx_codes(query)
    if not codes:
        return "No KRX 6-digit ticker code found in the query — include one, e.g. 005930 (Samsung Electronics)."

    lines = []
    for code in codes:
        try:
            data = kis_client.inquire_price(code)
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller as text, not swallowed
            lines.append(f"{code}: lookup failed — {exc}")
            continue
        lines.append(
            f"{code} ({data.get('rprs_mrkt_kor_name', '?')}): "
            f"price {data.get('stck_prpr', '?')} KRW, "
            f"change {data.get('prdy_vrss', '?')} ({data.get('prdy_ctrt', '?')}%), "
            f"high {data.get('stck_hgpr', '?')}, low {data.get('stck_lwpr', '?')}, "
            f"volume {data.get('acml_vol', '?')}"
        )
    return "\n".join(lines)


@mcp.tool
def kis_account_balance(query: str) -> str:
    """Current holdings in the configured KIS paper account. `query` is
    accepted for symmetry with Handsel's one-argument tool call but unused —
    this always returns the full paper holdings list. Read-only."""
    del query
    try:
        holdings = kis_client.inquire_balance()
    except Exception as exc:  # noqa: BLE001
        return f"Balance lookup failed — {exc}"
    if not holdings:
        return "No holdings in the paper account."
    lines = [
        f"{h.get('pdno', '?')} {h.get('prdt_name', '?')}: "
        f"qty {h.get('hldg_qty', '?')}, avg cost {h.get('pchs_avg_pric', '?')}, "
        f"current value {h.get('evlu_amt', '?')}"
        for h in holdings
    ]
    return "\n".join(lines)


def main() -> None:
    access_token = os.environ.get("MCP_ACCESS_TOKEN", "").strip()
    if not access_token:
        raise SystemExit("MCP_ACCESS_TOKEN is not set — see securities-mcp/README.md")
    mcp.add_middleware(BearerAuthMiddleware(access_token))

    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "8787"))
    path = os.environ.get("MCP_PATH", "/mcp")
    logging.info("Starting securities-mcp (paper trading only) on %s:%s%s", host, port, path)
    mcp.run(transport="streamable-http", host=host, port=port, path=path)


if __name__ == "__main__":
    main()
