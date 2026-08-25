# Handsel Office (desktop)

A native window around the live [`/office`](../app/(dashboard)/office/page.tsx)
page — the pixel office, driven by your account's real agent state, as its
own app instead of a browser tab. Nothing more: no local worker logic, no
polling, no offline cache. The window opens straight to
`https://handsel-main.vercel.app/office`, and everything about how the
office actually works — the room layout, the live-data engine, the "Hire
staff" flow — lives in the web app, not here.

Unlike [`desktop/`](../desktop) (the Miner, a real native client with its
own worker loop), this is intentionally as thin as Tauri allows: it exists
purely to give the office a dock icon and a window, the same reason
[`desktop-office/src-tauri/src/main.rs`](src-tauri/src/main.rs) is
eleven lines.

Sign-in works the same as in a browser — the webview keeps its own cookie
jar, so the first launch prompts you to sign in, and it stays signed in
after that like any browser tab would.

## Building locally

Requires the Rust toolchain and, on Linux, `libwebkit2gtk-4.1-dev` +
friends (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your OS — Windows and macOS need no extra system packages beyond what
`rustup` installs).

```bash
cd desktop-office/src-tauri
cargo tauri dev      # run it locally
cargo tauri build    # produce a release installer for your current OS
```

There's no frontend to build — the window loads the live site directly,
so there's no `desktop-office/src` and no bundler step.

## Producing real Windows/macOS installers

Same story as the Miner: this was written in a Linux-only sandbox with no
Windows/macOS toolchain or code-signing certs, so
[`.github/workflows/office-desktop-release.yml`](../.github/workflows/office-desktop-release.yml)
is the actual cross-platform build — `windows-latest`/`macos-latest`
GitHub-hosted runners, installers attached to a GitHub Release.

- **Real release (tag-based):** create a tag matching `office-v*` — the
  release publishes directly. Without a terminal: GitHub → Releases →
  "Draft a new release" → type a new `office-vX.Y.Z` tag (targeting
  `main`) → publish; the tag creation triggers the build. With a
  terminal: `git tag office-v0.1.0 && git push origin office-v0.1.0`.
  Bump the version in `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`
  first so the installer filenames match the tag.
- **Test build:** Actions tab → "Desktop Office — build installers" → Run
  workflow → produces a DRAFT release for review.

Same unsigned-build friction as the Miner applies (SmartScreen on
Windows, Gatekeeper's "is damaged" on macOS — see
[`desktop/README.md`](../desktop/README.md#unsigned-build-friction) for
the exact workarounds) — this isn't code-signed either.

## Changing which page it opens

`src-tauri/tauri.conf.json`'s `app.windows[0].url` is the only thing that
points this at `/office` specifically — repoint it at any other page on
the platform (or a different deployment, e.g. the Sepolia sandbox) by
editing that one field. No Rust changes needed.
