# handsel-agent-contract — security posture

Maps this skill against the
[OWASP Agentic Skills Top 10](https://github.com/OWASP/www-project-agentic-skills-top-10)
(v1.0-2026, AST01–AST10). The `permissions:` / `risk_tier:` frontmatter in
`SKILL.md` is the machine-readable half; `tests/skill-manifests.test.ts` keeps
the two in agreement. Format borrowed from `aomi-labs/skills`.

**Last reviewed:** 2026-09-16.

## Threat model

A documentation skill: it explains the grammar of a Handsel job (Task →
Deliverable → Verification → Acceptance → Settlement) and which fields bind.
It ships one file, runs nothing, and reads only the repository it lives in.
**`risk_tier: L0`** — minimal surface.

The one thing it could do wrong is *teach* wrong: an agent that misreads which
half of a contract binds might accept work, or refuse pay, on the platform's
word rather than the sealed one. That is a correctness risk in the text, not a
security risk in the skill, and `lib/agent-contract.ts` plus its tests are the
source the text is checked against.

## Controls by risk

- **AST01 Malicious Skills** — Markdown only, authored in this repo,
  MIT-licensed, history in `git log`. No scripts.
- **AST02 Supply Chain Compromise** — no dependencies, nothing fetched.
- **AST03 Over-Privileged Skills** — `files.read: [./]` (it quotes repo code),
  `files.write: []`, `network.allow: []`, `shell: []`, `tools: []`.
- **AST04 Insecure Metadata** — `name`, `description` (says when to use it,
  with trigger words), `license`, `version`, `metadata.repository`,
  `permissions`, `risk_tier` all present and test-pinned.
- **AST05 Untrusted External Instructions** — the skill reads no external
  content. Its subject matter is the opposite direction: it tells an agent
  which parts of a *counterparty's* claims are binding, which is the same
  discipline applied to a job.
- **AST06 Weak Isolation** — nothing runs, nothing to isolate.
- **AST07 Update Drift** — the skill describes `lib/agent-contract.ts` and
  `lib/trade-instruments.ts`; CLAUDE.md tells an editor to read the skill
  before touching either. **Open:** no test yet pins the skill text to those
  modules' exported field names.
- **AST08 Poor Scanning** — the manifest test is the scan; a third-party
  scanner has not been run and would find nothing to run on.
- **AST09 No Governance** — changes land through the repo's normal gate
  (`npm run gates`); a wrong statement about what binds is a bug report on
  the skill, not a security advisory.
- **AST10 Cross-Platform Reuse** — plain `SKILL.md` + frontmatter, no
  host-specific fields; safe on any host because it asks for nothing.
