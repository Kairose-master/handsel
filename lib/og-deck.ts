/**
 * The isometric office deck that goes behind the social card.
 *
 * `app/layout.tsx` shipped `openGraph` and `twitter` metadata with no image
 * and `twitter.card: 'summary'` — the small, imageless card. Every share of
 * the market, of a storefront, of /live rendered as a bare text link. For a
 * product whose whole pitch is "a desk you can hire", that is the one picture
 * that should have existed first.
 *
 * ── Why this is code and not generated art ────────────────────────────────
 *
 * The card needs the product's own name and claim on it, and every image
 * model garbles lettering. So the words are laid out as real text by Satori
 * (`app/opengraph-image.tsx`) and only the BACKGROUND is drawn — here, as
 * deterministic SVG, from the same palette the 3D office actually renders
 * with (`app/(dashboard)/office/game3d/theme.ts`). Import rather than copy:
 * a card whose colours drift from the product it depicts is worse than none.
 *
 * Pure — a string in, a string out — so the geometry can be tested without a
 * rasteriser, and so the route stays a layout file rather than a drawing.
 */
import { THEMES, type OfficeTheme } from '@/app/(dashboard)/office/game3d/theme'

/** Half-width and half-height of one floor tile at scale 1. The 2:1 ratio is
 *  the same flattened isometric the game camera uses, so the card and the app
 *  read as the same place. Actual size is fitted to the plate — see `project`. */
const TW = 46
const TH = 23

/** Where the deck sits on the plate. Passed explicitly rather than read from
 *  module constants so the geometry can be FITTED: the first pass hard-coded
 *  the tile size and the deck ran off two edges of the card. */
type Proj = { ox: number; oy: number; tw: number; th: number }

type Zone = 'dept' | 'ceo' | 'lounge'

/** The deck, as tiles. Rows are drawn back-to-front so nearer geometry
 *  overlaps farther geometry — there is no z-buffer in an SVG. */
const COLS = 9
const ROWS = 7

function zoneAt(x: number, y: number): Zone {
  if (y >= 5) return 'lounge'
  if (x >= 6 && y <= 2) return 'ceo'
  return 'dept'
}

/** One piece of furniture, in tile coordinates. Deliberately the same
 *  vocabulary the collision grid uses (`office/game/world.ts`): desks,
 *  a ceo desk, a table, a sofa, shelving, plants. */
type Piece = { x: number; y: number; w: number; d: number; h: number; kind: 'desk' | 'ceo-desk' | 'sofa' | 'table' | 'shelf' | 'plant' }

const PIECES: Piece[] = [
  { x: 0.4, y: 0.5, w: 1.9, d: 0.9, h: 0.55, kind: 'desk' },
  { x: 3.0, y: 0.5, w: 1.9, d: 0.9, h: 0.55, kind: 'desk' },
  { x: 0.4, y: 2.4, w: 1.9, d: 0.9, h: 0.55, kind: 'desk' },
  { x: 3.0, y: 2.4, w: 1.9, d: 0.9, h: 0.55, kind: 'desk' },
  { x: 6.3, y: 0.8, w: 2.2, d: 1.0, h: 0.6, kind: 'ceo-desk' },
  { x: 6.5, y: 3.3, w: 0.8, d: 0.8, h: 1.5, kind: 'shelf' },
  { x: 0.6, y: 5.3, w: 2.4, d: 0.9, h: 0.7, kind: 'sofa' },
  { x: 3.6, y: 5.5, w: 1.0, d: 1.0, h: 0.35, kind: 'table' },
  { x: 5.6, y: 5.4, w: 0.6, d: 0.6, h: 1.0, kind: 'plant' },
  { x: 2.6, y: 4.3, w: 0.6, d: 0.6, h: 1.0, kind: 'plant' },
  { x: 8.0, y: 2.2, w: 0.6, d: 0.6, h: 1.0, kind: 'plant' },
]

/** Tile space → screen space. */
function iso(x: number, y: number, j: Proj): [number, number] {
  return [j.ox + (x - y) * j.tw, j.oy + (x + y) * j.th]
}

function pt(p: [number, number]): string {
  return `${p[0].toFixed(1)},${p[1].toFixed(1)}`
}

/** Shade a hex colour toward black. The two vertical faces of every box need
 *  to differ from its top or the whole deck reads as flat rhombuses. */
