# Handsel Miner (desktop)

A small native GUI wrapper around the exact worker protocol documented in
[`docs/agent-integration.md`](../docs/agent-integration.md) §2 — the same
three HTTP calls `public/handsel-worker.mjs` makes, reimplemented in Rust
via [Tauri](https://tauri.app/) so a non-developer friend can download one
file, click through a short setup, and start mining with either a local
Ollama model or a pasted cloud API key. No terminal, no Node install.

This is a *client*, not a new protocol — everything it does, the existing
worker script and the [`sdk/`](../sdk) package already do. It exists purely
to remove the "open a terminal and run a command" step for people who
wouldn't otherwise clear that bar.

## What it does

Since v0.2 the Miner is a proper background app: closing the window
minimizes to the **system tray** and mining continues (reopen from the
tray icon; Quit from the tray menu actually stops it). Completed/failed
tasks fire **native notifications**, the dashboard shows the agent's live
**credit score and rating** alongside session stats and USDC balance, and
the whole UI has an **English/한국어 toggle**.

v0.4 makes the Miner **multi-modal and connector-aware**: an "Also mine
image jobs" toggle declares the `image` capability on the platform (live,
via `POST /api/worker/capabilities`) and fulfills image-deliverable jobs
through the free keyless generation API — the scarcer, better-paying
lane. A "Use Handsel from Claude / ChatGPT" section opens the
connector onboarding page (`/connect`), so the same account also works
as an MCP connector in Claude web, Claude Desktop, and ChatGPT.

v0.8.9 makes the **image and audio lanes model-selectable**, not just on/off.
Turning on image mining reveals an **image-model** dropdown populated from the
generation API's live model list (flux, turbo, …); turning on audio mining
reveals a **voice/language** dropdown for the TTS narration (English, 한국어,
日本語, …). Both choices persist and take effect on the next job without a
restart — so a Korean narration job is read in Korean, and image jobs use the
model you picked.

v0.8.8 adds a **searchable, capability-aware model picker**. Instead of typing a
model id by hand (and accidentally running a text-only model on image jobs, which
just fails grading), the setup step now has a **Browse models…** button that pulls
the provider's live `/models` list — keyless for **OpenRouter** (loaded the moment
you pick it), Bearer-authed for the others. You can search it and tick
**🖼️ image-capable only** to see just the models that can actually handle image
work. The list is fetched in Rust (the webview CSP blocks cross-origin fetches).

v0.8.7 adds **hosted-model provider presets**: the "no local Ollama" step now
offers one-tap chips for **Groq · OpenRouter · Hugging Face** (plus "Other" for
any OpenAI-compatible endpoint). Picking one fills the base URL, key hint, and
a sensible default model, with a direct link to grab a free/low-cost key — so
you connect a cloud model without typing an endpoint. All map to the same
`open_ai_compatible` backend under the hood.

v0.8.6 makes the Miner **collaboration-aware**: delegation jobs now arrive
with the full context baked into the brief — the collaboration plan (which
piece is yours), any upstream deliverables to build on, and, for review
jobs, the work to judge. The worker's system prompt recognizes these cues,
so the miner builds on upstream work instead of redoing it, returns a clean
`APPROVE` / `REVISE` verdict when it's the peer reviewer, and weaves parts
into one deliverable on synthesis jobs — no new toggles, it just handles the
richer jobs correctly.

v0.3 also makes the Miner **bidirectional**: a "Delegate work" panel lets
you flip sides of the market — describe a goal, review the planner's
priced subtasks, and approve to escrow bounties from the miner's own
earned USDC (`POST /api/delegations`; plan/confirm re-authenticate with
the account password, status polling uses the worker secret). Other
agents do the work, passing submissions auto-pay, and the assembled
result shows up in the panel.

v0.3 adds **Miner Buddy** — a minigame layer over the real mining stats
(nothing simulated): completed tasks grant XP with a streak bonus, the pet
evolves at level thresholds (🥚→🐣→🤖→🦾→👑→🐉→🌟), and ten achievements
unlock off task counts, streaks, USDC earned, and credit rating. Progress
persists locally in the app's own storage. On Linux the tray needs
`libayatana-appindicator3`; without it the app still runs and closing the
window quits normally.

1. **Connect an account** — email + password, calls `POST
   /api/agents/register` (one call: creates the account if needed, creates
   the agent, provisions its on-chain smart account, mints a worker secret).
   Credentials are saved locally in the OS's app-config directory, not sent
   anywhere else.
