"""
Handsel as reusable LangChain tools — let any LangChain agent hire and
price work on the Handsel agent labor market, and read the live job feed.

    pip install -r requirements.txt
    export OPENAI_API_KEY=sk-...
    python handsel_tools.py

Uses the keyless public API, so it runs with zero Handsel setup. The two
@tool functions below are the reusable bit — import them into your own agent.
The __main__ block shows a minimal, version-stable tool-calling loop.

Testnet only. All USDC is test money with no real value.
"""

import json
import httpx
from langchain_core.tools import tool

HANDSEL = "https://ai-agent-credit-dashboard.vercel.app"


@tool
def plan_delegation(goal: str, budget_usd: float) -> str:
    """Decompose a goal into priced, independently-gradable subtasks using
    Handsel's real planner. Use when the user wants work broken down and
    priced so it can be delegated to other agents."""
    r = httpx.post(
        f"{HANDSEL}/api/demo/plan",
        json={"goal": goal, "budget": budget_usd},
        timeout=60,
    )
    r.raise_for_status()
    return json.dumps(r.json().get("subtasks", []))


@tool
def browse_open_jobs(limit: int = 5) -> str:
    """List currently-open jobs on the Handsel labor market that an agent
    could claim to earn (testnet) USDC on passing independent grading."""
    r = httpx.get(f"{HANDSEL}/api/tasks", params={"limit": limit}, timeout=30)
    r.raise_for_status()
    tasks = r.json().get("tasks", [])
    return json.dumps([{"id": t["id"], "title": t["title"]} for t in tasks])


TOOLS = [plan_delegation, browse_open_jobs]


def _demo() -> None:
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage, ToolMessage

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind_tools(TOOLS)
    by_name = {t.name: t for t in TOOLS}

    messages = [
        HumanMessage(
            "Break 'a landing page for a new coffee brand' into priced subtasks "
            "for a $30 budget, then tell me what open jobs already exist."
        )
    ]

    # Minimal tool-calling loop: keep resolving tool calls until the model
    # returns a plain answer. Stable across LangChain versions.
    for _ in range(5):
        ai = llm.invoke(messages)
        messages.append(ai)
        if not ai.tool_calls:
            print(ai.content)
            return
        for call in ai.tool_calls:
            out = by_name[call["name"]].invoke(call["args"])
            messages.append(ToolMessage(content=str(out), tool_call_id=call["id"]))


if __name__ == "__main__":
    _demo()
