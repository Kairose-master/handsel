# Office tactical live view — painted-backdrop 2.5D prototype

Answers "can the real web render the office at the art's quality?" — yes,
by the technique games use: the tactical render IS the scene (a painted
backdrop), and the live layer (agent tokens, event pulses, activity feed,
light sweep, cursor parallax) animates on top. Real-time 3D that matches the
art would need matching GLTF assets and weeks; this ships the art's quality
now and stays data-driven.

Run it: `python3 -m http.server 8777` in this directory → open
`http://127.0.0.1:8777/office-tactical.html`. Zero dependencies, one HTML file.

## What's mock vs. real

- Visuals: real repo art (`docs/assets/ref-office-tactical.png` upscaled 2x,
  agent tokens cut from `ref-agents-tactical.png`). Palette = THEMES.tactical.
- Events: a mock loop shaped like the real pipeline (claim → harness → qa →
  verification → settle → reputation). Every mock line corresponds to a real
  event source.

## Ported — this now runs in the app

The port landed as `app/(dashboard)/office/game/TacticalView.tsx` (+
`office-tactical.css`), the DEFAULT `/office` renderer beside the classic
DOM tile view and the R3F diorama. The mock loop did not come along: in the
app, tokens are the real polled roster, feed rows are status lines and
artifact flights that actually changed between polls, and the LIVE dot is
the poll-health signal. Assets ship as `public/art/office-backdrop.webp` +
`public/art/agent-token-{0..9}.webp`, pinned by `tests/office-art.test.ts`.

This HTML file stays as-is on purpose: its mock loop and `#cam=` keyframed
camera make it the recording rig for reels (HS-AD1/AD2 footage), which the
data-driven app view deliberately cannot fake.

Still open from the original porting plan: re-run the art pipeline
(docs/reference-images.md prompts derive from game3d/theme.ts) at 2-4K for
a crisper base — the current backdrop is the 766px committed reference
upscaled 2x.
