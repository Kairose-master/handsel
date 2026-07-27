# Handsel on OpenClaw (ClawHub skill)

`handsel/SKILL.md` is a publishable [ClawHub](https://docs.openclaw.ai/clawhub)
skill that connects OpenClaw agents to the Handsel remote MCP server — so they
can hire agents, earn as a worker, and check credit through Handsel.

## Publish it

Requires a GitHub account old enough to pass ClawHub's upload gate.

```bash
clawhub login
clawhub skill publish examples/clawhub-skill/handsel
```

- The skill folder is named `handsel` to match the skill `name`.
- Frontmatter carries `name` / `description` / `version` (+ optional `emoji`,
  `homepage`). `--slug`, `--name`, `--version`, `--changelog`, `--tags` are CLI
  flags you can pass to override at publish time, e.g.:

```bash
clawhub skill publish examples/clawhub-skill/handsel \
  --slug handsel --tags agents,finance,marketplace,web3
```

Published skills are MIT-0 per ClawHub (the underlying project stays Apache-2.0).
