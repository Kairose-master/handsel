/**
 * The 3D office's own visual identity is a CHOICE, not a fixed look —
 * exactly the point of this file existing as a registry instead of one
 * constant. `game3d/` used to hard-code one palette at a time (first the
 * DOM renderer's pastel tones reused wholesale, then Phase 8's tactical
 * rewrite replacing them outright); a user preference (`scene-store.ts`'s
 * `themeId`, persisted per-browser) now picks which registered theme
 * actually renders, and every game3d/ component reads colors from the
 * ACTIVE theme rather than importing a single hard-coded palette.
 *
 * Two presets ship today — `tactical` (dark, neon-glow command center) and
 * `diorama` (the original pastel miniature-office look, restored here
 * rather than left to bit-rot once tactical became the default). Both are
 * real, complete themes, not one "real" theme and one afterthought — this
 * is the seed of a template gallery, not a toggle with a fake second
 * option. Adding a third preset is: one more entry in `THEMES`, no
 * changes to the components that consume it.
 */
export type ThemeId = 'tactical' | 'diorama'

export type OfficeTheme = {
  id: ThemeId
  label: string
  brand: string
  /** Whether emissive materials + bloom post-processing are meaningful for
   *  this look. Tactical rooms are "lit panels"; diorama rooms are flat
   *  pastel fills — turning bloom on for the latter would just wash it out. */
  glow: boolean

  bg: string
  floorDept: string
  floorCeo: string
  floorLounge: string
  floorLine: string // grid-texture line color (tactical) — flat floors ignore it
  wall: string
  /** The coping along the top of a full-height wall. Lighter than the wall
   *  itself in both presets: the top edge is the line that tells an
   *  isometric viewer a wall is a wall and not a shadow, and the reference
   *  renders draw it as a bright rail on every one. */
  wallTop: string
  /** The light line where wall meets floor. Runs along every wall including
   *  the cut-away ones, so a room the viewer is looking into still has its
   *  footprint drawn. */
  wallTrim: string
  wallGlowCyan: string
  wallGlowAmber: string
  wallGlowRed: string
  door: string

  text: string
  accent: string
  accentDim: string
  danger: string
  warn: string
  ok: string

  /** Furniture palette. Rooms used to be empty floor slabs inside a wall
   *  ring, so a theme only ever had to describe architecture; once `PROPS`
   *  is actually rendered a theme has to say what a desk is made of too. */
  prop: {
    surface: string   // desk and table tops
    frame: string     // legs, shelving, cabinet carcass
    fabric: string    // sofas, chairs, rugs
    foliage: string   // planting
    screen: string    // monitor and wall-panel emission
  }
  /** Warm pool of light hung over each room. Carries the "somebody works
   *  here" reading that a single global key light cannot. */
  roomLight: { color: string; intensity: number }
  ambient: { color: string; intensity: number }
  directional: { color: string; intensity: number }
  fog: [near: number, far: number] | null
}

const TACTICAL: OfficeTheme = {
  id: 'tactical',
  label: 'Tactical Command',
  brand: 'HANDSEL // OFFICE DECK',
  glow: true,
  bg: '#070a0f',
  floorDept: '#1e2c3a',
  floorCeo: '#27384f',
  floorLounge: '#1b3032',
  floorLine: 'rgba(79,216,255,0.34)',
  wall: '#0d151d',
  wallTop: '#2a3d4f',
  wallTrim: '#2f9fc4',
  wallGlowCyan: '#0e3a4a',
  wallGlowAmber: '#4a350e',
  wallGlowRed: '#4a0e0e',
  door: '#4fd8ff',
  text: '#dff4ff',
  accent: '#4fd8ff',
  accentDim: '#1c6b85',
  danger: '#ff3b3b',
  warn: '#ffb84f',
  ok: '#57ffb0',
  prop: {
    surface: '#243444',
    frame: '#38506a',
    fabric: '#1e2c3a',
    foliage: '#2f7d5c',
    screen: '#4fd8ff',
  },
  // Pulled down from 420 and the ambient lifted to match: at the old value
  // anything standing directly under the pool — a desk top, the cap of a
  // rack — came back pure white while the rest of the room stayed near
  // black. A diorama wants a narrow range, not a spotlight.
  roomLight: { color: '#bfe6ff', intensity: 240 },
  ambient: { color: '#1c6b85', intensity: 0.8 },
  directional: { color: '#dff4ff', intensity: 1.15 },
  fog: [60, 160],
}

const DIORAMA: OfficeTheme = {
  id: 'diorama',
  label: 'Pastel Diorama',
  brand: 'Handsel Office',
  glow: false,
  bg: '#23161f',
  floorDept: '#fffdfe',
  floorCeo: '#ffeff6',
  floorLounge: '#eefaf4',
  floorLine: 'transparent',
  wall: '#4a2b3c',
  wallTop: '#6d4257',
  wallTrim: '#ffd83d',
  wallGlowCyan: '#4a2b3c', // no emissive glow when !glow — same as base wall color
  wallGlowAmber: '#4a2b3c',
  wallGlowRed: '#4a2b3c',
  door: '#ffd83d',
  text: '#4a2b3c',
  accent: '#ff8fc0',
  accentDim: '#ffd6ea',
  danger: '#ff5fa8',
  warn: '#ffd83d',
  ok: '#b8f0dd',
  prop: {
    surface: '#e8c9a8',
    frame: '#a97d5e',
    fabric: '#ffb3d1',
    foliage: '#7fc8a0',
    screen: '#cfeaff',
  },
  roomLight: { color: '#ffe6c2', intensity: 190 },
  ambient: { color: '#ffffff', intensity: 1 },
  directional: { color: '#fff3e0', intensity: 0.9 },
  fog: null,
}

export const THEMES: Record<ThemeId, OfficeTheme> = { tactical: TACTICAL, diorama: DIORAMA }
export const DEFAULT_THEME_ID: ThemeId = 'tactical'
export const THEME_ORDER: ThemeId[] = ['tactical', 'diorama']
