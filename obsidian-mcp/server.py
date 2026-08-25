"""
obsidian-mcp — a tiny, READ-ONLY MCP server exposing your Obsidian vault
(via the "Local REST API" community plugin) as three single-string-argument
tools, shaped for Handsel's MCP worker model. See obsidian_client.py's
header for why this talks to that plugin's REST API directly instead of
wrapping one of the two popular Obsidian MCP servers checked before writing
this file.

Three tools:
  - obsidian_search      -> full-text search across the vault
  - obsidian_read_note    -> raw content of one note by vault-relative path
  - obsidian_list_notes   -> files in the vault root or one directory

No write/append/delete tool exists here — read only, on purpose (see
obsidian_client.py). Auth middleware copied from securities-mcp/server.py,
which copied it from KIS's own official MCP server — same Bearer-token
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

import obsidian_client

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
    name="obsidian-mcp",
    instructions=(
        "Read-only access to one Obsidian vault via the Local REST API plugin. "
        "No tool here can create, edit, or delete a note."
    ),
)


@mcp.tool
def obsidian_search(query: str) -> str:
    """Full-text search across the vault for `query`. Returns each matching
    file with its relevance score and the surrounding text of each match."""
    try:
        results = obsidian_client.search_notes(query)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller, not swallowed
        return f"Search failed — {exc}"
    if not results:
        return f'No notes matched "{query}".'
    lines = []
    for r in results:
        lines.append(f"{r.get('filename', '?')} (score {r.get('score', '?')})")
        for m in r.get('matches', [])[:3]:
            lines.append(f"  … {m.get('context', '').strip()} …")
    return "\n".join(lines)


@mcp.tool
def obsidian_read_note(query: str) -> str:
    """Raw markdown content of one note. `query` is the vault-relative path,
    e.g. "Projects/Handsel/roadmap.md" — use obsidian_search or
    obsidian_list_notes first if you don't already know the exact path."""
    try:
        return obsidian_client.read_note(query)
    except Exception as exc:  # noqa: BLE001
        return f"Could not read \"{query}\" — {exc}"


@mcp.tool
def obsidian_list_notes(query: str) -> str:
    """Files in the vault root, or in one directory if `query` names a
    vault-relative directory path (e.g. "Projects/Handsel"). Empty string
    lists the root."""
    try:
        files = obsidian_client.list_notes(query)
    except Exception as exc:  # noqa: BLE001
        return f"Could not list \"{query or '(root)'}\" — {exc}"
    return "\n".join(files) if files else f"No files in \"{query or '(root)'}\"."


def main() -> None:
    access_token = os.environ.get("MCP_ACCESS_TOKEN", "").strip()
    if not access_token:
        raise SystemExit("MCP_ACCESS_TOKEN is not set — see obsidian-mcp/README.md")
    mcp.add_middleware(BearerAuthMiddleware(access_token))

    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "8788"))
    path = os.environ.get("MCP_PATH", "/mcp")
    logging.info("Starting obsidian-mcp (read-only) on %s:%s%s", host, port, path)
    mcp.run(transport="streamable-http", host=host, port=port, path=path)


if __name__ == "__main__":
    main()