function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * factor))))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function box(
  p: Piece,
  j: Proj,
  faces: { top: string; left: string; right: string },
  emissive?: { face: 'left' | 'right'; color: string },
): string {
  const { x, y, w, d, h } = p
  const lift = h * j.th * 2 // one unit of height is two tile-halves tall
  const top = [iso(x, y, j), iso(x + w, y, j), iso(x + w, y + d, j), iso(x, y + d, j)].map(
    ([sx, sy]) => [sx, sy - lift] as [number, number],
  )
  const bl = iso(x, y + d, j)
  const bm = iso(x + w, y + d, j)
  const br = iso(x + w, y, j)
  const left = `${pt(top[3])} ${pt(top[2])} ${pt(bm)} ${pt(bl)}`
  const right = `${pt(top[2])} ${pt(top[1])} ${pt(br)} ${pt(bm)}`
  const leftFill = emissive?.face === 'left' ? emissive.color : faces.left
  const rightFill = emissive?.face === 'right' ? emissive.color : faces.right
  return (
    `<polygon points="${left}" fill="${leftFill}"/>` +
    `<polygon points="${right}" fill="${rightFill}"/>` +
    `<polygon points="${top.map(pt).join(' ')}" fill="${faces.top}"/>`
  )
}

/** A monitor: a thin lit slab standing on a desk, which is what makes the
 *  deck read as inhabited rather than as furniture in an empty room. */
function monitor(p: Piece, j: Proj, theme: OfficeTheme): string {
  const screen: Piece = { x: p.x + p.w - 0.75, y: p.y + 0.15, w: 0.08, d: 0.6, h: p.h + 0.45, kind: p.kind }
  const base = box(screen, j, {
    top: theme.prop.frame,
    left: theme.prop.screen,
    right: shade(theme.prop.screen, 0.55),
  })
  return base
}

export type DeckOptions = {
  width: number
  height: number
  themeId?: keyof typeof THEMES
}

/**
 * The whole plate, as one SVG string.
 *
 * Drawn back-to-front in a single pass: floor tiles, then the wall ring, then
 * furniture sorted by depth. Anything that sorts wrong overlaps wrong, and in
 * a flat projection that reads instantly as broken, so the sort is the load-
 * bearing line in this function rather than an optimisation.
 */
