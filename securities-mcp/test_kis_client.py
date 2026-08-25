"""
Pure unit tests — no real credentials, no network. requests.post/get are
mocked; every assertion checks what URL/headers/params kis_client WOULD have
sent, plus a structural invariant: nothing in this module can reach a live
host or an order-placement endpoint, checked by both behavior and source
text so a future edit can't quietly reintroduce either.
"""

from __future__ import annotations

import os
import re
from unittest.mock import MagicMock, patch

import pytest

import kis_client


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("KIS_PAPER_APP_KEY", "test-app-key")
    monkeypatch.setenv("KIS_PAPER_APP_SECRET", "test-app-secret")
    monkeypatch.setenv("KIS_PAPER_ACCT_CANO", "12345678")
    monkeypatch.setenv("KIS_PAPER_ACCT_PRDT_CD", "01")
    kis_client._token_cache["value"] = None
    kis_client._token_cache["expires_at"] = 0.0
    yield


def test_extract_krx_codes_pulls_six_digit_codes_only():
    text = "Look at 005930 and 000660, ignore 12345 and 1234567 and the word two"
    assert kis_client.extract_krx_codes(text) == ["005930", "000660"]


def test_extract_krx_codes_dedupes_preserving_order():
    assert kis_client.extract_krx_codes("005930 then 000660 then 005930 again") == ["005930", "000660"]


def test_extract_krx_codes_empty_when_none_present():
    assert kis_client.extract_krx_codes("no tickers here") == []


def test_missing_env_var_raises_config_error(monkeypatch):
    monkeypatch.delenv("KIS_PAPER_APP_KEY", raising=False)
    with pytest.raises(kis_client.KisConfigError):
        kis_client._env("KIS_PAPER_APP_KEY")


@patch("kis_client.requests.post")
def test_get_access_token_calls_paper_host_only(mock_post):
    mock_post.return_value = MagicMock(
        status_code=200,
        json=lambda: {"access_token": "tok-123", "expires_in": 86400},
    )
    mock_post.return_value.raise_for_status = lambda: None

    token = kis_client._get_access_token()

    assert token == "tok-123"
    called_url = mock_post.call_args.args[0]
    assert called_url == f"{kis_client.PAPER_BASE_URL}/oauth2/tokenP"
    assert "openapivts.koreainvestment.com" in called_url
    assert "openapi.koreainvestment.com:9443" not in called_url  # the real (non-vts) host
    body = mock_post.call_args.kwargs["json"]
    assert body == {"grant_type": "client_credentials", "appkey": "test-app-key", "appsecret": "test-app-secret"}


@patch("kis_client.requests.post")
def test_access_token_is_cached_until_near_expiry(mock_post):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"access_token": "tok-1", "expires_in": 86400})
    mock_post.return_value.raise_for_status = lambda: None

    first = kis_client._get_access_token()
    second = kis_client._get_access_token()

    assert first == second == "tok-1"
    assert mock_post.call_count == 1  # second call served from cache, no re-request


@patch("kis_client.requests.get")
@patch("kis_client.requests.post")
def test_inquire_price_uses_paper_host_and_correct_tr_id(mock_post, mock_get):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"access_token": "tok", "expires_in": 86400})
    mock_post.return_value.raise_for_status = lambda: None
    mock_get.return_value = MagicMock(
        status_code=200,
        json=lambda: {"rt_cd": "0", "output": {"stck_prpr": "70000", "rprs_mrkt_kor_name": "삼성전자"}},
    )
    mock_get.return_value.raise_for_status = lambda: None

    result = kis_client.inquire_price("005930")

    assert result["stck_prpr"] == "70000"
    called_url = mock_get.call_args.args[0]
    assert called_url == f"{kis_client.PAPER_BASE_URL}{kis_client._PRICE_API_PATH}"
    headers = mock_get.call_args.kwargs["headers"]
    assert headers["tr_id"] == kis_client._PRICE_TR_ID
    assert headers["authorization"] == "Bearer tok"
    params = mock_get.call_args.kwargs["params"]
    assert params == {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": "005930"}


@patch("kis_client.requests.get")
@patch("kis_client.requests.post")
def test_inquire_price_raises_on_kis_error_code(mock_post, mock_get):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"access_token": "tok", "expires_in": 86400})
    mock_post.return_value.raise_for_status = lambda: None
    mock_get.return_value = MagicMock(status_code=200, json=lambda: {"rt_cd": "1", "msg1": "bad code"})
    mock_get.return_value.raise_for_status = lambda: None

    with pytest.raises(RuntimeError, match="bad code"):
        kis_client.inquire_price("000000")


@patch("kis_client.requests.get")
@patch("kis_client.requests.post")
def test_inquire_balance_uses_paper_tr_id_never_real(mock_post, mock_get):
    mock_post.return_value = MagicMock(status_code=200, json=lambda: {"access_token": "tok", "expires_in": 86400})
    mock_post.return_value.raise_for_status = lambda: None
    mock_get.return_value = MagicMock(
        status_code=200,
        json=lambda: {"rt_cd": "0", "output1": [{"pdno": "005930", "hldg_qty": "10"}]},
    )
    mock_get.return_value.raise_for_status = lambda: None

    result = kis_client.inquire_balance()

    assert result == [{"pdno": "005930", "hldg_qty": "10"}]
    headers = mock_get.call_args.kwargs["headers"]
    assert headers["tr_id"] == "VTTC8434R"  # paper TR id
    assert headers["tr_id"] != "TTTC8434R"  # never the real-account TR id
    params = mock_get.call_args.kwargs["params"]
    assert params["CANO"] == "12345678"
    assert params["ACNT_PRDT_CD"] == "01"


def test_no_live_trading_host_constant_anywhere_in_this_module():
    source = open(os.path.join(os.path.dirname(__file__), "kis_client.py"), encoding="utf-8").read()
    assert "openapi.koreainvestment.com:9443" not in source  # the real (non-paper) KIS host
    assert source.count("PAPER_BASE_URL = ") == 1  # exactly one base URL constant, ever


def test_no_order_placement_capability_anywhere_in_this_module():
    source = open(os.path.join(os.path.dirname(__file__), "kis_client.py"), encoding="utf-8").read()
    for banned in ("trading/order", "def place_order", "def cancel_order", "def modify_order"):
        assert banned not in source


def test_server_exposes_exactly_two_tools_neither_defining_an_order_function():
    source = open(os.path.join(os.path.dirname(__file__), "server.py"), encoding="utf-8").read()
    assert source.count("@mcp.tool") == 2
    assert "def kis_price_lookup" in source
    assert "def kis_account_balance" in source
    assert not re.search(r"def \w*order\w*\(", source)  # no order/cancel/modify-order function, ever
