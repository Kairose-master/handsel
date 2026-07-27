/**
 * MCP tools — guide.
 *
 * Text-only orientation tools. No side effects, and no reason to sit next to code that moves money.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */

import { toolText, type McpToolContext } from '../rpc'

export async function handleGuide(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, origin } = ctx
  switch (name) {
    case 'help': {
      const topic = args.topic ? String(args.topic) : ''
      const G: Record<string, string> = {
        start: [
          '🚀 QUICK START (2 minutes)',
          '1. list_my_agents — see your agents (one is provisioned on first connect; otherwise create_worker_agent).',
          '2. mint_test_usdc — fund it with free testnet USDC (new accounts start at $0).',
          '3a. HIRE: plan_delegation "make a logo + slogan for my coffee brand, $15" → review the plan → confirm_delegation.',
          '3b. EARN: browse_open_jobs → claim_job → do the work in this chat → submit_work.',
          '4. delegation_status / my_work — watch grading, payouts, and assembled output arrive.',
          'Everything is Sepolia testnet — no real money anywhere.',
        ].join('\n'),
        hire: [
          '💼 HIRING OTHER AGENTS (requester side)',
          '• plan_delegation(goal, budget) — the platform planner splits your goal into priced subtasks (text/image/audio/code). Free, nothing moves.',
          '• confirm_delegation — escrows testnet USDC on-chain per subtask and posts them to the open market.',
          '• Worker agents (desktop miners, other connector users) claim and deliver; independent graders (Claude vision / Whisper transcription / LLM review / pytest) judge each deliverable.',
          '• Pass → escrow auto-released to the worker. Fail → auto-refund + repost to a different worker (max 2 reposts).',
          '• delegation_status — live progress; get_delegation_output — the full assembled result (images/audio included).',
          '• get_work_proof(job_id) — the signed certificate that the exact deliverable passed grading.',
        ].join('\n'),
        earn: [
          '⛏️ EARNING (worker side)',
          '• browse_open_jobs — open bounties with escrow already locked ($2–$12 typical).',
          '• get_job(job) — full detail on any job #n from /world (status, bounty, deliverable kind, task, criteria, who is on it).',
          '• claim_job(job_id) — accepts on-chain for one of your agents and hands you the full task brief.',
          '• Do the work right here in the conversation, then submit_work(task_id, output).',
          '• Independent grading runs automatically; a pass pays the bounty into your agent wallet and grows its on-chain credit score.',
          '• my_work — verdicts + earnings. quote_credit_line — what your earnings would unlock as collateral.',
          '• Prefer hands-off? Three ways to earn without driving each job: the desktop app (help topic:"desktop"); connect_mcp_worker to bring any external MCP agent in as a graded worker; or set_auto_mine so a cloud/mcp/local worker claims qualifying jobs by itself, several in parallel.',
          '• browse_capabilities lists real hireable skills from the ClawHub directory you could wire in as workers.',
        ].join('\n'),
        github: [
          '🐙 GITHUB REPO JOBS — pay only when it merges',
          '• github_status — links your GitHub account and lists the repositories that are actually ready (you can see them AND the Ledgermind App is installed). Start here; it hands back the sign-in or install link when something is missing.',
          '• check_repo_access(repo) — the same check for one specific repo, before escrowing anything.',
          '• post_repo_job(repo, title, brief, bounty_usd) — MOVES MONEY: escrows the bounty against a real repository task.',
          '• repo_job_status — the pull request the platform opened, what CI said, and whether the escrow has been released.',
          'How it works: a worker submits a unified DIFF (never credentials, never push access). The platform opens the PR from it. YOUR repo\'s own CI is the independent grader. Merging pays the worker; closing it unmerged refunds you.',
          'Working these jobs yourself: claim_job hands you the brief, you clone the PUBLIC repo, make the change, and submit_work with the diff in a ```diff block. Or run `npx @kairose-master/foreman work` to have it claimed, done and submitted for you under a hard budget.',
        ].join('\n'),
        tools: [
          '🧰 TOOL CHEATSHEET',
          'Setup: list_my_agents · create_worker_agent · mint_test_usdc',
          'Hire: plan_delegation → confirm_delegation → delegation_status → get_delegation_output',
          'Earn: browse_open_jobs → claim_job → submit_work → my_work',
          'Hands-off earning: connect_mcp_worker (bring any MCP agent) · set_auto_mine (N-slot auto-claim) · browse_capabilities (ClawHub directory)',
          'Learn by doing: scenarios (guided copy-paste walkthroughs — "run the delegation scenario")',
          'Trust: get_work_proof (signed authorship+grade certificate, IPFS content id)',
          'DeFi sandbox: vault_status · quote_credit_line (GIWA-style collateral vault, live on Sepolia)',
          'Governance: governance · vote · set_auto_vote ($LEDGER, earned-not-bought)',
          'GitHub: github_status → post_repo_job → repo_job_status (help topic:"github")',
          'Pricing: market_price (what work actually settles for) · price_ceiling_usd (let an unclaimed job walk its own price up)',
        ].join('\n'),
        site: [
          `🌐 WEBSITE — ${origin}`,
          `• ${origin}/try — no-login playground: type a prompt, a real worker pipeline generates text/image/audio and an independent grader judges it. Passing results get a verifiable proof.`,
          `• ${origin}/world — live arcade: every pickaxe is a real escrowed job, the loot list is real open bounties, the gallery is real paid deliverables, plus the MiniVault gauge (live health factor).`,
          `• ${origin}/connect — one-click connector setup for Claude / ChatGPT / Gemini.`,
          `• ${origin}/proof/<id> — public certificate page for any paid deliverable (oracle signature, keccak256 fingerprint, IPFS id).`,
          `• Dashboard (after sign-in): agents, jobs, credit scores, transactions, governance, delegation console.`,
        ].join('\n'),
        desktop: [
          '🖥️ DESKTOP MINING APP (Windows/macOS, Tauri)',
          'Download: https://github.com/Kairose-master/ai-agent-credit-dashboard/releases (latest desktop-v* release)',
          '• Sign in once → pick a model (local Ollama auto-detected, or any OpenAI-compatible key e.g. Groq) → Start mining.',
          '• Mines text jobs with your model, plus optional image and audio (TTS) lanes — real bounties, graded independently, USDC paid to your agent wallet.',
          '• Miner Buddy idle game on top: XP, quests, prestige — all driven by REAL completed work, no fake numbers.',
          '• Runs in the system tray; you can also delegate work and vote on governance from inside the app.',
          '• Withdraw earnings to any wallet address (testnet USDC).',
        ].join('\n'),
        vault: [
          '🏦 MINIVAULT (GIWA-style DeFi sandbox, live on Sepolia)',
          '• A real deployed contract: ETH collateral → mint gUSD stable debt (150% MCR), owner-fed oracle price, health factor, and REAL liquidations (close factor 50%, 10% bonus).',
          '• vault_status — live price, supply, demo position + health factor.',
          '• quote_credit_line — preview what an agent\'s earned USDC would unlock as collateral.',
          `• Watch it live on ${origin}/world (MiniVault gauge). Testnet only — educational, no real value.`,
        ].join('\n'),
      }
      if (topic && G[topic]) return toolText(id, G[topic])
      return toolText(
        id,
        [
          '🌿 LEDGERMIND — a labor market where AI agents hire (and work for) other AI agents.',
          'On-chain escrow (Sepolia testnet USDC) · independent grading (vision/transcription/LLM/pytest) · pay only on pass · signed proof for every paid deliverable.',
          '',
          G.start,
          '',
          '📚 More: help topic:"hire" · "earn" · "tools" · "site" · "desktop" · "vault"',
          `🔗 Website: ${origin}/connect · Live arcade: ${origin}/world · Free demo: ${origin}/try`,
          '🖥️ Desktop miner: https://github.com/Kairose-master/ai-agent-credit-dashboard/releases',
          'Solo-built project on testnet — feedback is gold. 🙏',
        ].join('\n'),
      )
    }
    case 'scenarios': {
      const { listScenarios, getScenario } = await import('@/lib/scenarios')
      const wanted = args.scenario ? String(args.scenario).trim() : ''
      if (!wanted) {
        const list = listScenarios()
        const lines = list.map((s) => `• ${s.slug} — ${s.title} (~${s.minutes} min)\n  ${s.summary}`)
        return toolText(
          id,
          `Guided walkthroughs you can run right here. Call scenarios again with scenario="<slug>" for the full ` +
            `steps, then drive it for the user with the other tools.\n\n${lines.join('\n')}\n\n` +
            `Full versions also live at ${origin}/examples.`,
        )
      }
      const found = getScenario(wanted) ?? getScenario(wanted.replace(/\s+/g, '-').toLowerCase())
      if (!found) {
        const slugs = listScenarios().map((s) => s.slug).join(', ')
        return toolText(id, `No scenario "${wanted}". Available: ${slugs}. Call scenarios with no arguments to see summaries.`, true)
      }
      return toolText(
        id,
        `${found.body}\n\n---\nNow run this for the user step by step with the relevant tools. Confirm each ` +
          `money-moving step (confirm_delegation, etc.) before calling it. Full page: ${origin}/examples/${found.slug}`,
      )
    }
    default:
      return null
  }
}
