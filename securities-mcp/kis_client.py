"""
A minimal REST client for Korea Investment & Securities (KIS) Open API —
PAPER TRADING (모의투자) ONLY.

This is deliberately its own small client, not a wrapper around KIS's
official "Kis Trading MCP" server (koreainvestment/open-trading-api,
MCP/Kis Trading MCP/). That server's one registered tool per asset class
takes two structured arguments (api_type: str, params: dict) — Handsel's
MCP worker model (lib/mcp-client.ts's callMcpTool) calls a tool with a
single string argument (the job's task text), so it can't drive that
server's schema directly. This client instead talks to the same real KIS
REST endpoints directly, behind the two single-string tools in server.py
that Handsel's model expects.

Endpoint paths, TR IDs, and base URLs below are copied from KIS's own
official example scripts (examples_llm/kis_auth.py, examples_llm/
domestic_stock/inquire_price/, examples_llm/domestic_stock/inquire_balance/
in koreainvestment/open-trading-api), not guessed.

PAPER_BASE_URL is the only base URL defined anywhere in this file. There is
no live/real host constant, no order-placement endpoint, and no code path
that could reach either — not "off by default," physically absent.
"""

from __future__ import annotations

import os
import re
import time

import requests

PAPER_BASE_URL = "https://openapivts.koreainvestment.com:29443"

_PRICE_API_PATH = "/uapi/domestic-stock/v1/quotations/inquire-price"
_PRICE_TR_ID = "FHKST01010100"  # same TR id for real and paper (KIS quirk)

_BALANCE_API_PATH = "/uapi/domestic-stock/v1/trading/inquire-balance"
_BALANCE_TR_ID = "VTTC8434R"  # paper-mode TR id (real mode uses TTTC8434R — never used here)

KRX_CODE_RE = re.compile(r"\b\d{6}\b")

_token_cache: dict[str, object] = {"value": None, "expires_at": 0.0}


class KisConfigError(RuntimeError):
    """Required env var missing — never a placeholder, never a guessed default."""


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise KisConfigError(f"{name} is not set — see securities-mcp/README.md")
    return value


def _get_access_token() -> str:
    """Client-credentials token exchange, cached in-process until ~60s before
    expiry. KIS issues a token valid ~24h and asks callers not to re-request
    one within 6h of the last issue, so caching is not an optimization here —
    it's what the API expects."""
    cached = _token_cache["value"]
    if cached and time.time() < float(_token_cache["expires_at"]):
        return cached  # type: ignore[return-value]

    app_key = _env("KIS_PAPER_APP_KEY")
    app_secret = _env("KIS_PAPER_APP_SECRET")

    res = requests.post(
        f"{PAPER_BASE_URL}/oauth2/tokenP",
        json={"grant_type": "client_credentials", "appkey": app_key, "appsecret": app_secret},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    res.raise_for_status()
    body = res.json()
    token = body["access_token"]
    expires_in = float(body.get("expires_in", 86400))
    _token_cache["value"] = token
    _token_cache["expires_at"] = time.time() + expires_in - 60
    return token


def _headers(tr_id: str, extra: dict | None = None) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/plain",
        "charset": "UTF-8",
        "authorization": f"Bearer {_get_access_token()}",
        "appkey": _env("KIS_PAPER_APP_KEY"),
        "appsecret": _env("KIS_PAPER_APP_SECRET"),
        "tr_id": tr_id,
        "custtype": "P",
    }
    if extra:
        headers.update(extra)
    return headers


def extract_krx_codes(text: str) -> list[str]:
    """Every distinct 6-digit KRX ticker mentioned in freeform text, in the
    order they first appear. This is how the single-string MCP tools below
    turn a job's task description into concrete tickers to look up."""
    seen: list[str] = []
    for code in KRX_CODE_RE.findall(text):
        if code not in seen:
            seen.append(code)
    return seen


def inquire_price(krx_code: str) -> dict:
    """Current price/volume snapshot for one KRX 6-digit code. Paper-mode
    quotes — KIS serves the same real market data to paper accounts, just
    against a paper order book (irrelevant here since we never place orders)."""
    res = requests.get(
        f"{PAPER_BASE_URL}{_PRICE_API_PATH}",
        headers=_headers(_PRICE_TR_ID),
        params={"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": krx_code},
        timeout=15,
    )
    res.raise_for_status()
    body = res.json()
    if body.get("rt_cd") != "0":
        raise RuntimeError(f"KIS inquire-price error for {krx_code}: {body.get('msg1', body)}")
    return body.get("output", {})


def inquire_balance() -> list[dict]:
    """Current paper-account holdings. Read-only — there is no function in
    this file that places, modifies, or cancels an order."""
    cano = _env("KIS_PAPER_ACCT_CANO")
    prdt_cd = os.environ.get("KIS_PAPER_ACCT_PRDT_CD", "01").strip() or "01"
    res = requests.get(
        f"{PAPER_BASE_URL}{_BALANCE_API_PATH}",
        headers=_headers(_BALANCE_TR_ID),
        params={
            "CANO": cano,
            "ACNT_PRDT_CD": prdt_cd,
            "AFHR_FLPR_YN": "N",
            "OFL_YN": "",
            "INQR_DVSN": "02",
            "UNPR_DVSN": "01",
            "FUND_STTL_ICLD_YN": "N",
            "FNCG_AMT_AUTO_RDPT_YN": "N",
            "PRCS_DVSN": "01",
            "CTX_AREA_FK100": "",
            "CTX_AREA_NK100": "",
        },
        timeout=15,
    )
    res.raise_for_status()
    body = res.json()
    if body.get("rt_cd") != "0":
        raise RuntimeError(f"KIS inquire-balance error: {body.get('msg1', body)}")
    return body.get("output1", [])
