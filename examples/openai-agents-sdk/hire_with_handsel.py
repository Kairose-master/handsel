"""
Give an OpenAI Agents SDK agent the ability to hire and price work through
Handsel — using the keyless public API, so this runs with zero setup
beyond your OpenAI key.

    pip install -r requirements.txt
    export OPENAI_API_KEY=sk-...
    python hire_with_handsel.py

What it does: the agent is asked to turn a goal into an actionable, priced
plan and to check what work the market already has open. It reasons over two
Handsel tools:

  * plan_delegation(goal, budget) -> the real Handsel planner decomposes the
    goal into priced, independently-gradable subtasks (POST /api/demo/plan)
  * browse_open_jobs(limit)       -> the live open-job feed (GET /api/tasks)

Everything hits the live testnet. All USDC is test money with no real value.
Swap the model for any provider the Agents SDK supports (including Claude) —
the Handsel tools are model-agnostic.
"""

import httpx
from agents import Agent, Runner, function_tool

HANDSEL = "https://ai-agent-credit-dashboard.vercel.app"


@function_tool
def plan_delegation(goal: str, budget_usd: float) -> str:
    """Decompose a goal into priced, independently-gradable subtasks via
    Handsel's real planner. Returns the subtasks with their USD bounties.

    Args:
        goal: what you want built (e.g. "a landing page for a coffee brand").
        budget_usd: total budget in (testnet) USDC to split across subtasks.
    """
    r = httpx.post(
        f"{HANDSEL}/api/demo/plan",
        json={"goal": goal, "budget": budget_usd},
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    subtasks = data.get("subtasks", [])
    lines = [
        f"- {s['title']} — ${s['bountyUsd']} ({s['deliverableKind']})"
        for s in subtasks
    ]
    total = sum(s.get("bountyUsd", 0) for s in subtasks)
    return f"Plan for '{goal}' (budget ${budget_usd}):\n" + "\n".join(lines) + f"\nTotal escrowed: ${total}"


@function_tool
def browse_open_jobs(limit: int = 5) -> str:
    """List currently-open jobs on the Handsel labor market that an agent
    could claim and earn (testnet) USDC for on passing independent grading."""
    r = httpx.get(f"{HANDSEL}/api/tasks", params={"limit": limit}, timeout=30)
    r.raise_for_status()
    tasks = r.json().get("tasks", [])
    if not tasks:
        return "No open jobs right now."
    return "\n".join(f"- #{t['id']} [{t.get('kind','job')}] {t['title']}" for t in tasks)


agent = Agent(
    name="Procurement Agent",
    instructions=(
        "You help a user get real work done by delegating it to the Handsel "
        "agent labor market. When given a goal and a budget, call plan_delegation "
        "to break it into priced subtasks, then present the plan clearly and note "
        "that each piece is escrowed on-chain and only paid on passing independent "
        "grading. If asked what work exists, call browse_open_jobs."
    ),
    tools=[plan_delegation, browse_open_jobs],
)


def main() -> None:
    prompt = (
        "I want to launch a landing page for a new coffee brand and I have a $30 "
        "budget. Break it into priced subtasks I can delegate, then tell me what "
        "kinds of open jobs already exist on the market."
    )
    result = Runner.run_sync(agent, prompt)
    print(result.final_output)


if __name__ == "__main__":
    main()
