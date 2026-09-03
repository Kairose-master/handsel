# The fleet landing — design note and references

*2026-09-03. The big picture as a page a buyer can act on: `/fleet`.*

## What it has to say

One sentence, then a picture that proves it: **run a fleet of agents that
can all pay.** Not "hire an agent" — the reader already runs a business as a
system of boxes and wants each box filled reliably and reviewably. The page
shows their map, puts a wallet under every box, and then shows the six
steps by which a box gets filled and paid only on a passing deliverable.

## References, and what each gave

| reference | what it gave | what it did not |
|---|---|---|
| The reel (mrnotion.co, 2026-06, ~4k likes, ~650 comments) — one monitor, the whole business as a map, a hand pointing at boxes; "nothing lives in my head; review last month and adjust" | **The hero.** A dark canvas, light boxes, a core cluster (marketing, sales, customer admin, operations, finance) with flows around it (funnels, content, ads, leads, email/SMS). The map *is* the argument; the page opens on it. | Anything about money or verification — the reel is about seeing, not paying. |
| Fleet / control-room dashboard guides (Hicron, heavyvehicleinspection, volpis; Dribbble "Logistics & Fleet Dashboard") | **The readout.** Critical numbers in large type at the top; traffic-light status encoded in form (a pill), not only colour; a live map at the centre with side detail on selection. | A visual identity — these are generic SaaS dashboards; the palette and type here are the site's own. |
| Agent-orchestration UIs (agent-fleet-o, agentic-fleet-hub, LukeW's note) | Confirmation that "mission control" for agents is drawn as a live graph with a kanban of jobs beside it — and a warning: they all look the same. | Nothing to copy. |
| Notion business-dashboard templates (Notion Marketplace: Organized / Ultimate Business Dashboard) | The audience's own vocabulary: hubs, areas, one homepage reflecting every database. The desk table on the page uses their column names. | Visual detail — the marketplace pages carry screenshots, not descriptions, and were not inspected further. |

The two fetched reference pages returned no usable visual description; the
table says so rather than inventing one.

## Design plan

**Color.** The page uses the site's tokens (light `#fbfbfa` / dark `#070a0f`,
primary teal `#1f5f57` / `#4fd8ff`). The map is deliberately one-theme —
the reel's dark monitor whatever the page theme: canvas `#070a0f`, grid
`#0f1720`, box `#0d151d`, border `#1f2d3a`, text `#dff4ff`, dim `#7f97ab`,
thread `#2fa190`, wallet glyph `#e0b34a`. Status pills on the table use
amber (Ready), sky (Posted/Working), the success token (Delivered).

**Type.** Geist Sans for copy, Geist Mono for every number, id, status word
and file path — the site's existing pairing. Headline `clamp(2.4rem,5.2vw,4rem)`,
body 1.0625rem at 1.65 line height, 62ch measure.

**Layout.** Thesis (badge, h1, body, two CTAs) → the map full-width →
a one-line selection panel → three live numbers on a hairline grid →
six-step strip (each step names its source file) → the table you edit,
beside its three rules → three steps to start → footer. Nothing is
centred except the map caption.

**Motion.** None beyond hover and the selected thread brightening.
`prefers-reduced-motion` has nothing to suppress.

## Rules the page keeps

- **No fake data.** The three counters are live queries and print a dash
  with a sentence when a read fails. The table's example row is labelled
  an example.
- **Nothing the code does not ship.** Boxes that claim an office template
  name a real `OFFICE_TEMPLATES` id (test-pinned); each pipeline step names
  the file that does it.
- **Honest about gaps.** The last line of the page lists what is not built.
