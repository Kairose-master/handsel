"""
Pure unit tests — no real Obsidian vault, no network. requests.get/post are
mocked; assertions check what URL/headers/params obsidian_client WOULD have
sent, plus structural invariants: no write/delete capability exists in this
module, checked against the source text so a future edit can't quietly
reintroduce one.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

import obsidian_client


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OBSIDIAN_API_KEY", "test-key")
    monkeypatch.delenv("OBSIDIAN_PROTOCOL", raising=False)
    monkeypatch.delenv("OBSIDIAN_HOST", raising=False)
    monkeypatch.delenv("OBSIDIAN_PORT", raising=False)
    yield


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("OBSIDIAN_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OBSIDIAN_API_KEY"):
        obsidian_client._api_key()


def test_base_url_defaults_to_https_local_27124():
    assert obsidian_client._base_url() == "https://127.0.0.1:27124"


def test_base_url_respects_env_overrides(monkeypatch):
    monkeypatch.setenv("OBSIDIAN_PROTOCOL", "http")
    monkeypatch.setenv("OBSIDIAN_HOST", "192.168.1.50")
    monkeypatch.setenv("OBSIDIAN_PORT", "27123")
    assert obsidian_client._base_url() == "http://192.168.1.50:27123"


def test_base_url_rejects_unknown_protocol_by_defaulting_to_https(monkeypatch):
    monkeypatch.setenv("OBSIDIAN_PROTOCOL", "ftp")
    assert obsidian_client._base_url().startswith("https://")


@patch("obsidian_client.requests.get")
def test_list_notes_root(mock_get):
    mock_get.return_value = MagicMock(status_code=200, json=lambda: {"files": ["a.md", "b.md"]})
    mock_get.return_value.raise_for_status = lambda: None

    result = obsidian_client.list_notes()

    assert result == ["a.md", "b.md"]
    assert mock_get.call_args.args[0] == "https://127.0.0.1:27124/vault/"
    assert mock_get.call_args.kwargs["verify"] is False
    assert mock_get.call_args.kwargs["headers"] == {"Authorization": "Bearer test-key"}


@patch("obsidian_client.requests.get")
def test_list_notes_directory_strips_slashes(mock_get):
    mock_get.return_value = MagicMock(status_code=200, json=lambda: {"files": ["c.md"]})
    mock_get.return_value.raise_for_status = lambda: None

    obsidian_client.list_notes("/Projects/Handsel/")

    assert mock_get.call_args.args[0] == "https://127.0.0.1:27124/vault/Projects/Handsel/"


@patch("obsidian_client.requests.get")
def test_read_note_returns_raw_text(mock_get):
    mock_get.return_value = MagicMock(status_code=200, text="# Hello\n\nBody text.")
    mock_get.return_value.raise_for_status = lambda: None

    result = obsidian_client.read_note("Projects/Handsel/roadmap.md")

    assert result == "# Hello\n\nBody text."
    assert mock_get.call_args.args[0] == "https://127.0.0.1:27124/vault/Projects/Handsel/roadmap.md"


def test_read_note_rejects_empty_path():
    with pytest.raises(ValueError, match="filepath"):
        obsidian_client.read_note("   ")


@patch("obsidian_client.requests.post")
def test_search_notes_sends_query_and_context_length(mock_post):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: [{"filename": "a.md", "score": 1.0, "matches": []}])
    mock_post.return_value.raise_for_status = lambda: None

    result = obsidian_client.search_notes("credit score", context_length=50)

    assert result == [{"filename": "a.md", "score": 1.0, "matches": []}]
    assert mock_post.call_args.args[0] == "https://127.0.0.1:27124/search/simple/"
    assert mock_post.call_args.kwargs["params"] == {"query": "credit score", "contextLength": 50}


def test_search_notes_rejects_empty_query():
    with pytest.raises(ValueError, match="query"):
        obsidian_client.search_notes("   ")


def test_no_write_or_delete_capability_anywhere_in_this_module():
    source = open(os.path.join(os.path.dirname(__file__), "obsidian_client.py"), encoding="utf-8").read()
    for banned in ("requests.put", "requests.delete", "requests.patch", "def write_note", "def delete_note", "def append_note"):
        assert banned not in source


def test_server_exposes_exactly_three_read_only_tools():
    source = open(os.path.join(os.path.dirname(__file__), "server.py"), encoding="utf-8").read()
    assert source.count("@mcp.tool") == 3
    for name in ("def obsidian_search", "def obsidian_read_note", "def obsidian_list_notes"):
        assert name in source
    for banned in ("def obsidian_write", "def obsidian_delete", "def obsidian_append", "def obsidian_patch"):
        assert banned not in source