export function deckSvg(opts: DeckOptions): string {
  const theme = THEMES[opts.themeId ?? 'tactical']
  const { width, height } = opts
  // FIT the deck to the plate rather than trusting a fixed tile size: the
  // first pass hard-coded one and the deck ran off the right and bottom
  // edges. The horizontal span is chosen first, everything else follows.
  //
  // Weighted to the right, deliberately: the left of the plate is where the
  // headline goes (app/opengraph-image.tsx), and a card whose art and words
  // fight for the same pixels is a card nobody reads.
  const span = width * 0.545
  const s = span / ((COLS + ROWS) * TW)
  const tw = TW * s
  const th = TH * s
  const deckH = (COLS + ROWS) * th
  // The wall stands ABOVE tile (0,0), so the drawing's visual top is higher
  // than its origin. Centre the drawing, not the origin, or the deck rides
  // high with dead space under it — which is what the first fit did.
  const wallLift = 1.15 * th * 2
  const j: Proj = {
    // Leftmost point is tile (0, ROWS); place it at 44% across.
    ox: width * 0.44 + ROWS * tw,
    oy: height * 0.5 - (deckH - wallLift) / 2,
    tw,
    th,
  }
  const centre = iso(COLS / 2, ROWS / 2, j)

  const floors: Record<Zone, string> = {
    dept: theme.floorDept,
    ceo: theme.floorCeo,
    lounge: theme.floorLounge,
  }

  const parts: string[] = []

  // Floor.
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const quad = [iso(x, y, j), iso(x + 1, y, j), iso(x + 1, y + 1, j), iso(x, y + 1, j)]
      parts.push(
        `<polygon points="${quad.map(pt).join(' ')}" fill="${floors[zoneAt(x, y)]}" stroke="${theme.floorLine}" stroke-width="1"/>`,
      )
    }
  }

  // The two FAR walls only. In this projection tile (0,0) is the top corner,
  // so the far edges are (0,0)→(COLS,0) and (0,0)→(0,ROWS). Taking the near
  // right edge instead — which is the easy mistake, since it is also "the
  // right wall" — stands a slab between the camera and the room it exists to
  // show, and the deck reads as sliced in half.
  const wallH = wallLift
  const backLeft = [iso(0, 0, j), iso(COLS, 0, j)]
  const backRight = [iso(0, ROWS, j), iso(0, 0, j)]
  parts.push(
    `<polygon points="${pt(backLeft[0])} ${pt(backLeft[1])} ${pt([backLeft[1][0], backLeft[1][1] - wallH])} ${pt([backLeft[0][0], backLeft[0][1] - wallH])}" fill="${theme.wall}"/>`,
    `<polygon points="${pt(backRight[0])} ${pt(backRight[1])} ${pt([backRight[1][0], backRight[1][1] - wallH])} ${pt([backRight[0][0], backRight[0][1] - wallH])}" fill="${shade(theme.wall, 0.78)}"/>`,
  )
  // Lit wall panels — the amber and cyan recesses the real scene has.
  const panelSpots: Array<[number, string]> = [
    [1.4, theme.wallGlowCyan],
    [3.6, theme.wallGlowAmber],
    [6.2, theme.wallGlowCyan],
  ]
  for (const [x, color] of panelSpots) {
    const a = iso(x, 0, j)
    const b = iso(x + 1.1, 0, j)
    parts.push(
      `<polygon points="${pt([a[0], a[1] - wallH * 0.28])} ${pt([b[0], b[1] - wallH * 0.28])} ${pt([b[0], b[1] - wallH * 0.82])} ${pt([a[0], a[1] - wallH * 0.82])}" fill="${color}"/>`,
    )
  }

  // Furniture, back to front. `x + y` is depth in this projection.
  const sorted = [...PIECES].sort((a, b) => a.x + a.y - (b.x + b.y))
  for (const p of sorted) {
    if (p.kind === 'plant') {
      // Pot, then foliage sitting ON the pot. A circle centred on the tile
      // rather than on the pot's lifted top floats beside it like a sticker,
      // which is exactly what the first pass looked like.
      const potH = 0.3
      const [sx, sy] = iso(p.x + p.w / 2, p.y + p.d / 2, j)
      const crown = sy - potH * th * 2
      parts.push(
        box({ ...p, h: potH }, j, {
          top: theme.prop.frame,
          left: shade(theme.prop.frame, 0.62),
          right: shade(theme.prop.frame, 0.82),
        }),
        `<ellipse cx="${sx.toFixed(1)}" cy="${(crown - tw * 0.3).toFixed(1)}" rx="${(tw * 0.32).toFixed(1)}" ry="${(tw * 0.27).toFixed(1)}" fill="${theme.prop.foliage}"/>`,
        `<ellipse cx="${(sx - tw * 0.16).toFixed(1)}" cy="${(crown - tw * 0.46).toFixed(1)}" rx="${(tw * 0.2).toFixed(1)}" ry="${(tw * 0.17).toFixed(1)}" fill="${shade(theme.prop.foliage, 1.18)}"/>`,
      )
      continue
    }
    const fabric = p.kind === 'sofa'
    const surface = fabric ? theme.prop.fabric : theme.prop.surface
    parts.push(
      box(p, j, {
        top: surface,
        left: shade(surface, 0.62),
        right: shade(surface, 0.8),
      }),
    )
    if (p.kind === 'desk' || p.kind === 'ceo-desk') parts.push(monitor(p, j, theme))
  }

  // A warm pool of light over the deck and a fog wash at the far edge — the
  // two things that carry "somebody works here" in the real scene.
  const glow = theme.glow
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<radialGradient id="pool" cx="${((centre[0] / width) * 100).toFixed(1)}%" cy="${((centre[1] / height) * 100).toFixed(1)}%" r="46%">`,
    `<stop offset="0%" stop-color="${theme.roomLight.color}" stop-opacity="${glow ? 0.22 : 0.3}"/>`,
    `<stop offset="100%" stop-color="${theme.roomLight.color}" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0%" stop-color="${theme.bg}" stop-opacity="0.92"/>`,
    `<stop offset="38%" stop-color="${theme.bg}" stop-opacity="0"/>`,
    `<stop offset="82%" stop-color="${theme.bg}" stop-opacity="0"/>`,
    `<stop offset="100%" stop-color="${theme.bg}" stop-opacity="0.96"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="${theme.bg}"/>`,
    `<rect width="${width}" height="${height}" fill="url(#pool)"/>`,
    ...parts,
    `<rect width="${width}" height="${height}" fill="url(#fade)"/>`,
    `</svg>`,
  ].join('')
}

/** The plate as a data URI, ready for an `<img src>` inside Satori. */
export function deckDataUri(opts: DeckOptions): string {
  return `data:image/svg+xml;base64,${Buffer.from(deckSvg(opts)).toString('base64')}`
}
