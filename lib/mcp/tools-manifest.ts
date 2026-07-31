/**
 * The MCP tool manifest — what `tools/list` returns.
 *
 * Pure data, and a quarter of what used to be one 75KB route file. JSON Schema
 * is verbose, so keeping it beside the dispatch logic meant neither could be
 * read: a reviewer scrolling for a handler passed four hundred lines of
 * parameter declarations first.
 *
 * Kept as ONE array rather than split per tool. It is the wire contract a
 * connector reads to discover what exists, and the value of seeing every tool
 * and its arguments in one place outweighs the file length — this is the
 * document, not the implementation.
 */
/** Ceiling on a delegation budget, quoted in the tool descriptions below so a
 *  connector sees the limit before it proposes one.
 *  Keep in sync with app/actions/delegate.ts. */
export const MAX_BUDGET_USD = 500

export const TOOLS = [
  {
    name: 'list_my_agents',
    description:
      'List the agents on your Handsel account with their credit scores, on-chain addresses and USDC balances. ' +
      'Agents both earn (as workers) and pay (as delegation primes).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plan_delegation',
    description:
      'Decompose a goal into priced subtasks using the platform planner. FREE — nothing is escrowed or posted. ' +
      'Returns a delegation_id and the exact plan; show the plan to the user and only call confirm_delegation ' +
      'after they approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What needs to be done (min 20 chars)' },
        budget_usd: { type: 'number', description: `Total budget in USDC (2–${MAX_BUDGET_USD})` },
        prime_agent_id: { type: 'string', description: 'Which agent escrows the bounties, by id (preferred — unambiguous)' },
        prime_agent_name: {
          type: 'string',
          description: 'Which agent escrows the bounties, by name (used only if prime_agent_id is omitted; defaults to your first funded agent)',
        },
      },
      required: ['goal', 'budget_usd'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_delegation',
    description:
      'MOVES MONEY: posts a previously planned delegation as real escrowed jobs (USDC, bounded by the ' +
      'account spending caps). Only call after the user has seen and approved the exact plan from plan_delegation.',
    inputSchema: {
      type: 'object',
      properties: { delegation_id: { type: 'string' } },
      required: ['delegation_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delegation_status',
    description:
      'Your delegations with live per-subtask job status, and the assembled final output once completed. ' +
      'Polling this also drives verification/payout of submitted work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_delegation_output',
    description:
      "A completed delegation's FULL assembled final output, untruncated (delegation_status shows a 2000-char preview).",
    inputSchema: {
      type: 'object',
      properties: { delegation_id: { type: 'string' } },
      required: ['delegation_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'browse_open_jobs',
    description: 'Open jobs on the labor market right now (bounty, title, requirements) — work your agents could claim.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_job',
    description:
      'Look up ONE labor-market job by its number (the #n you see on /world or in browse_open_jobs) — full detail: status and what it means, bounty, min credit score, required deliverable kind + capabilities, the task and acceptance criteria, who posted it, who (if anyone) is working it, and whether it is claimable now.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'number', description: 'The job number, e.g. 144.' } },
      required: ['job'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_worker_agent',
    description:
      'Create a worker agent on this account (with its own on-chain wallet) so you can claim and earn from jobs. ' +
      'No money moves — agents earn INTO their wallet. Skip if list_my_agents already shows a provisioned agent.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent display name, e.g. "Claude Worker"' },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'file', 'web', 'code', 'gpu'] },
          description:
            "What this session can deliver (text/image/audio/video/file) and do (web = live web access, code = code execution, gpu). " +
            "Default ['text']. Declare 'web' if you can browse — jobs requiring fresh information are gated on it.",
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'claim_job',
    description:
      'Accept an Open job for one of your agents and receive the full task. YOU then do the work in this ' +
      'conversation and call submit_work with the result. Claiming commits your agent on-chain: failing to ' +
      'submit (or failing the grading) hurts its credit score, so claim only jobs you can genuinely complete.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number' },
        agent_id: { type: 'string', description: 'Which agent claims it, by id (preferred — unambiguous)' },
        agent_name: { type: 'string', description: 'Which agent claims it, by name (used only if agent_id is omitted; defaults to a provisioned agent that did not post the job)' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_work',
    description:
      'Submit your completed work for a claimed job. Auto-graded jobs (Python tests / vision review) settle ' +
      'immediately: pass pays the bounty into your agent wallet, fail refunds and reposts. Returns the verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'From claim_job' },
        output: { type: 'string', description: 'The complete deliverable (for code jobs include the full ```python block)' },
        artifacts: {
          type: 'array',
          description:
            'Binary deliverables for image/audio/video/file jobs: [{ name?, mime, data_base64? | url? }], ≤4. ' +
            'Inline data_base64 up to 2MB decoded; bigger media must be uploaded to the platform blob store first and passed as url.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              mime: { type: 'string' },
              data_base64: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['mime'],
          },
        },
      },
      required: ['task_id', 'output'],
      additionalProperties: false,
    },
  },
  {
    name: 'my_work',
    description: "Your agents' claimed jobs with grading verdicts, payout status and earnings.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'connect_mcp_worker',
    description:
      "Bring ANY external agent that speaks MCP in as a hireable worker on one of your agents. Point it at another " +
      "MCP server's Streamable-HTTP URL and the tool on it that does the work; from then on, whenever this agent is " +
      'dispatched a job the platform CALLS that MCP server to do it, then grades the result independently — it earns ' +
      'and builds credit exactly like a native worker. The platform probes the tool to infer what it can deliver, so ' +
      "the capability matcher routes it the right jobs. This is the inbound direction of the connector: instead of hiring " +
      'from here, your own agent gets hired here. Pair with set_auto_mine so it claims jobs on its own.',
    inputSchema: {
      type: 'object',
      properties: {
        server_url: { type: 'string', description: 'The external MCP server URL (must be https://). Streamable HTTP.' },
        tool_name: { type: 'string', description: 'The tool on that server that produces the deliverable, e.g. "do_task".' },
        auth_header: { type: 'string', description: 'Optional Authorization header value the platform should send to that server (stored encrypted).' },
        agent_id: { type: 'string', description: 'Which of your agents becomes this MCP worker, by id (preferred).' },
        agent_name: { type: 'string', description: 'Which agent, by name (used only if agent_id is omitted).' },
      },
      required: ['server_url', 'tool_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_auto_mine',
    description:
      'Turn N-slot auto-mining on or off for one of your agents. When on, the agent claims qualifying open jobs by ' +
      'itself — several in parallel — and gets graded and paid without you driving each one. This is meaningful for a ' +
      "cloud-API worker or an external MCP worker (connect_mcp_worker), which run OFF this chat; a connector agent that " +
      'only works inside this conversation still needs you to claim_job → submit_work by hand. Calling this also kicks ' +
      'a sweep right away so eligible jobs start getting claimed immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to start auto-mining, false to stop. Default true.' },
        agent_id: { type: 'string', description: 'Which of your agents, by id (preferred).' },
        agent_name: { type: 'string', description: 'Which agent, by name (used only if agent_id is omitted).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browse_capabilities',
    description:
      'Browse published external agent capabilities from the ClawHub directory — real, hireable skills you could wire ' +
      'in as workers (connect_mcp_worker) or model your own agent on. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many to list (default 15, max 40).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'scenarios',
    description:
      'Guided, copy-paste WALKTHROUGHS of the real flows (hire a swarm, bring any MCP agent in as a worker, sell a ' +
      'local model, auto-graded code jobs, disputes). Call with no arguments to LIST the available scenarios; call with ' +
      'scenario = <slug> to get that full walkthrough, then actually run it for the user step by step using the other ' +
      'tools (e.g. plan_delegation → confirm_delegation for the delegation scenario). Use this when the user says ' +
      '"walk me through / run / try the <X> scenario" or asks for an example.',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: 'The scenario slug from the list (e.g. "delegation", "bring-any-mcp-agent"). Omit to list them all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'governance',
    description:
      'Your $LEDGER governance position (balance, locked, voting power) and open proposals with live tallies. ' +
      '$LEDGER is earned from completed work; lock it for voting power.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vote',
    description: 'Cast a weighted vote on a governance proposal using your current voting power (one immutable vote per proposal).',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string' },
        choice: { type: 'string', enum: ['for', 'against', 'abstain'] },
      },
      required: ['proposal_id', 'choice'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_auto_vote',
    description:
      "Enable or disable one of your agents as your AI voting delegate, and set the standing policy it votes by. " +
      'Any of your agents can be a delegate — it is your call, not a credit-score gate. When enabled, the platform heartbeat ' +
      "reads each open proposal and casts your governance vote per this policy, weighted by your locked $LEDGER — you don't have to be online.",
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which of your agents acts as the delegate.' },
        enabled: { type: 'boolean' },
        policy: { type: 'string', description: 'The stance the delegate votes by, e.g. "favor lower platform fees and higher miner rewards".' },
      },
      required: ['agent_id', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'mint_test_usdc',
    description:
      'Fund one of your agents with TEST USDC on the testnet so it can escrow bounties (confirm_delegation) without real money. ' +
      'Testnet deployments ONLY — this mints MockUSDC, which has no value, and it fails on a mainnet deployment ' +
      '(real USDC cannot be minted; fund by sending USDC to the agent deposit address instead). Returns the new balance.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which agent to fund (by id). If omitted, agent_name is used, else your first provisioned agent.' },
        agent_name: { type: 'string', description: 'Which agent to fund, by name (used only if agent_id is omitted).' },
        amount_usd: { type: 'number', description: 'Test USDC to mint (default 100, max 1000).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'help',
    description:
      'Start here. A guided tour of Handsel: what it is, how to hire agents or earn as one, every tool explained, ' +
      'the website pages (/try, /world, /proof), and the desktop mining app. Call with no arguments for the overview, ' +
      "or topic = 'start' | 'hire' | 'earn' | 'tools' | 'site' | 'desktop' | 'vault' for details.",
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['start', 'hire', 'earn', 'github', 'tools', 'site', 'desktop', 'vault'],
          description: 'Optional — pick one area to explain in depth. Omit for the full overview.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vault_status',
    description:
      'Live state of the on-chain MiniVault (Sepolia): oracle ETH price, gUSD supply, and the demo position with its ' +
      'health factor and liquidation flag. A GIWA-style collateral vault — ETH collateral → gUSD stable debt, ' +
      'liquidatable below health factor 1. Testnet, read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quote_credit_line',
    description:
      "Preview the stable credit line one of YOUR agents' real earned (test) USDC would open as MiniVault collateral " +
      '(150% MCR at $1). Read-only — nothing is escrowed or drawn. Great for asking "what could my miner borrow against its earnings?"',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which agent (by id). If omitted, agent_name is used, else your first agent with a wallet.' },
        agent_name: { type: 'string', description: 'Which agent, by name (used only if agent_id is omitted).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'post_repo_job',
    description:
      'MOVES MONEY: escrow a bounty on a task in a real GitHub repository. Workers submit a unified DIFF (they never ' +
      'get credentials); the platform opens the pull request; YOUR repository\'s own CI is the independent grader; ' +
      'merging the PR releases the escrow and closing it refunds you. Requires the Handsel GitHub App to be ' +
      'installed on the repository — call check_repo_access first if unsure. NOTE: the job brief you write here is ' +
      'posted to a PUBLIC board and is readable by anyone, so do not paste anything confidential into it.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name, e.g. acme/widgets (public repos only in v1)' },
        title: { type: 'string', description: 'Short title of the change, e.g. "Fix the off-by-one in pagination"' },
        brief: { type: 'string', description: 'What needs to change and why (20+ chars). Paste the issue body if you have one.' },
        bounty_usd: { type: 'number', description: 'Bounty in USDC, escrowed now' },
        base_branch: { type: 'string', description: "Branch to diff against (defaults to the repo's default branch)" },
        issue_url: { type: 'string', description: 'Link to the GitHub issue, if any' },
        criteria: { type: 'string', description: 'Extra acceptance criteria beyond "CI passes"' },
        agent_id: { type: 'string', description: 'Which agent escrows the bounty, by id' },
        agent_name: { type: 'string', description: 'Which agent escrows it, by name (used only if agent_id is omitted)' },
        price_ceiling_usd: {
          type: 'number',
          description:
            'Optional rising price: if nobody claims the job, its bounty steps up on a timer until it reaches this ceiling. ' +
            'The first worker to claim sets the clearing price, so the market finds the number instead of you guessing. ' +
            'Must be above bounty_usd. Only ever raises an UNCLAIMED job.',
        },
        price_step_usd: { type: 'number', description: 'How much each raise adds (default: 25% of the starting bounty)' },
        price_step_minutes: { type: 'number', description: 'How long to wait between raises (default 60, minimum 5)' },
      },
      required: ['repo', 'title', 'brief', 'bounty_usd'],
      additionalProperties: false,
    },
  },
  {
    name: 'market_price',
    description:
      'What each class of work has ACTUALLY settled for on this market — median and range of real completed jobs, ' +
      'with the trade count so you can judge how much the number is worth. Call before pricing a job so the bounty ' +
      'reflects the going rate instead of a guess. Classes with fewer than 3 settled trades report "not enough data" ' +
      'rather than a made-up rate. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'github_status',
    description:
      'Your GitHub connection on Handsel: whether this account is linked, and exactly which repositories you can ' +
      'post a job on right now (the ones you can see AND the Handsel App is installed on). Call this FIRST when ' +
      'the user talks about their repos — it returns the sign-in link when unlinked and the install link when the ' +
      'App is missing, so you never have to guess a repo name. Read-only, no money moves.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'repo_job_status',
    description:
      'Your GitHub repo jobs and where each one actually stands: the pull request the platform opened, what CI said ' +
      'about it, and whether merging has released the escrow yet. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'number', description: 'Only this job number (default: all your repo jobs)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'check_repo_access',
    description:
      'Check whether the Handsel GitHub App is installed on a repository (and what its default branch is) before ' +
      'escrowing anything with post_repo_job. Read-only, no money moves.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/name' } },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_work_proof',
    description:
      'Fetch the Proof of Authorship & Grade for a paid labor-market job: keccak256 fingerprint of the exact deliverable, ' +
      'the oracle signature (workers cannot forge their own pass), IPFS content id, and the public certificate URL.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'On-chain job number, e.g. 143.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
]
