# Reference image prompts

What this repo actually needs generated art for, and the prompt for each.

Every prompt below carries the **real palette** out of
`app/(dashboard)/office/game3d/theme.ts` and `app/globals.css`, and the real
scene vocabulary out of `app/(dashboard)/office/game/world.ts` — nine
departments, three room kinds (`dept`, `ceo`, `lounge`), and the prop list the
collision grid already uses (desk, ceo-desk, table, sofa, shelf, cabinet,
coffee counter, plant, rug). A reference that invents its own furniture is a
reference nobody can build toward.

## Two rules for all of them

**No text in the image.** Every model garbles lettering, and a reference sheet
with fake words on the monitors is a reference that has to be explained away.
Where a deliverable genuinely needs words — the social card — the words are
composited in code, not generated. Each prompt ends with a negative clause
saying so.

**Aspirational but reachable.** The 3D office renders in real time (R3F,
VSM soft shadows, SSAO, SMAA, bloom on emissive materials, an orthographic
isometric camera). Prompts ask for a look that pipeline can converge on:
soft key light, ambient occlusion in the corners, emissive screens. Not
ray-traced caustics and depth-of-field bokeh nobody can ship at 60fps.

---

## 1. Social card background — **the only actual hole**

`app/layout.tsx` sets `openGraph` and `twitter` metadata with **no image**,
and `twitter.card: 'summary'` (the small, imageless card). Every share of
handsel-main, of a storefront, of `/live` currently renders as a bare text
link. This is the highest-value image on the list.

**DONE — and not with a model.** `app/opengraph-image.tsx` lays the headline
out as real text with Next's `ImageResponse`, over a plate drawn
deterministically in `lib/og-deck.ts` — an isometric deck built from the same
`game3d/theme.ts` palette the office renders with, so the card cannot drift
from the product. `twitter.card` is now `summary_large_image`.

Generated art was the wrong tool for the whole card twice over: models garble
lettering, and a headline baked into a raster goes stale the moment the claim
changes. This one is one edit away from correct, forever, and the chain line
is derived from `isRealMoney()` rather than written down — a link preview
outlives the deployment it was written against.

The prompt below is kept only as the record of what was asked for. Nothing
needs to be generated for this item.

```
A wide cinematic background plate for a technology product card. Orthographic
isometric view of a small dark command-deck interior, seen from above and to
the side, floating on a deep near-black background with soft vignetting at the
edges. Interior surfaces are desaturated blue-slate (#18242f floors, #0d151d
walls, #243444 desk tops, #38506a frames); a single cyan (#4fd8ff) accent runs
through door frames, thin floor grid lines and the emissive glow of small
screens. One warm pale-blue pool of light (#bfe6ff) hangs over the room and
falls off into darkness. A faint volumetric haze between camera and subject.
The composition is deliberately weighted to the RIGHT THIRD of the frame, with
the left two thirds nearly empty dark space for a headline to sit over.
Clean, restrained, engineering-instrument mood — not neon cyberpunk clutter.
Render quality: soft shadows, ambient occlusion in the corners, gentle bloom
only on the emissive cyan.
NEGATIVE: no text, no letters, no numbers, no logos, no UI labels, no
watermark, no people, no faces.
```

---

## 2. Office look reference — **Tactical Command**

The default theme (`THEMES.tactical`, brand `HANDSEL // OFFICE DECK`). This is
the target the game3d scene builds toward: what a "good" frame looks like once
lighting, props and avatars are all right.

Output: `docs/assets/ref-office-tactical.png`, 2400×1350 (16:9).

```
Orthographic isometric cutaway of a miniature open-plan command deck, viewed
from a fixed 45-degree game camera, the whole floorplan visible at once with
no perspective distortion. A ring of low walls encloses several connected
rooms on one deck: a large central floor of paired workstations, a raised
corner office with a wide desk and a rug, and a soft lounge corner with a sofa,
a low table and a coffee counter. Potted plants punctuate the walkways.
Materials: matte blue-slate floors (#18242f), a slightly bluer raised floor for
the corner office (#20304a), a green-tinted lounge floor (#16292a), near-black
walls (#0d151d) with recessed panels glowing faintly in cyan (#0e3a4a), amber
(#4a350e) and red (#4a0e0e). Desk tops #243444 on #38506a frames, dark fabric
#1e2c3a on the seating, deep green foliage #2f7d5c. Every monitor and wall
panel emits a soft cyan (#4fd8ff). A warm pale-blue key light (#bfe6ff) pools
over each room and falls off into fog toward the far edge of the deck.
Feels like a lit architectural model of a working operations floor at night —
inhabited, orderly, slightly cold. Soft shadows, strong ambient occlusion where
props meet the floor, restrained bloom only on emissive surfaces.
NEGATIVE: no text, no letters, no signage, no logos, no UI overlay, no HUD,
no perspective vanishing point, no lens flare, no rain, no neon clutter.
```

