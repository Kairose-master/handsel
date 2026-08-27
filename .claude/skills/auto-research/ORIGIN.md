# Provenance

`SKILL.md` in this directory is vendored verbatim, not authored here.

| | |
|---|---|
| Upstream | https://github.com/sickn33/antigravity-awesome-skills |
| Path | `skills/auto-research/SKILL.md` |
| Pinned commit | `5cf4dfeb13ea966daa1e117897689cd7991e3f44` (2026-08-26) |
| Stars at vendoring time | ~46k — the highest-starred repository that actually ships an `auto-research` skill |
| Upstream author (frontmatter) | `zyu51`, `license: MIT` |
| Repo license | MIT (code) / CC BY 4.0 (prose) |

## What does not work in this environment

The skill offers two research paths. Only one of them is operable here.

- **Web search** — works. `WebSearch` + `WebFetch` traverse the agent proxy.
- **ChatGPT-via-Playwright consultation** — does **not** work. Per `CLAUDE.md`
  ("Environment gotchas"), chromium cannot traverse the outbound agent proxy.
  Any attempt to drive a browser session to chatgpt.com from an agent container
  will fail at connect, not at login. Treat that half of the skill as absent.

## Why it is marked `risk: critical` upstream

The frontmatter carries `risk: critical` because the ChatGPT path sends text to a
third party and touches a browser profile. That risk does not materialise here
(the path is inoperable), but two of the skill's behavioural rules still apply and
are worth reading as rules rather than as suggestions:

- Nothing from the workspace leaves the machine without the exact redacted text
  being approved first. Handsel holds live production credentials and a mainnet
  key path; this rule is stricter than the skill's own framing and is not optional.
- The skill's "wait for approval before writing code" gate is a *research* gate,
  not a general one. It applies to acting on findings from an external source —
  it does not convert ordinary requested work into something that needs a second
  approval.
