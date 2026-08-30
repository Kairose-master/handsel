# Reference image prompts

Copy-paste prompts for generating this project's art in whatever image tool
you use. One block per image. Everything else on this page is about how to
run them.

Every prompt carries the **real palette** out of
`app/(dashboard)/office/game3d/theme.ts` and the real scene vocabulary out of
`app/(dashboard)/office/game/world.ts` — nine departments, three room kinds
(`dept`, `ceo`, `lounge`), and the props the collision grid already uses
(desk, ceo-desk, table, sofa, shelf, cabinet, coffee counter, plant, rug). A
reference that invents its own furniture is one nobody can build toward.

## How to run these

**Aspect ratio / size.** Each block says what it wants. Append per tool:

| tool | how to set it | negatives |
|---|---|---|
| Midjourney | `--ar 16:9 --style raw` (`--ar 1:1`, `--ar 3:2`) | `--no text, letters, logos, people` |
| Nano Banana / Gemini | say the ratio in the prompt; it follows prose | keep the `NEGATIVE:` line — it reads it |
| GPT Image | pick 1536×1024 / 1024×1024 in the UI | keep the `NEGATIVE:` line |
| Flux / SDXL | set width/height explicitly | paste the `NEGATIVE:` line into the negative field |
| Imagen | `aspectRatio: "16:9"` | `negativePrompt` param |

**No text in any of them.** Every model garbles lettering, and a reference
sheet with fake words on the monitors is a reference that has to be explained
away each time it is used. The social card that genuinely needs words is
already built in code (`app/opengraph-image.tsx`) — none of these need to
carry type.

**For the sets (C/D and E), consistency beats any single image.** Lock the
seed, generate the whole set at that seed, and change only the bracketed
clause between runs. Different seeds give you eight good images that do not
belong together, which for a storefront grid is worse than eight mediocre
ones that do.

**Generate four, pick one, then vary.** These are look targets, not final
assets — the 3D scene has to converge on them, so pick the one a real-time
renderer could actually reach.

---

## A. Office look — Tactical Command

The default theme (`THEMES.tactical`). The target the game3d scene builds
toward: what a good frame looks like once lighting, props and avatars are all
right. **16:9, as large as the tool allows.**

```
Orthographic isometric cutaway of a miniature open-plan command deck, viewed
from a fixed 45-degree game camera, the whole floorplan visible at once with no
perspective distortion. A ring of low walls encloses several connected rooms on
one deck: a large central floor of paired workstations, a raised corner office
with a wide desk and a rug, and a soft lounge corner with a sofa, a low table
and a coffee counter. Potted plants punctuate the walkways.
Materials: matte blue-slate floors (#18242f), a slightly bluer raised floor for
the corner office (#20304a), a green-tinted lounge floor (#16292a), near-black
walls (#0d151d) with recessed panels glowing faintly in cyan (#0e3a4a), amber
(#4a350e) and red (#4a0e0e). Desk tops #243444 on #38506a frames, dark fabric
#1e2c3a on the seating, deep green foliage #2f7d5c. Every monitor and wall panel
emits a soft cyan (#4fd8ff). A warm pale-blue key light (#bfe6ff) pools over each
room and falls off into fog toward the far edge of the deck.
Feels like a lit architectural model of a working operations floor at night —
inhabited, orderly, slightly cold. Soft shadows, strong ambient occlusion where
props meet the floor, restrained bloom only on emissive surfaces.
NEGATIVE: no text, no letters, no signage, no logos, no UI overlay, no HUD, no
perspective vanishing point, no lens flare, no rain, no neon clutter.
```

## B. Office look — Pastel Diorama

The second registered theme (`THEMES.diorama`, `glow: false`, flat fills, no
bloom). Closest to the pixel-art mockup. **16:9.**

```
Orthographic isometric cutaway of a miniature toy office, viewed from a fixed
45-degree game camera, the whole floorplan visible at once. Laid out like a
tabletop diorama: an open floor of paired desks, a corner office with a wide desk
and a rug, a lounge with a sofa, low table and coffee counter, potted plants
along the walkways. Warm plum-brown walls (#4a2b3c) around near-white floors
(#fffdfe), a blush floor in the corner office (#ffeff6) and a mint floor in the
lounge (#eefaf4). Wooden desk tops (#e8c9a8) on warm tan frames (#a97d5e), pink
fabric seating (#ffb3d1), soft green foliage (#7fc8a0), pale blue screens
(#cfeaff), a single saturated yellow (#ffd83d) on the doors as the one bright
accent. Everything sits on a deep plum backdrop (#23161f) so the pale interior
reads as a lit object.
Flat, clean, matte — like a photographed paper-craft or clay model. Even warm
ambient light (#fff3e0) with a soft overhead pool (#ffe6c2); gentle contact
shadows, no glow, no bloom, no emission.
NEGATIVE: no text, no letters, no signage, no logos, no UI overlay, no glow, no
neon, no bloom, no perspective vanishing point, no people, no faces.
```