2. **Pick a model** — auto-detects a local Ollama install (`GET
   http://localhost:11434/api/tags`) and lets you choose a pulled model. If
   Ollama isn't found, falls back to pasting any OpenAI-compatible endpoint
   + API key (a free [Groq](https://console.groq.com/keys) key works well).
3. **Mine** — polls `POST /api/worker/poll`, runs the task against whichever
   backend you picked, submits via `POST /api/runtime/callback`. Same
   poll → run → submit loop as the terminal worker, just with Start/Stop
   buttons and a live log instead of a shell window.

## Building locally

Requires the Rust toolchain and, on Linux, `libwebkit2gtk-4.1-dev` +
friends (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your OS — Windows and macOS need no extra system packages beyond what
`rustup` installs).

```bash
cd desktop/src-tauri
cargo tauri dev     # run it locally with hot reload
cargo tauri build    # produce a release installer for your current OS
```

There's no frontend build step — `desktop/src` is plain HTML/CSS/JS served
as-is (`window.__TAURI__` is injected globally via `withGlobalTauri` in
`tauri.conf.json`, so no bundler is needed).

## Producing real Windows/macOS installers

This was written in a Linux-only sandbox with no Windows/macOS toolchain
and no code-signing certificates, so it can't build real `.exe`/`.dmg`
files itself. [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)
is the actual cross-platform build: it compiles `desktop/` on real
`windows-latest`/`macos-latest` GitHub-hosted runners and attaches the
installers to a **draft** GitHub Release (draft on purpose — a human
reviews and clicks "Publish" before anything goes out).

- **Real release (tag-based):** create a tag matching `desktop-v*` — the
  release publishes directly, no draft step. Without a terminal: GitHub →
  Releases → "Draft a new release" → type a new `desktop-vX.Y.Z` tag
  (targeting `main`) → publish; the tag creation triggers the build, which
  attaches the installers to that release. With a terminal: `git tag
  desktop-v0.1.1 && git push origin desktop-v0.1.1`. Bump the version in
  `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` first so the
  installer filenames match the tag.
- **Test build:** Actions tab → "Desktop Miner — build installers" → Run
  workflow → produces a DRAFT release for review (this path re-uploads
  assets into an existing published release of the same tag if one exists —
  the release page keeps its original date, so prefer tags for anything
  users will see).

### Unsigned-build friction

Neither build is code-signed (that needs a paid Apple Developer account /
Windows code-signing cert this project doesn't have), so:

- **Windows:** SmartScreen shows "Windows protected your PC" on first run —
  click "More info" → "Run anyway".
- **macOS:** Gatekeeper says the app "is damaged and can't be opened"
  (손상되었기 때문에 열 수 없습니다). The file is fine — this is what
  macOS shows for any unsigned, un-notarized app downloaded from a
  browser, and right-click → Open does *not* bypass it. Drag the app
  into Applications, then run this once in Terminal and open it
  normally afterwards:

  ```bash
  xattr -cr "/Applications/Handsel Miner.app"
  ```

  (This strips the download-quarantine flag; the app itself is
  untouched.)

Both are expected for an unsigned indie build, not a sign of a bad
download — worth saying so up front to anyone you send this to.

## Where your data goes

The account email/password only ever go to `POST /api/agents/register` on
the platform itself. The resulting `agent_id`/`secret` are stored in a
plain JSON file in the OS app-config directory (e.g.
`~/.config/com.handsel.miner/` on Linux, `~/Library/Application
Support/com.handsel.miner/` on macOS, `%APPDATA%\com.handsel.miner\`
on Windows) — nowhere else. A pasted cloud API key is stored the same way,
locally only, and is sent only to the base URL you configured for it (e.g.
Groq's own API), never to the Handsel platform.

## Repo jobs (the `code` lane)

GitHub repo jobs pay for a pull request that passes the requester's own CI.
They are the one lane the Miner does not drive itself: text/image/audio are a
single prompt in, an artifact out, but a repo job needs a clone, a multi-step
edit loop and a `git diff`. That loop is [Foreman](https://www.npmjs.com/package/@kairose-master/foreman),
so the lane shells out to `npx @kairose-master/foreman work` and confines
itself to the parts a desktop app is actually best at:

- **Folder consent.** Nothing is cloned until you pick a workspace directory.
  That folder is the entire permission boundary — no default, no guessed home
  directory, and it is remembered so you are asked once.
- **An honest readiness check.** Node, model credentials and the workspace are
  each either present or not, and the card names the single missing one rather
  than being a lane that silently never earns.

Requirements: Node 20+ on PATH and `ANTHROPIC_API_KEY` in your environment.

What this machine can and cannot do, by construction: it clones **public**
repositories over HTTPS, edits inside your chosen folder, and submits a
unified diff. It is never given repository credentials and cannot push. The
platform opens the pull request; your CI grades it; the requester merging is
what releases the escrow. The model budget is capped at the job's bounty, so a
run can never cost more than it pays.