## 3. Office look reference — **Pastel Diorama**

The second registered theme (`THEMES.diorama`, `glow: false`, flat fills, no
bloom). It ships as a real theme, not an afterthought, so it needs its own
target frame — this is also the theme closest to the pixel-art mockup.

Output: `docs/assets/ref-office-diorama.png`, 2400×1350.

```
Orthographic isometric cutaway of a miniature toy office, viewed from a fixed
45-degree game camera, the whole floorplan visible at once. Same layout as a
tabletop diorama: an open floor of paired desks, a corner office with a wide
desk and a rug, a lounge with a sofa, low table and coffee counter, potted
plants along the walkways. Warm plum-brown walls (#4a2b3c) around near-white
floors (#fffdfe), a blush floor in the corner office (#ffeff6) and a mint floor
in the lounge (#eefaf4). Wooden desk tops (#e8c9a8) on warm tan frames
(#a97d5e), pink fabric seating (#ffb3d1), soft green foliage (#7fc8a0), pale
blue screens (#cfeaff), a single saturated yellow (#ffd83d) on the doors as the
one bright accent. Everything sits on a deep plum backdrop (#23161f) so the
pale interior reads as a lit object.
Flat, clean, matte — like a photographed paper-craft or clay model. Even warm
ambient light (#fff3e0) with a soft overhead pool (#ffe6c2); gentle contact
shadows, no glow, no bloom, no emission.
NEGATIVE: no text, no letters, no signage, no logos, no UI overlay, no glow,
no neon, no bloom, no perspective vanishing point, no people, no faces.
```

---

## 4. Agent character sheet

`AgentAvatars.tsx` builds each agent from primitives — a tapered torso, limbs,
a head — and the ten roles in `office-world-data.ts` (Miner, Scout, Reviewer,
Architect, Analyst, Scribe, Courier, Sentinel, Broker, Delegate) are currently
told apart only by colour. A silhouette sheet is what makes them readable at
the zoom the camera actually sits at.

Note `public/agent-atlas.png` exists and is referenced by nothing — treat it as
stale, not as the current design.

Output: `docs/assets/ref-agents-tactical.png` / `-diorama.png`, 2048×2048.

```
A character design sheet: ten small stylised robot office-worker figures in one
even grid on a plain flat background, each shown standing in a neutral pose,
full body, front three-quarter view, all at identical scale and identical
lighting.
Construction is deliberately simple and geometric — a tapered capsule torso,
tube limbs, a rounded head with a single glowing visor band instead of a face.
No hands, no fingers, no mouth. Each of the ten is distinguished by SILHOUETTE
and one accessory, not by facial detail: a hard hat, a satchel, a clipboard, a
drafting square, a visor, a scroll tube, a courier tube, a shoulder pauldron, a
ledger, a headset. Chunky, readable at very small size.
Palette: dark blue-slate bodies (#243444 / #38506a) with a cyan (#4fd8ff)
visor and accent trim, one figure in warm amber (#ffb84f) and one in green
(#57ffb0) to show the state colours.
Clean studio lighting, soft shadow under each figure, matte plastic-toy
material.
NEGATIVE: no text, no labels, no numbers, no name plates, no logos, no human
faces, no eyes, no mouths, no weapons, no background scene.
```