---

## C. Agent character sheet — tactical

`AgentAvatars.tsx` builds each agent from primitives, and the ten roles in
`office-world-data.ts` (Miner, Scout, Reviewer, Architect, Analyst, Scribe,
Courier, Sentinel, Broker, Delegate) are told apart only by colour today. This
sheet is what makes them readable at the zoom the camera actually sits at.

`public/agent-atlas.png` exists and nothing references it — stale, not the
current design. **Square, 2048×2048.**

```
A character design sheet: ten small stylised robot office-worker figures in one
even grid on a plain flat background, each standing in a neutral pose, full body,
front three-quarter view, all at identical scale and identical lighting.
Construction is deliberately simple and geometric — a tapered capsule torso, tube
limbs, a rounded head with a single glowing visor band instead of a face. No
hands, no fingers, no mouth. Each of the ten is distinguished by SILHOUETTE and
one accessory, not by facial detail: a hard hat, a satchel, a clipboard, a
drafting square, a visor, a scroll tube, a courier tube, a shoulder pauldron, a
ledger, a headset. Chunky, readable at very small size.
Palette: dark blue-slate bodies (#243444 and #38506a) with a cyan (#4fd8ff)
visor and accent trim; one figure in warm amber (#ffb84f) and one in green
(#57ffb0) to show the state colours.
Clean studio lighting, a soft shadow under each figure, matte plastic-toy
material.
NEGATIVE: no text, no labels, no numbers, no name plates, no logos, no human
faces, no eyes, no mouths, no weapons, no background scene.
```

## D. Agent character sheet — diorama

Same sheet, second theme. **Square, 2048×2048, same seed as C.**

```
A character design sheet: ten small stylised robot office-worker figures in one
even grid on a plain flat background, each standing in a neutral pose, full body,
front three-quarter view, all at identical scale and identical lighting.
Construction is deliberately simple and geometric — a tapered capsule torso, tube
limbs, a rounded head with a single visor band instead of a face. No hands, no
fingers, no mouth. Each of the ten is distinguished by SILHOUETTE and one
accessory, not by facial detail: a hard hat, a satchel, a clipboard, a drafting
square, a visor, a scroll tube, a courier tube, a shoulder pauldron, a ledger, a
headset. Chunky, readable at very small size.
Palette: warm cream and tan bodies (#e8c9a8 and #a97d5e) with a pale-blue
(#cfeaff) visor, pink (#ffb3d1) and yellow (#ffd83d) accents. Flat matte
paper-craft material, no glow, no emission.
Even soft light, gentle contact shadow under each figure.
NEGATIVE: no text, no labels, no numbers, no name plates, no logos, no human
faces, no eyes, no mouths, no weapons, no background scene, no glow, no neon.
```

---

## E. Office template cards — run eight times

`list_office_templates` / `hire_office` offer eight desks, and the storefront
(`set_storefront`) sells them to outside clients with no picture at all. A shop
with no sign.

Same prompt eight times, **same seed**, swapping only the bracket. **3:2,
1200×800.**

| run | swap in |
|---|---|
| Securities Office | a trading desk with three stacked monitors and a printed tape |
| Talent Agency | a casting desk with a pinboard of blank headshot cards |
| Bootstrap Desk | a bare startup desk with one laptop and a cardboard box |
| Research Desk | a research desk buried in open books and a reading lamp |
| Due Diligence Desk | a due-diligence desk with a document stack, a magnifier and a stamp |
| Cloud Options Desk | a cloud-architecture desk with a rack diagram pinned above it |
| Growth Studio | a growth desk with a wall of small unlabelled charts |
| Venture Lab | a lab bench with instruments and a blank whiteboard |

```
A small isometric vignette of a single specialist workstation, floating on a plain
dark background with a soft shadow beneath it, cropped close — one desk and its
immediate props only, not a whole floor.
The desk is [SWAP].
Blue-slate materials (#243444 tops, #38506a frames) on a near-black ground
(#070a0f), one cyan (#4fd8ff) emissive accent from the screens, a warm pale key
light (#bfe6ff) from above left. Soft shadows, ambient occlusion, a little bloom
on the cyan.
Fixed 45-degree isometric camera, identical scale and identical lighting every
time, so a set of these sits together as one family.
NEGATIVE: no text, no letters, no numbers on the screens or documents, no logos,
no charts with readable labels, no people, no faces, no background room.
```

