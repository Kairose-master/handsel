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

## Porting into Kairose-master/handsel

1. Drop `office-tactical.html`'s scene/agent/feed layers into
   `app/(dashboard)/office/game/` as a third renderer preset
   (`tactical-painted`) beside the DOM and R3F ones; register the backdrop +
   tokens in `tests/office-art.test.ts` (unreferenced-asset rule).
2. Replace the mock loop: bind DEPT anchors to the room layout and feed
   events from `buildOfficeSnapshot()` / `agent_events` — the anchors are
   already keyed by real `FunctionalDeptId`s and the feed rows are shaped
   like ops-step lines, so the swap is mechanical.
3. Bigger backdrop: re-run the art pipeline (docs/reference-images.md prompts
   derive from game3d/theme.ts) at 2-4K for a crisper base — the current
   backdrop is the 766px committed reference upscaled 2x.
4. Same layer stack works as a recording rig for reels: the AD1 storyboard's
   "camera over the office while agents work" beat becomes a real screen
   recording instead of a Ken Burns still.
