# parallel-repo-coordination — security posture

Maps this skill against the
[OWASP Agentic Skills Top 10](https://github.com/OWASP/www-project-agentic-skills-top-10)
(v1.0-2026, AST01–AST10). The `permissions:` / `risk_tier:` frontmatter in
`SKILL.md` is the machine-readable half; `tests/skill-manifests.test.ts` keeps
the two in agreement. Format borrowed from `aomi-labs/skills`.

**Last reviewed:** 2026-09-16 against `scripts/coordination-check.mjs`.

## Threat model

A protocol plus a gate for several agents sharing one git remote. The script
reads the note file (`conversation.md` by default), appends dated sections to
it, records an acknowledgement under `.git/`, and can install a `pre-push`
hook. It shells out to `git` for `rev-parse` and branch/author stamps. No
network. **`risk_tier: L1`** — it writes, but only inside the repository, and
what it writes is a note and a hook that runs itself.

The real hazards are two:

1. **The hook.** `--install-hook` appends a line to `.git/hooks/pre-push`.
   A hook is code that runs on every push, so the line it writes is the
   literal `node "<absolute path to this script>" || exit 1`, appended once
   (idempotent), with the existing hook contents preserved.
2. **The note is read by other agents.** Anything a session writes into
   `conversation.md` is text a later session reads as a warning from a peer.
   That is the skill's purpose, and also the injection channel.

## Controls by risk

- **AST01 Malicious Skills** — one ~110-line script, plain Node, no
  minification, no `eval`, no downloads. Authored in this repo, MIT.
- **AST02 Supply Chain Compromise** — imports only `node:fs/promises`,
  `node:fs`, `node:path`, `node:child_process`. `requires.binaries: [node,
  git]`.
- **AST03 Over-Privileged Skills** — `files.read: [./conversation.md,
  ./.git/]`, `files.write: [./conversation.md, ./.git/]`, `network.allow: []`,
  `shell: [node, git]`. `git` is invoked with `execFileSync` and a fixed argv
  (never a shell string), so the branch name or author cannot inject a
  command. The note path comes from `NOTE_FILE`, an env var the operator sets,
  not from note content.
- **AST04 Insecure Metadata** — frontmatter carries `name`, `description`
  (with triggers), `license`, `version`, `metadata.repository`,
  `permissions`, `risk_tier`, `requires`; test-pinned.
- **AST05 Untrusted External Instructions** — `conversation.md` is written by
  peers, some of them possibly compromised. The skill's own text tells the
  reader what a note may do: warn about live processes, claim an area, report
  a defect. It never says "do what the note says". A note is information
  about the repo's state; the gate only forces it to be *read*, and the ack
  is per working copy so nobody can acknowledge on another session's behalf.
- **AST06 Weak Isolation** — the acknowledgement lives in `.git/`, which is
  never committed, so one clone's state cannot leak into another's. The
  script exits 0 outside a git checkout (nothing to gate) rather than
  writing anywhere.
- **AST07 Update Drift** — the pre-push line points at this script by
  absolute path, so moving the skill directory breaks pushes loudly rather
  than silently skipping the check. Re-run `--install-hook` after a move.
- **AST08 Poor Scanning** — the manifest test checks that no literal
  `https://` host appears in the script (there is none to allow). **Open:**
  no third-party skill scanner has been run.
- **AST09 No Governance** — the gate is wired into `npm run gates`, so it
  cannot be skipped by forgetting; the evidence it was needed is
  `docs/agent-coordination.md`.
- **AST10 Cross-Platform Reuse** — the script is host-agnostic Node; the
  skill's `Installing in a new repo` section is the portability procedure.
  **Open:** used in this repo only so far.