---

## F. Launch / README hero

`docs/assets/` holds four hand-drawn SVG diagrams and two demo videos — right
medium, keep them. What is missing is one atmospheric image at the top of the
README and for launch posts. **2:1, 2400×1200.**

```
A wide atmospheric render of two miniature isometric office decks floating in dark
empty space, separated by a gap, with a single thin luminous cyan (#4fd8ff)
thread arcing between them from a desk on one deck to a desk on the other. Both
decks are dark blue-slate command-deck interiors (#18242f floors, #0d151d walls,
#243444 desks) lit by their own warm pale-blue pools (#bfe6ff), small enough that
neither dominates. Deep near-black background (#070a0f) with soft haze.
The reading is one workplace hiring another across a distance. Quiet,
architectural, a little lonely. Soft shadows, ambient occlusion, bloom only on the
thread and the screens.
NEGATIVE: no text, no letters, no logos, no arrows, no diagram labels, no people,
no faces, no city skyline, no planets.
```

## G. Department glyphs

The nine functional departments (`lib/office-functional-departments.ts`) are
labelled with emoji today: 🔎 Research Lab, 🧭 Strategy Room, 🛠️ Engineering
Floor, 🧨 QA/Red Team, ⚖️ Verification Court, 🗄️ Memory Archive, 🏋️ Skill Gym,
💰 Treasury, 🌐 Market. Emoji render differently on every platform and carry
someone else's visual language. **Square, 2048×2048; trace to SVG afterwards.**

```
A set of nine minimal line icons on one sheet, evenly spaced in a 3x3 grid, all
drawn with the same uniform stroke weight, rounded caps, no fill, on a plain flat
background: a magnifier over a document, a compass rose, a wrench crossed with a
bracket, a small blast charge, a balance scale, a stack of drawers, a dumbbell, a
vault door, a globe with a gateway arch.
Geometric and flat, drawn on a consistent grid, all optically the same weight and
size, single colour cyan (#4fd8ff) on a transparent or plain background. Icon-set
discipline — they must stay readable at 24 pixels.
NEGATIVE: no text, no letters, no filled shapes, no gradients, no shadows, no 3D,
no perspective, no colour variation between icons, no frames around the icons.
```

---

## Generated — where each one landed

| block | file(s) |
|---|---|
| A · office look, tactical | `docs/assets/ref-office-tactical.png` |
| B · office look, diorama | `docs/assets/ref-office-diorama.png` |
| C · agent sheet, tactical | `docs/assets/ref-agents-tactical.png` |
| D · agent sheet, diorama | `docs/assets/ref-agents-diorama.png` |
| E · desk cards | `public/office-cards/<template-id>.png` × 8 — **shipped**, rendered in the office template picker |
| F · hero | `docs/assets/hero.png` — top of the README |
| G · department glyphs | `public/dept/<dept-id>.png` × 9 |

E and G are named by ID, not by label, and `tests/office-art.test.ts` fails the
build if a template or department ever lacks its file — or if art is left
behind for one that no longer exists. Art referenced by id and stored by file
name drifts silently otherwise: someone adds a ninth template, the picker
renders a broken image, and nothing complains.

A–D and F are reference sheets: the target the real-time scene builds toward,
not assets it loads. What has actually been built toward them so far:

| from | change |
|---|---|
| C/D · the visor band | every avatar has one — it replaces a face this geometry never had, and two boxes for a head read as a crate until something crosses them horizontally |
| C/D · one accessory each | `lib/office-avatar-kit.ts` maps the agent's LIVE department to a hard hat / satchel / clipboard / pauldron / tube / headset / square, so the kit is a readout of what it is doing rather than a costume |
| A/B · a chair at every desk | the scene had none, which is most of why the deck read as a showroom rather than a place people work |

Still on the sheets and not in the scene: wall-mounted displays, doors,
framed art, a printer, ceiling pendants, and the denser prop population the
rooms have in A and B.

## Already built, no generation needed

The social card. `app/opengraph-image.tsx` lays the headline out as real text
over a deck drawn deterministically in `lib/og-deck.ts`, from this same
`theme.ts` palette. Generated art was the wrong tool for it twice over: models
garble lettering, and a headline baked into a raster goes stale the moment the
claim changes.

## Housekeeping found while writing this

`public/` still carries v0 scaffolding that nothing imports:
`placeholder-logo.png`, `placeholder-logo.svg`, `placeholder-user.jpg`,
`placeholder.jpg`, `placeholder.svg`, and `agent-atlas.png`. Verified
unreferenced across `.ts`/`.tsx`. Deleting them is a separate change.
