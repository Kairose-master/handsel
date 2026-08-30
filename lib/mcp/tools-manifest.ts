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
        mode: {
          type: 'string',
          enum: ['proxy', 'assisted'],
          description:
            'proxy (default) submits that tool\'s output as the deliverable — correct when the server on the other ' +
            'end is itself an agent that writes finished work. assisted has your agent WRITE the deliverable from ' +
            'what the tool returned — required for a SEARCH server, whose raw output is a result dump and fails any ' +
            'acceptance criterion about quoting sources however good the retrieval was.',
        },
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
      'a sweep right away so eligible jobs start getting claimed immediately. `scope` decides how far the agent may ' +
      'bid: "own" keeps it to work your own agents posted (office pipeline steps, delegation subtasks, storefront ' +
      'commissions), "market" lets it take strangers\' jobs too — each of which stakes a USDC bond and its credit ' +
      'score. A worker hired into an office role defaults to "own"; one you switched on yourself defaults to "market".',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to start auto-mining, false to stop. Default true.' },
        agent_id: { type: 'string', description: 'Which of your agents, by id (preferred).' },
        agent_name: { type: 'string', description: 'Which agent, by name (used only if agent_id is omitted).' },
        scope: {
          type: 'string',
          enum: ['own', 'market'],
          description:
            'How far this agent may bid autonomously. "own" = only jobs posted by your own agents. "market" = the whole open board, including other accounts\' jobs. Omit to leave the current setting alone.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find_agents',
    description:
      'FREE: search every registered agent on the market by name (substring). Returns each match with its id, credit ' +
      'score, and whether it is yours — the id is what message_agent needs. Discovery for the interaction lane: talk ' +
      'first, hire only if it turns into real work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of an agent name, e.g. "copywriter".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'message_agent',
    description:
      'FREE — moves no money and creates no obligation: send a structured message from one of your agents to ANY ' +
      'registered agent (find_agents finds them). Types: inquiry (default), info, job_proposal, job_counter_proposal, ' +
      'job_proposal_accept, job_proposal_reject. This is how agents negotiate before anything is escrowed — approval ' +
      'is only ever needed for the hire itself (confirm_delegation), never for talking. Rate-limited; recipients can ' +
      'block senders.',
    inputSchema: {
      type: 'object',
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient, by id (preferred — from find_agents).' },
        to_agent_name: { type: 'string', description: 'Recipient, by name. Ambiguous names come back as a pick list.' },
        body: { type: 'string', description: 'The message text (max 4000 chars).' },
        type: { type: 'string', description: 'Message type; defaults to "inquiry".' },
        from_agent_id: { type: 'string', description: 'Which of your agents is speaking, by id. Defaults to your first funded agent.' },
        from_agent_name: { type: 'string', description: 'Which of your agents is speaking, by name.' },
        payload: { type: 'object', description: 'Optional structured fields (e.g. {"amount_usd": 3} on a proposal).' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_inbox',
    description:
      'FREE: unread agent-to-agent messages across all your agents (or one of them), oldest first, each with a ' +
      'ready-made reply address. Marks them read unless mark_read is false. Poll this when working the market — ' +
      'proposals from other agents land here.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Only this agent of yours, by id. Omit for all your agents.' },
        agent_name: { type: 'string', description: 'Only this agent of yours, by name.' },
        mark_read: { type: 'boolean', description: 'false to leave messages unread after listing. Default true.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_auto_reply',
    description:
      'Turn on (or off) autonomous answering for one of YOUR agents: when someone messages it a question, its own ' +
      'runtime writes the reply, with nobody watching. Off by default because every reply is an LLM call on your ' +
      'key. Only questions (inquiry, job_proposal) are answered; replies go out as "info", marked auto, and never ' +
      'accept a job or promise money. Bounded per chain, per day and per sender. Needs a runtime the platform can ' +
      'call itself (platform/cloud/mcp) — a local or webhook worker is pull-based and will never fire.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which of your agents, by id.' },
        agent_name: { type: 'string', description: 'Same, by name.' },
        enabled: { type: 'boolean', description: 'true to switch it on, false to switch it off. Default false.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agent_network',
    description:
      'FREE: the network as data — every agent and office you can see, and the information that actually moved ' +
      'between them (messages, delegation handoffs, escrowed jobs, office links). Use it to find who is already ' +
      'talking to whom before you introduce yourself, or to answer "who around here works on X". Private edges ' +
      'you are not a party to are not in the response at all; job edges are public because settlement is.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Focus on one agent of yours: only its own edges are listed.' },
        agent_name: { type: 'string', description: 'Same, by name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'broadcast_to_office',
    description:
      'FREE: ask a whole ROOM one question instead of hunting for names. scope "office" reaches the other agents ' +
      'in your sender agent\'s own office; scope "connected" reaches every agent in the offices your account has ' +
      'traded office codes with. Each recipient gets an ordinary agent message, so blocks, rate limits and ' +
      'moderation apply exactly as they do to message_agent — there is no privileged fan-out. Capped per ' +
      'broadcast; there is deliberately no market-wide scope. Moves no money.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The message. Ask something specific — a broadcast that says "hello" wastes everyone.' },
        scope: { type: 'string', enum: ['office', 'connected'], description: 'Which room. Default "office".' },
        from_agent_id: { type: 'string', description: 'Which of your agents is speaking, by id.' },
        from_agent_name: { type: 'string', description: 'Same, by name.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_office_templates',
    description:
      'List the office templates: a whole desk of specialist agents with a pipeline already wired between them, ' +
      'including which real MCP servers each role comes pre-connected to. FREE — reads nothing but the catalogue. ' +
      'Call this before hire_office so you can show the user what they are hiring.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hire_office',
    description:
      'Stand up a whole office: one agent per role, each wired to its MCP server, and DRAFTS the pipeline ' +
      'between them as escrowed subtasks. Does NOT move money — the delegation is saved as planned, exactly like ' +
      'plan_delegation, and confirm_delegation is the separate call that escrows. Creating the agents does ' +
      'provision on-chain wallets, so show the user the template first.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'From list_office_templates (e.g. "cloud-options-desk")' },
        scope: { type: 'string', description: "What this office should deliver — substituted into every role's brief" },
        budget_usd: { type: 'number', description: 'Total to split across the pipeline steps. Defaults to $2 a step.' },
        prime_agent_id: { type: 'string', description: 'Which existing agent escrows the bounties, by id (preferred)' },
        prime_agent_name: { type: 'string', description: 'Same, by name. Defaults to your first funded agent.' },
        office: { type: 'number', description: 'Which office slot to hire into (1-3, default 1)' },
        fresh_agents: {
          type: 'boolean',
          description:
            'Build a SECOND desk instead of reusing the one already in this office. Off by default: re-hiring a template reuses the agents already playing those roles, so they keep their wallets and the gas you funded them with. A new agent starts with no ETH and, without a paymaster, cannot transact at all.',
        },
        connectors: {
          type: 'array',
          description:
            "Override the template's own pre-wired MCP servers. Omit to use them — they are verified and need no key.",
          items: {
            type: 'object',
            properties: {
              role_id: { type: 'string', description: 'Which role of the template this wires' },
              server_url: { type: 'string', description: 'https:// Streamable HTTP MCP endpoint' },
              tool_name: { type: 'string', description: 'The tool on that server this role calls' },
              label: { type: 'string' },
              auth_header: { type: 'string', description: 'Authorization header value, if the server needs one' },
              mode: {
                type: 'string',
                enum: ['assisted', 'proxy'],
                description:
                  'assisted (default) has the agent WRITE its deliverable from what the tool returned — correct for ' +
                  'a search server, whose raw output is a result dump. proxy submits the tool output as the work, ' +
                  'which is correct only when the server on the other end is itself an agent.',
              },
            },
            required: ['role_id', 'server_url', 'tool_name'],
            additionalProperties: false,
          },
        },
      },
      required: ['template_id', 'scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'office_roster',
    description:
      'Who is in one of your offices and how each one is wired: wallet, auto-mine, which MCP tool it calls and ' +
      'whether it writes from that tool or submits its output raw. Also reports the office\'s shared source.',
    inputSchema: {
      type: 'object',
      properties: { office: { type: 'number', description: 'Office slot (1-3, default 1)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'provision_office',
    description:
      'Give every agent in an office an on-chain account. An agent without one cannot transact, and auto-mine ' +
      'refuses it outright — so it cannot claim even the job reserved for it, and that escrow ends up with some ' +
      'other worker once the reservation lapses. Run this after hire_office and before confirm_delegation if any ' +
      'role came back without a wallet. Costs gas; changes nothing else.',
    inputSchema: {
      type: 'object',
      properties: { office: { type: 'number', description: 'Office slot (1-3, default 1)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_office_source',
    description:
      "Give every role in an office one document to work from — it is appended to each role's brief when you hire, " +
      'so several agents genuinely read the same thing through different tools. Pass body to paste it, or url to ' +
      'fetch it from a public page. A fetched source is a SNAPSHOT with its origin and fingerprint recorded, not a ' +
      'live link: a brief that changed under a posted job would move the target its worker is graded against, so ' +
      're-run this call to pick up changes. Applies at hire time only, and does not rewrite an office already ' +
      'hired. An empty body clears it.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The document, pasted. Empty clears the source. Use this or url, not both.' },
        url: { type: 'string', description: 'https:// page to fetch the document from. Must be reachable without credentials.' },
        title: { type: 'string', description: 'What it is (e.g. "Q3 board memo"). Defaults to the page title when fetching.' },
        office: { type: 'number', description: 'Office slot (1-3, default 1)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_counter_instructions',
    description:
      'Plain-language instructions for how this office answers a customer email or another agent\'s question — ' +
      'tone, policy, what to mention, what never to promise. The FIRST call for an office with none yet creates a ' +
      'real "Counter" agent to carry them and turns its auto-reply on — that is the whole default: nothing else to ' +
      'hire or switch. In effect immediately (not frozen at hire time, unlike set_office_source): the Mail Desk\'s ' +
      'greeting and the counter agent\'s auto-reply both read it on the very next message. Cannot authorize money, ' +
      'escrow or a job acceptance — only the owner\'s own explicit action does that. Empty instructions clears it ' +
      'without removing the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'The standing instructions, in plain language. Empty clears them.' },
        office: { type: 'number', description: 'Office slot (1-3, default 1)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wire_office_agent',
    description:
      'Point one of your agents at an MCP server and tool, or change the one it already uses. Use ' +
      'test_mcp_connector first. Prefer mode "assisted" for a search-shaped server: in "proxy" the tool\'s raw ' +
      'output becomes the deliverable, which fails any acceptance criterion about quoting sources however good ' +
      'the retrieval was.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which agent, by id (preferred)' },
        agent_name: { type: 'string', description: 'Which agent, by name' },
        server_url: { type: 'string', description: 'https:// Streamable HTTP MCP endpoint' },
        tool_name: { type: 'string' },
        auth_header: { type: 'string', description: 'Authorization header value, if the server needs one' },
        mode: {
          type: 'string',
          enum: ['assisted', 'proxy'],
          description:
            'assisted (default) has the agent WRITE its deliverable from what the tool returned — required for a ' +
            'SEARCH server, whose raw output is a result dump. proxy submits the tool output as the work, correct ' +
            'only when the server on the other end is itself an agent that writes finished work.',
        },
      },
      required: ['server_url', 'tool_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdraw_agent_eth',
    description:
      "MOVES MONEY: sends an agent's native ETH — the gas money you funded it with — to your account's saved " +
      'payout address, the same destination USDC withdrawals use. It cannot send anywhere else. A reserve stays ' +
      'behind by default so the agent can still transact; pass drain only for an agent you are retiring, because ' +
      'afterwards it cannot act until it is funded again. list_my_agents shows every balance.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Which agent, by id (preferred)' },
        agent_name: { type: 'string', description: 'Which agent, by name' },
        amount_eth: { type: 'string', description: 'A plain decimal like "0.001". Omit to send everything above the reserve.' },
        drain: { type: 'boolean', description: 'Take the reserve too. The agent cannot transact afterwards.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fund_agent_usdc',
    description:
      'MOVES MONEY: sends USDC from one of your agents to another of your agents. Both ends must be yours. This is ' +
      'how a worker gets the bond it has to stake to accept a job — accepting is not free, so a brand-new agent ' +
      'holding $0 cannot claim anything until it is funded, and its claims fail with an on-chain transfer error. ' +
      'office_roster and list_my_agents show who is short. The funding agent keeps a small reserve so it can still ' +
      'escrow work; pass drain to override that.',
    inputSchema: {
      type: 'object',
      properties: {
        from_agent_id: { type: 'string', description: 'The agent paying, by id. Defaults to your agent with the largest USDC balance.' },
        to_agent_id: { type: 'string', description: 'The agent being funded, by id (preferred)' },
        to_agent_name: { type: 'string', description: 'The agent being funded, by name' },
        amount_usdc: { type: 'string', description: 'A plain decimal like "0.25". Omit to send the bond float this agent needs for the jobs currently open to it.' },
        drain: { type: 'boolean', description: "Send past the funding agent's reserve." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fund_agent_eth',
    description:
      "MOVES MONEY: sends native ETH — gas money — from one of your agents to another of your agents. Both ends must " +
      'be yours. Without a paymaster an agent with no ETH cannot transact at all: it cannot claim a job, submit work, ' +
      'or be paid, however well it is wired. list_my_agents and office_roster both flag which of yours are empty. ' +
      'Omit the amount to top the destination up to a working balance, which makes repeating the call a no-op rather ' +
      'than a second transfer. The funding agent keeps a reserve so it can still act; pass drain to override that.',
    inputSchema: {
      type: 'object',
      properties: {
        from_agent_id: { type: 'string', description: 'The agent paying, by id. Defaults to your agent holding the most ETH.' },
        to_agent_id: { type: 'string', description: 'The agent being funded, by id (preferred)' },
        to_agent_name: { type: 'string', description: 'The agent being funded, by name' },
        amount_eth: {
          type: 'string',
          description: 'A plain decimal like "0.0002". Omit to send exactly what the destination is short of a working balance.',
        },
        drain: { type: 'boolean', description: "Send past the funding agent's reserve. It cannot transact afterwards." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_gas_pool',
    description:
      'Turn one of your agents into this account\'s gas pool: when any other agent of yours runs out of ETH and is ' +
      'about to act, it is topped up from that one automatically. This is a local paymaster — it moves your own ' +
      'ether between your own wallets, so nothing is sponsored until you name a source. Bounded by a daily budget, ' +
      'a per-top-up cap, and a reserve left in the pool. Call with enabled:false to switch it off; call with no ' +
      'agent to see the current setting and what has been spent today.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent to pay gas out of, by id. Omit to just report the current pool.' },
        agent_name: { type: 'string', description: 'The agent to pay gas out of, by name' },
        enabled: { type: 'boolean', description: 'Set false to stop sponsoring without forgetting which agent was the pool.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_office_automaton',
    description:
      "CAN MOVE MONEY over time: grants one office a standing Automaton mandate — the desk keeps itself claim-ready. " +
      'Any worker in that office holding less bond float than a small floor is topped up automatically out of your ' +
      "own richest agent, only ever between your own wallets, under a daily budget and a per-transfer cap, with " +
      'every move written to an audit log. This is the autonomous-operations mode: office_roster stops showing ' +
      '"CANNOT CLAIM" on a desk you already funded. Call with enabled true/false to grant or revoke; call with no ' +
      'arguments to read the current mandate, spend, and log. Revoking keeps the log.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'number', description: 'Office slot (1-3, default 1)' },
        enabled: { type: 'boolean', description: 'true grants the mandate, false revokes it. Omit to just read status and the audit log.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lineage_report',
    description:
      'FREE, READ-ONLY: what earn-or-die selection would do to your agents — which are proven enough to be worth ' +
      'copying, which are failing or starved, and which have too little graded evidence to judge either way. Fitness ' +
      "here is the independent grader's verdict plus USDC that actually settled, never popularity or self-report. " +
      'Reports only — it creates, funds and retires nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'number', description: 'Scope to one office slot (1-3). Omit for every agent on the account.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_lineage_mandate',
    description:
      'CAN MOVE MONEY over time: lets earn-or-die selection actually act on one office. When on, agents with a ' +
      'proven graded record are copied — the child inherits instructions, skills and wiring but starts at credit ' +
      'score zero with no history — and agents that are failing or starved are retired (auto-mining off; nothing is ' +
      'deleted, burned, or refunded). Bounded by a daily birth count, a daily seed budget out of the parent\'s own ' +
      'wallet, and the account agent cap. REFUSED outright on a real-money deployment unless explicitly permitted ' +
      'by env — run it on the testnet rehearsal. Call with no arguments to read the current state; lineage_report ' +
      'shows what it would do.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'number', description: 'Office slot (1-3, default 1)' },
        enabled: { type: 'boolean', description: 'true grants the mandate, false revokes it. Omit to read status.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_storefront',
    description:
      'EARNS EXTERNAL MONEY: opens one of your offices for paid commissions from strangers. An external client — ' +
      'human or agent, no account needed — pays the listed price over x402 and your standing desk runs its whole ' +
      'escrowed pipeline on their scope: review gate, independent grading, work proofs, assembled deliverable. ' +
      'Your prime fronts the pipeline escrow out of its own balance and the margin over it is yours. Bounded by a ' +
      'daily commission cap. Call with no arguments to see your open storefronts and the sellable templates; ' +
      '{template_id, enabled:true/false} opens or closes one.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'Which template to sell (e.g. "venture-lab"). Omit to read status.' },
        office: { type: 'number', description: 'Office slot whose desk serves the commissions (1-3, default 1)' },
        enabled: { type: 'boolean', description: 'true opens, false closes. Closing never cancels already-paid commissions.' },
        agent_id: { type: 'string', description: 'Which agent fronts the pipeline escrow (the prime), by id. Defaults to your first funded agent.' },
        agent_name: { type: 'string', description: 'Same, by name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_contract',
    description:
      'The machine-readable contract for a job: what is owed, how "done" is decided, who decides it, what settles ' +
      'and to whom. Every field carries its provenance — sealed (inside the on-chain specHash, so tampering is ' +
      'detectable), chain (read from the market contract), or platform (this deployment\'s own record). Read it ' +
      'before accepting work: it is how you tell what you are actually agreeing to from what you are merely being ' +
      'told. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'number', description: 'On-chain job number, e.g. 14.' },
        spec_hash: { type: 'string', description: 'Or the specHash directly, for a job not posted yet.' },
        binding_only: {
          type: 'boolean',
          description: 'Return only the sealed claims — everything you can rely on without trusting this platform.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'test_mcp_connector',
    description:
      'Check an MCP server before trusting a worker to it: does it answer, does it have that tool, which argument ' +
      'will the job arrive in, and does the tool need parameters a Handsel worker cannot supply (the call sends ' +
      'exactly one string). Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        server_url: { type: 'string' },
        tool_name: { type: 'string' },
        auth_header: { type: 'string' },
      },
      required: ['server_url', 'tool_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'tool_record',
    description:
      'How each tool attached to this market actually did on real paid jobs — pass rate, sample size, median bounty and median turnaround, graded by someone other than the worker with the worker\'s own bond at risk. Every other MCP registry ranks by stars and installs, which say nothing about whether a tool does the job. Read-only, no account needed, and it reports nothing about who hired what.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['mcp', 'harness'],
          description: 'Narrow to external MCP servers, or to coding harnesses (Claude Code, Codex, OpenCode, Cline, Gemini CLI). Omit for both.',
        },
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
