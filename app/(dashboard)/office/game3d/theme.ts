/**
 * Tactical-telemetry palette for the R3F office (redesign brief: "dark +
 * neon glow sci-fi command center", picked over the pastel diorama tone
 * the DOM renderer keeps). One accent does the structural work (cyan —
 * every normal room, line, and label), red is reserved for exactly one
 * meaning (a real dispute, or the busiest/"hot" room) so it still reads as
 * an alert instead of decoration, matching the "one accent, used with
 * intent" discipline the reference command-center look depends on.
 *
 * Scoped entirely to `.world3d-viewport`/`game3d/` — the DOM renderer's own
 * pastel `--pink`/`--mint`/`--lav` tokens (office.css's `:root` block) are
 * untouched, so the "🖼️ Classic view" toggle still looks exactly as it did.
 */
export const THEME = {
  bg: '#070a0f',
  floorDept: '#0d131c',
  floorCeo: '#121a2c',
  floorLounge: '#0d1a1a',
  wall: '#05070a',
  wallGlowCyan: '#0e3a4a',
  wallGlowAmber: '#4a350e',
  wallGlowRed: '#4a0e0e',
  door: '#4fd8ff',

  phosphor: '#dff4ff',
  cyan: '#4fd8ff',
  cyanDim: '#1c6b85',
  red: '#ff3b3b',
  amber: '#ffb84f',
  green: '#57ffb0',

  agentSkinDim: '#2a3038', // fallback if an agent's real palette needs a neutral base
} as const
