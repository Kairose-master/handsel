# instagram-publisher — security posture

Maps this skill against the
[OWASP Agentic Skills Top 10](https://github.com/OWASP/www-project-agentic-skills-top-10)
(v1.0-2026, AST01–AST10). The `permissions:` / `risk_tier:` frontmatter in
`SKILL.md` is the machine-readable half; `tests/skill-manifests.test.ts` keeps
the two in agreement. Format borrowed from `aomi-labs/skills`.

**Last reviewed:** 2026-09-16 against `scripts/ig.mjs`.

## Threat model

The skill drives a zero-dependency Node CLI over the **official Instagram
Graph API** to publish posts, carousels, Reels and Stories to the Handsel
account, and to read publish status, quota and insights. A live publish is a
public, outward-facing, effectively irreversible action under the company's
name, taken with a long-lived access token. That is why it is
**`risk_tier: L2`** (elevated; requires review). It is not L3: it deletes
nothing, reads no files, and the only host it can reach is the Graph API.

Three things can go wrong, in order of cost:

1. **Something publishes that a human did not approve** — wrong image, a
   claim the product cannot back, an agent-generated caption nobody read.
2. **The token leaks** — into a log, a chat transcript, a URL, a commit.
3. **A duplicate publish** — `media_publish` is not idempotent, and a retried
   container publishes twice.

## Controls by risk

### AST01 — Malicious Skills
One ~240-line script, plain Node 18+, no minification, no `eval`, no
downloads, no `child_process`. Authored in this repo, MIT, history in `git
log`. The prompts under `prompts/` are text templates the human approves
before use; they publish nothing themselves.

### AST02 — Supply Chain Compromise
Zero dependencies: the script uses global `fetch` and `URLSearchParams` only.
`requires.binaries: [node]`. Nothing is fetched from a package registry at run
time.

### AST03 — Over-Privileged Skills
- `files.read: []`, `files.write: []` — credentials come from environment
  variables (`INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`, optional
  `INSTAGRAM_API_VERSION`, `INSTAGRAM_GRAPH_HOST`) or, inside the deployment,
  the encrypted `platform_secrets` KV. The script writes no file.
- `network.allow: [graph.instagram.com, graph.facebook.com]`, `deny: "*"`.
  `INSTAGRAM_GRAPH_HOST` selects between the two (Instagram-Login vs
  Facebook-Login tokens); it is operator-set, not content-derived. Media is
  never fetched by the script: it passes a public URL to Meta, and Meta
  fetches it.
- `shell: [node]`, `tools: []`.

### AST04 — Insecure Metadata
Frontmatter carries `name`, `description` (with triggers), `license`,
`version`, `metadata.repository`, `permissions`, `risk_tier`, `requires`;
test-pinned. The allow-listed hosts must appear in the skill's own text, and
any literal host in `scripts/` must be allow-listed, so the manifest cannot
describe a script it no longer matches.

### AST05 — Untrusted External Instructions
- Captions and claims are bound by the DO-NOT-CLAIM discipline in
  `docs/social/instagram-brand.md`; the skill says every word must be true
  of the real product.
- Comment-triggered DMs (the one place strangers' text enters) live in the
  app, not this script: `lib/social/instagram/dm.ts` lints the reply
  template, refuses copy that does not self-identify as Handsel, and the
  template is approved by a named human before it is registered. Comment
  text classifies a reply; it never becomes one.

### AST06 — Weak Isolation
The token is sent only in the `Authorization` header, never in a query
string (so it cannot land in a server log or a referrer). Output echoes the
token's last four characters only. An auth failure (`OAuthException` /
code 190) exits with "reconnect the account — do NOT retry" rather than
looping.

### AST07 — Update Drift
`scripts/ig.mjs` mirrors `lib/social/instagram/` in the app; the API version
is pinned by default (`v25.0`) and overridable by env. **Open:** no test yet
pins the standalone script's endpoint shapes to the app module's.

### AST08 — Poor Scanning
The manifest test is the scan. **Open:** no third-party skill scanner has
been run. Their likely finding — "publishes on the user's behalf" — is the
declared L2 surface.

### AST09 — No Governance
This is the skill's core control:

- **Dry-run by default.** Every publish command prints exactly what would be
  published and exits unless `--live` is passed, and `SKILL.md`'s first iron
  rule is that `--live` follows an explicit human yes *in this conversation*
  after seeing media URL, caption and kind. "Generation finishing is never
  approval."
- **The queue is preferred.** Inside the deployment, anything scheduled or
  agent-produced goes through the Social Desk queue (`/social`,
  `createSocialJob`), where a human approves, the approved payload is
  fingerprinted, and retries and duplicate prevention are owned by the
  queue, not by whoever is holding the token.
- **Duplicate guard.** An `ERROR`/`EXPIRED` container is never re-published;
  a new one is created, because `media_publish` is not idempotent.
- Quota (100 publishes / rolling 24h) is checked before publishing rather
  than discovered by a failed call.

### AST10 — Cross-Platform Reuse
The skill is host-neutral Markdown plus a Node script; no `allowed-tools`
line, so it inherits whichever shell grant the host gives. On a host that
grants broad shell, the dry-run default is still what stands between an
agent and a live publish — a host cannot weaken it, only the `--live` flag
can. **Open:** used from Claude Code only so far.
