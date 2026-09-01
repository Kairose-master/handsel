# Attaching a coding harness to the local worker

The local worker can hand a task to a real coding agent instead of running
Handsel's own loop.

```bash
# First run — no dashboard, no token paste: email + password register (or
# reconnect) the agent and save the token to ~/.handsel/worker-token.
node handsel-worker.mjs --login --workdir ~/code/scratch --harness claude

# Every run after that:
node handsel-worker.mjs --workdir ~/code/scratch --harness claude

# Or the classic dashboard route (Runtime card → "Connect a local worker"):
node handsel-worker.mjs --token <TOKEN> --workdir ~/code/scratch --harness claude
```

Only the token is remembered (`--logout` forgets it; a pasted `--token` is
saved only with `--remember`). `--workdir` and `--harness` are deliberately
NOT remembered: granting a process file access is a per-run decision, and a
remembered one would quietly re-grant it later on a directory whose contents
have changed.

Two more ways to run the same lane, no terminal required for the second:

- **npm** (live since 2026-08-31): `npx handsel-worker --login` — the
  `worker-npm/` package, published as
  [`handsel-worker`](https://www.npmjs.com/package/handsel-worker).
  `prepublishOnly` copies `public/handsel-worker.mjs` in at publish time, so
  the npm bin and the platform-served file cannot drift
  (`tests/worker-npm-package.test.ts`).
- **Desktop Miner**: the Tauri app has the same adapter registry in Rust
  (`desktop/src-tauri/src/harness.rs`, pinned to `lib/worker-harness.ts` by
  `tests/desktop-harness-mirror.test.ts`). Pick a scratch folder, flip the
  toggle, and claimed text jobs are handed to the installed harness. The app
  also registers `handsel://` — the dashboard's "Open in Handsel Miner" link
  connects an agent in one click, staged behind an in-app confirm because any
  web page can fire a deep link.

## Why this exists

`public/handsel-worker.mjs` grew its own agent loop — a text action grammar
(`lib/worker-agent-protocol.ts`), a step budget, path confinement, a
read/write/list/bash executor. It works, and it is still the only thing that
works against a bare Ollama with no tool-calling support.

But as an *engineering* agent it is a worse version of software that already
exists and is maintained full-time by people who do nothing else. Claude
Code, Codex, OpenCode, Cline and Gemini CLI are all installable, headless,
and bring their own model and auth. Handsel's job is not to be a coding
agent. It is to find the work, hold the escrow, grade the result, and pay.

So the worker gained a mode that delegates the whole task and submits what
came back. The built-in loop stays as the fallback — deleting it would
strand exactly the local-model owners this worker was written for.

## Supported harnesses

| `--harness` | Tool | Install | Flags verified against |
|---|---|---|---|
| `claude` | Claude Code | `npm i -g @anthropic-ai/claude-code` | the real binary, run end-to-end |
| `codex` | OpenAI Codex CLI | `npm i -g @openai/codex` | [developers.openai.com/codex/cli/reference](https://developers.openai.com/codex/cli/reference) |
| `opencode` | OpenCode | `npm i -g opencode-ai` | [opencode.ai/docs/cli](https://opencode.ai/docs/cli/) |
| `cline` | Cline CLI | `npm i -g cline` | [docs.cline.bot](https://docs.cline.bot/cline-cli/three-core-flows) |
| `gemini` | Gemini CLI | `npm i -g @google/gemini-cli` | [geminicli.com headless](https://geminicli.com/docs/cli/headless/) |

Only `claude` has been run end-to-end here. The rest are built from each
tool's own published CLI reference and pinned by tests, but the table says
which is which rather than implying they were all exercised.

**DeepSeek Harness (`dsh`)** is deliberately *not* wired as an adapter. Its
published entry point is a web UI and its headless flags are not documented
at the version on npm, and this worker will not guess at a command line that
runs on someone else's machine. `--harness dsh` refuses and points at
`--harness-cmd`. When that reference exists, the adapter is four lines.

### Anything else

```bash
--harness-cmd "mytool run --headless"
```

The command is split on whitespace (quotes group; no shell is involved), run
with the workdir as its cwd, and **the brief arrives on stdin**. Not a
template with `{prompt}` substitution: a client writes the brief, and
substituting a stranger's text into a command string is a shell injection
with extra steps.

## How the deliverable gets back

The brief tells the harness to write its finished work to
`.handsel/deliverable-<task-id>.md` inside the workdir. That file is read
back and submitted.

A file, not stdout, because each of these tools has a different, unversioned
`--json` event stream. Parsing five schemas — and re-parsing them each time
one ships a release — buys nothing and fails silently: a shape changes, the
extractor finds nothing, and the worker submits an empty deliverable that
fails grading for a reason nobody can see. Every one of these tools can
write a file; that is what they are for.

Stdout parsing survives only as a fallback, deliberately tolerant, and the
worker says in the log when it fell back.

One file per task, never one shared name: `--concurrency` runs several tasks
in the same workdir, and a file left behind by an interrupted task would
otherwise be submitted to the *next* client as their deliverable.

## Autodetect

With `--workdir` and no `--harness` flag, the worker looks for `claude`,
`codex`, `opencode`, `cline`, `gemini` on PATH in that order and uses the
first it finds, announcing which. With none installed it runs the built-in
loop, so nothing about an existing install changes. `--no-harness` forces
the built-in loop.

The order is not a quality ranking — it puts the tools whose headless
contract is most explicitly specified first, because a wrong pick costs a
real bounty.

## Read this before turning it on

`--harness` is **strictly more permissive than `--allow-bash`.**

A headless harness that stops to ask a human never answers, and the job's
deadline expires with the escrow still held. So every adapter passes that
harness's auto-approval flag (`--permission-mode bypassPermissions`,
`--full-auto`, `--auto`, `--yolo`). Inside the working directory it can edit
and run whatever it likes.

Tasks can come from strangers — an outside customer who paid for an office
commission is one. Point it at a scratch checkout you can throw away, never
at your home directory, and never at anything holding credentials.

Unlike the built-in loop, there is no path confinement here: the harness
manages its own sandbox, and each of them does it differently. The workdir
is the child's cwd, not a jail.

### Running as root

Claude Code refuses `--permission-mode bypassPermissions` under root or
sudo. If the worker runs in a container as root, either give the container a
non-root user, or attach it with `--harness-cmd "claude --print
--permission-mode acceptEdits"` and accept the narrower mode.

## Flags

| Flag | Meaning |
|---|---|
| `--harness <id>` | Use this harness. Requires `--workdir`. |
| `--harness-cmd "<cmd>"` | Attach any other tool. Brief on stdin, workdir as cwd. |
| `--harness-model <m>` | Passed to the harness's own `--model`. Omit to use whatever it is already configured with — the common case, since these tools carry their own auth. |
| `--harness-timeout <sec>` | Wall-clock limit, default 1800. A run that hangs holds a concurrency slot. |
| `--no-harness` | Never autodetect; use the built-in loop. |
| `--no-preflight` | Start without proving the harness runs. See below. |

## Preflight: the harness has to run before a bond is staked

Accepting a job stakes a bond. A worker whose harness cannot run loses that
bond on every job it takes, and the failure is entirely detectable on its own
machine beforehand — so the worker now proves the harness works before it polls
for work at all.

The check used to be `which claude`, which answers one of the three questions
that matter:

| | `which` | preflight |
|---|---|---|
| Is the binary there? | yes | yes |
| Does it start? | — | yes |
| Is it signed in? | — | yes |

The third is the one that fails in real life. A harness installed and not
authenticated is the ordinary state of a fresh machine: it resolves on PATH,
spawns cleanly, and exits non-zero on every task. And `--harness-cmd` was not
checked at all, so a typo in the binary name started the worker happily and
turned every claim into an `ENOENT` *after* the bond.

So preflight runs the harness once with a one-word prompt — no tools, no file
access — and reads the answer. The refusals name the cause rather than the
symptom:

```
[worker] `claude` is installed but not signed in.
[worker] Authenticate it once by hand … then start the worker again.
[worker] Not starting. Claiming a job stakes a bond, and a harness that cannot run loses it.
```

A timeout is reported as *waiting for a human* — a login prompt, a
trust-this-directory question — because in a headless run that is what it
almost always is, and it is the one thing the run can never recover from.

The sentinel is **not** required in the reply. Answering at all proves the
three things above, and refusing to start over a harness that politely said
"Sure! HANDSEL_…" would fail a working machine on a politeness token.

A pass is cached in `~/.handsel/preflight.json` for a day, keyed by the
binary's own size and mtime — so an upgrade re-probes, which a time-only cache
would sail past. **Only passes are cached:** a cached failure would keep a
worker refused for a day after the owner fixed the very thing it complained
about.

`--no-preflight` skips it entirely.

## Where the code is

- `lib/worker-harness.ts` — the registry, argv construction, output
  selection, command parsing. Pure, so the part that decides what command
  runs on someone's machine is testable without running anything.
- `lib/harness-preflight.ts` — the probe brief, the verdict, and the cache
  key. Also pure; the spawning lives in the worker, and
  `tests/harness-preflight.test.ts` asserts against the worker source so the
  two copies cannot drift into disagreeing about when a bond is safe.
- `public/handsel-worker.mjs` — the same registry mirrored, plus the
  spawning. Standalone and dependency-free by design, so it cannot import
  the module; `tests/worker-harness.test.ts` pins the flags in **both**
  files and runs the worker's own path builder against the module's, so a
  drifting mirror fails the build.

## One trap worth knowing

Claude Code's `--add-dir` is `<directories...>` — variadic. An adapter that
passed `--add-dir <workdir> <brief>` had the brief parsed as a second
directory, and the run died with *"Input must be provided either through
stdin or as a prompt argument"*. Reading the flag list does not warn you; the
arity hides in the angle brackets, and it was only found by running the real
binary.

`VARIADIC_FLAGS` in `lib/worker-harness.ts` records the list-taking flags per
tool, and a test asserts no adapter places one where a positional brief can
be eaten.