For the diorama variant, swap the palette clause for: *warm cream and tan
bodies (#e8c9a8 / #a97d5e) with a pale-blue (#cfeaff) visor, pink (#ffb3d1)
and yellow (#ffd83d) accents; flat matte, no glow.*

---

## 5. Office template cards

`list_office_templates` / `hire_office` offer eight desks — Securities Office,
Talent Agency, Bootstrap Desk, Research Desk, Due Diligence Desk, Cloud Options
Desk, Growth Studio, Venture Lab — and the storefront (`set_storefront`) sells
them to outside clients with no picture at all. A shop with no sign.

One prompt, run eight times with the bracket swapped.

Output: `public/office-cards/<template-id>.png`, 1200×800 (3:2).

```
A small isometric vignette of a single specialist workstation, floating on a
plain dark background with a soft shadow beneath it, cropped close — one desk
and its immediate props only, not a whole floor.
The desk is [SWAP: a trading desk with three stacked monitors and a printed
tape / a casting desk with a pinboard of headshot cards / a bare startup desk
with one laptop and a cardboard box / a research desk buried in open books and
a reading lamp / a due-diligence desk with a document stack, a magnifier and a
stamp / a cloud-architecture desk with a rack diagram pinned above it / a
growth desk with a wall of small charts / a lab bench with instruments and a
whiteboard].
Blue-slate materials (#243444 tops, #38506a frames) on a near-black ground
(#070a0f), one cyan (#4fd8ff) emissive accent from the screens, a warm pale
key light (#bfe6ff) from above left. Soft shadows, ambient occlusion, a little
bloom on the cyan.
Consistent camera angle, scale and lighting across the whole set so the eight
sit together as one family.
NEGATIVE: no text, no letters, no numbers on the screens or documents, no
logos, no charts with readable labels, no people, no faces, no background room.
```

---

## 6. README / docs hero — optional

`docs/assets/` holds four hand-drawn SVG diagrams (`pitch-architecture`,
`pitch-banner`, `pitch-credit-loop`, `pitch-flow`) and two demo videos. Those
are the right medium for explaining the system and should stay. What is missing
is one atmospheric image at the top of the README.

Output: `docs/assets/hero.png`, 2400×1200.

```
A wide atmospheric render of two miniature isometric office decks floating in
dark empty space, separated by a gap, with a single thin luminous cyan
(#4fd8ff) thread arcing between them from a desk on one deck to a desk on the
other. Both decks are the same dark blue-slate command-deck interiors (#18242f
floors, #0d151d walls, #243444 desks) lit by their own warm pale-blue pools
(#bfe6ff), small enough that neither dominates. Deep near-black background
(#070a0f) with soft haze.
The reading is one workplace hiring another across a distance. Quiet,
architectural, a little lonely. Soft shadows, ambient occlusion, bloom only on
the thread and the screens.
NEGATIVE: no text, no letters, no logos, no arrows, no diagram labels, no
people, no faces, no city skyline, no planets.
```

---

## 7. Department glyphs — optional

The nine functional departments (`lib/office-functional-departments.ts`) are
labelled with emoji today: 🔎 Research Lab, 🧭 Strategy Room, 🛠️ Engineering
Floor, 🧨 QA/Red Team, ⚖️ Verification Court, 🗄️ Memory Archive, 🏋️ Skill Gym,
💰 Treasury, 🌐 Market. Emoji render differently on every platform and carry
someone else's visual language. A real set is a nice-to-have, not a hole.

Output: `public/dept/<id>.svg` (trace the raster), 512×512 each.

```
A set of nine minimal line icons on one sheet, evenly spaced, all drawn with
the same uniform 2px stroke weight, rounded caps, no fill, on a plain
background: a magnifier over a document, a compass rose, a wrench crossed with
a bracket, a small blast charge, a balance scale, a stack of drawers, a
dumbbell, a vault door, a globe with a gateway arch.
Geometric and flat, drawn on a consistent grid, all optically the same weight
and size, single colour cyan (#4fd8ff) on transparent. Icon-set discipline —
they must read at 24px.
NEGATIVE: no text, no letters, no filled shapes, no gradients, no shadows, no
3D, no perspective, no colour variation between icons.
```

---

## Housekeeping found while writing this

`public/` still carries v0 scaffolding that nothing imports:
`placeholder-logo.png`, `placeholder-logo.svg`, `placeholder-user.jpg`,
`placeholder.jpg`, `placeholder.svg`, and `agent-atlas.png`. Verified
unreferenced across `.ts`/`.tsx`. They are shipped to every visitor's origin
and mean nothing. Deleting them is a separate, unrelated change.
