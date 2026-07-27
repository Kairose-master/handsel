"""FastAPI surface of the agent runtime.

The runtime is a stateless execution service. To avoid holding a request open
for the multi-minute duration of an agent run (which would trip the caller's
serverless function timeout), /run is asynchronous:

    Next.js POST /run  ──▶  202 accepted (returns immediately)
                              │  (background thread)
                              ▼
    run agent workflow ──▶  POST callback_url with events + result

Both directions are authenticated with a shared secret (X-Runtime-Secret).
"""
from __future__ import annotations

import base64
import threading

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import config
from .graph import run_task
from .tools import execute_python

app = FastAPI(title="AI Agent Runtime", version="0.2.0")


class RunRequest(BaseModel):
    agent_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    task: str = Field(min_length=1, max_length=4000)
    callback_url: str = Field(min_length=1)
    # BYOK: the requesting user's own Anthropic key. Optional — without it the
    # runtime bills its own ANTHROPIC_API_KEY. Never logged.
    api_key: str | None = None


class GradeRequest(BaseModel):
    solution_code: str = Field(min_length=1, max_length=50_000)
    test_code: str = Field(min_length=1, max_length=20_000)


def _require_secret(provided: str | None) -> None:
    """Enforce the shared secret when one is configured."""
    if config.RUNTIME_SHARED_SECRET and provided != config.RUNTIME_SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing runtime secret")


def _process(request: RunRequest) -> None:
    """Run the agent, then report the outcome back to the caller."""
    # The wallet/progress APIs live at the same origin as the callback
    # endpoint (.../api/runtime/callback); the messages API is a sibling of
    # /api/runtime, not under it (.../api/agents/messages), so it's derived
    # from the shared /api root rather than from the /api/runtime origin.
    origin = request.callback_url.rsplit("/", 1)[0]
    api_root = request.callback_url.removesuffix("/runtime/callback")
    result = run_task(
        request.agent_id,
        request.task_id,
        request.task,
        api_key=request.api_key,
        wallet_api=origin + "/wallet",
        progress_url=origin + "/progress",
        messages_api=api_root + "/agents/messages",
    )
    payload = {"task_id": request.task_id, "agent_id": request.agent_id, **result}
    headers = {"Content-Type": "application/json"}
    if config.RUNTIME_SHARED_SECRET:
        headers["X-Runtime-Secret"] = config.RUNTIME_SHARED_SECRET
    try:
        httpx.post(request.callback_url, json=payload, headers=headers, timeout=30)
    except Exception as exc:  # the run is done; only delivery failed
        print(f"[runtime] callback to {request.callback_url} failed: {exc}", flush=True)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": config.ANTHROPIC_MODEL}


@app.post("/run", status_code=202)
def run(request: RunRequest, x_runtime_secret: str | None = Header(default=None)) -> dict:
    _require_secret(x_runtime_secret)
    threading.Thread(target=_process, args=(request,), daemon=True).start()
    return {"status": "accepted", "task_id": request.task_id}


_GRADE_MARKER = "___HANDSEL_GRADE_RESULT___"


def _build_grading_script(solution_code: str, test_code: str) -> str:
    """Wrap solution + test code so a premature process exit — anywhere in
    either phase — can never be mistaken for a passing verdict.

    The naive version of this (`solution_code + "\\n" + test_code` run as
    one top-level script, judged by the process's exit code) is directly
    exploitable: a submission ending in `sys.exit(0)` / `quit()` /
    `os._exit(0)` — accidental (models sometimes emit a demo `if __name__
    == "__main__": sys.exit(main())` block) or deliberate — short-circuits
    the test code before a single assert runs, while the subprocess still
    exits 0. Since a passing verdict now auto-releases real escrow (see
    autoApprovePassedJob in app/api/runtime/callback/route.ts), "exit code
    0" being forgeable by the exact code under test is a real exploit, not
    a style nit.

    Fix: run each phase in its own try/except that explicitly catches
    SystemExit (sys.exit()/quit()) alongside ordinary exceptions, and only
    print an unguessable marker line after BOTH phases have provably run
    to completion. The caller trusts the PRESENCE of that exact marker in
    stdout, never the bare exit code — os._exit()/a kill signal skip
    Python's exception handling entirely, but they also skip ever
    reaching the print, so the caller still (correctly) reads that as a
    failure. Source is base64-embedded to sidestep any quote/backslash
    escaping bugs from splicing arbitrary submitted code into a script.
    """
    solution_b64 = base64.b64encode(solution_code.encode("utf-8")).decode("ascii")
    test_b64 = base64.b64encode(test_code.encode("utf-8")).decode("ascii")
    return f'''
import base64, sys

_ns = {{}}
_solution_src = base64.b64decode("{solution_b64}").decode("utf-8")
_test_src = base64.b64decode("{test_b64}").decode("utf-8")

def _run():
    try:
        exec(compile(_solution_src, "<solution>", "exec"), _ns)
    except SystemExit:
        print("[grading] solution code exited early (sys.exit/quit) — treated as failing", file=sys.stderr)
        return False
    except BaseException as exc:
        print(f"[grading] solution raised {{type(exc).__name__}}: {{exc}}", file=sys.stderr)
        return False
    try:
        exec(compile(_test_src, "<tests>", "exec"), _ns)
    except SystemExit:
        print("[grading] test code exited early (sys.exit/quit) — treated as failing", file=sys.stderr)
        return False
    except BaseException as exc:
        print(f"[grading] {{type(exc).__name__}}: {{exc}}", file=sys.stderr)
        return False
    return True

_passed = _run()
sys.stdout.flush()
print("{_GRADE_MARKER}" + ("PASS" if _passed else "FAIL"))
sys.exit(0 if _passed else 1)
'''


@app.post("/grade")
def grade(request: GradeRequest, x_runtime_secret: str | None = Header(default=None)) -> dict:
    """Run a submitted solution against requester-authored acceptance tests.

    Grader ≠ solver: this always executes on the PLATFORM's runtime — even
    when the work was produced by a user's BYO webhook agent — so a worker
    can't grade its own homework. Synchronous (sandbox has a 10s cap).

    Passed is decided by the presence of the marker _build_grading_script
    prints, never by the bare subprocess exit code — see that function's
    docstring for why the exit code alone is forgeable by the submission
    under test.
    """
    _require_secret(x_runtime_secret)
    script = _build_grading_script(request.solution_code, request.test_code)
    _exit_ok, output = execute_python(script)
    passed = f"{_GRADE_MARKER}PASS" in output
    return {"passed": passed, "output": output[:4000]}
