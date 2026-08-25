"""
A minimal client for the "Local REST API" Obsidian community plugin
(https://github.com/coddingtonbear/obsidian-local-rest-api) — READ ONLY.

This talks to the plugin's own REST endpoints directly rather than wrapping
an existing MCP server, for the same reason securities-mcp/kis_client.py
does: the two real, popular Obsidian MCP servers checked before writing
this file each have a shape Handsel's single-string-argument MCP worker
model (lib/mcp-client.ts's callMcpTool) can't drive —
MarkusPfundstein/mcp-obsidian has clean single-string tool schemas but only
runs over stdio (no remote HTTP endpoint for Handsel to call); aaronsb/
obsidian-mcp-plugin serves real HTTP but consolidates everything behind an
`action`-discriminator argument, the same multi-argument shape the KIS
Trading MCP server had. The Local REST API plugin underneath both of them
is the stable, well-documented interface either way, so this talks to it
directly.

Endpoint paths, auth scheme, and default ports below are copied from that
plugin's own OpenAPI spec and the mcp-obsidian client's real request code,
not guessed. `verify=False` matches upstream: the plugin generates a
self-signed cert for its local HTTPS port on first run, and this only ever
talks to 127.0.0.1 (or wherever you point OBSIDIAN_HOST — your own
machine), never a public endpoint — that's what makes skipping cert
verification the plugin's OWN documented default here, not a general
"skip TLS" shortcut.

Deliberately READ ONLY: no write/append/patch/delete function exists in
this file, even though the real plugin supports them. Same reasoning as
lib/kis-orders.ts staying outside the MCP-tool pipeline — anything with a
side effect on your vault shouldn't be reachable by Handsel's autonomous
job-claiming loop through a single free-text argument.
"""

from __future__ import annotations

import os

import requests


def _base_url() -> str:
    protocol = os.environ.get('OBSIDIAN_PROTOCOL', 'https').strip().lower()
    protocol = 'http' if protocol == 'http' else 'https'
    host = os.environ.get('OBSIDIAN_HOST', '127.0.0.1').strip()
    port = os.environ.get('OBSIDIAN_PORT', '27124' if protocol == 'https' else '27123').strip()
    return f'{protocol}://{host}:{port}'


def _api_key() -> str:
    key = os.environ.get('OBSIDIAN_API_KEY', '').strip()
    if not key:
        raise RuntimeError('OBSIDIAN_API_KEY is not set — see obsidian-mcp/README.md')
    return key


def _headers() -> dict:
    return {'Authorization': f'Bearer {_api_key()}'}


def list_notes(dirpath: str = '') -> list[str]:
    """Files in the vault root, or in `dirpath` if given (vault-relative,
    no leading slash — e.g. "Projects/Handsel")."""
    dirpath = dirpath.strip().strip('/')
    url = f"{_base_url()}/vault/{dirpath + '/' if dirpath else ''}"
    res = requests.get(url, headers=_headers(), verify=False, timeout=(3, 6))
    res.raise_for_status()
    return res.json().get('files', [])


def read_note(filepath: str) -> str:
    """Raw markdown content of one note (vault-relative path, e.g.
    "Projects/Handsel/roadmap.md")."""
    filepath = filepath.strip().lstrip('/')
    if not filepath:
        raise ValueError('filepath is required')
    url = f"{_base_url()}/vault/{filepath}"
    res = requests.get(url, headers=_headers(), verify=False, timeout=(3, 6))
    res.raise_for_status()
    return res.text


def search_notes(query: str, context_length: int = 100) -> list[dict]:
    """Simple full-text search across the vault. Each result: filename,
    score, and matches (each with the surrounding context string)."""
    if not query.strip():
        raise ValueError('query is required')
    url = f"{_base_url()}/search/simple/"
    params = {'query': query, 'contextLength': context_length}
    res = requests.post(url, headers=_headers(), params=params, verify=False, timeout=(3, 6))
    res.raise_for_status()
    return res.json()
