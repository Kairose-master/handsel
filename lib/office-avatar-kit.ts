/**
 * What an agent is wearing, and why it means something.
 *
 * The generated character sheets (`docs/assets/ref-agents-*.png`) show ten
 * figures told apart by SILHOUETTE and one accessory each — a hard hat, a
 * satchel, a clipboard, a drafting square — never by facial detail. The
 * scene they were drawn for told its agents apart by shirt colour alone, at
 * a zoom where a 0.44-unit torso is a few dozen pixels. Two agents in
 * similar blues were indistinguishable, and nothing about an agent's
 * appearance said what it was doing.
 *
 * So the accessory is keyed to the agent's DEPARTMENT, which
 * `lib/office-functional-departments.ts` already derives from live signals —
 * open jobs, peer reviews, credit draws, a skill installed in the last day.
 * An agent in the Engineering Floor wears the hard hat; when its work moves
 * it to QA the pauldron goes on. The kit is a readout, not a costume, which
 * is the same rule the rest of this codebase follows about numbers on a page.
 *
 * Pure: a department id in, a kit out. The geometry lives in
 * `app/(dashboard)/office/game3d/AgentAvatars.tsx`; this decides only WHICH,
 * so the mapping is one table a test can pin rather than a switch buried in
 * a render function.
 */

/** The shapes the avatar knows how to build. Deliberately few and blocky —
 *  at this camera an accessory is read as a silhouette bump, so a shape that
 *  needs detail to be recognised is a shape that reads as noise. */
export type AccessoryKind =
  /** A hard hat sitting on the head. */
  | 'hardhat'
  /** A flat board held in front of the chest. */
  | 'clipboard'
  /** A bag on the hip with a strap over the shoulder. */
  | 'satchel'
  /** One armoured shoulder. */
  | 'pauldron'
  /** A tube slung across the back. */
  | 'tube'
  /** A band over the head with a puck at one ear. */
  | 'headset'
  /** A thin angled bar carried at the side. */
  | 'square'
  /** Nothing — the agent is between departments. */
  | 'none'

/** Which of the avatar's palette slots the accessory paints itself from.
 *  Named by ROLE rather than by colour so it works in both themes: the
 *  tactical deck's amber is the diorama's yellow, and neither file should
 *  have to know about the other. */
export type AccessoryTone = 'warn' | 'accent' | 'ok' | 'danger' | 'neutral'

export type AvatarKit = {
  kind: AccessoryKind
  tone: AccessoryTone
  /** One line for the inspector, so the picture is explainable rather than
   *  merely decorative. */
  meaning: string
}

const NONE: AvatarKit = { kind: 'none', tone: 'neutral', meaning: 'between assignments' }

/**
 * The table.
 *
 * Ids are the nine from `FUNCTIONAL_DEPARTMENTS` plus world.ts's own two
 * non-generated rooms, `ceo` and `lounge` — exactly the set live-engine's
 * `applySnapshot` can put in `Agent.deptId`.
 */
const KIT: Record<string, AvatarKit> = {
  engineering: { kind: 'hardhat', tone: 'warn', meaning: 'building — on an escrowed job' },
  research: { kind: 'satchel', tone: 'accent', meaning: 'searching sources for a live job' },
  strategy: { kind: 'square', tone: 'accent', meaning: 'decomposing and routing a delegation' },
  qa: { kind: 'pauldron', tone: 'danger', meaning: 'red-teaming a deliverable before it settles' },
  verification: { kind: 'clipboard', tone: 'ok', meaning: 'peer review — evidence and verdict' },
  memory: { kind: 'tube', tone: 'neutral', meaning: 'writing a settled outcome to the ledger' },
  skills: { kind: 'pauldron', tone: 'ok', meaning: 'a new capability was just installed' },
  treasury: { kind: 'satchel', tone: 'warn', meaning: 'holding an open credit draw' },
  market: { kind: 'headset', tone: 'accent', meaning: 'watching the open board' },
  ceo: { kind: 'clipboard', tone: 'warn', meaning: 'running the desk' },
  lounge: NONE,
}

export function kitFor(deptId: string | null | undefined): AvatarKit {
  if (!deptId) return NONE
  return KIT[deptId] ?? NONE
}

/** Every department this table knows, for the test that pins it against the
 *  real department list — a new department silently falling through to
 *  `none` is how the readout quietly stops being one. */
export function kittedDepartments(): string[] {
  return Object.keys(KIT)
}

/**
 * Does the visor light up?
 *
 * Every agent gets the band — it is the sheets' single strongest identity
 * cue, and it replaces a face the geometry never had. It only EMITS on a
 * theme that glows; on the flat diorama an emissive band is the one element
 * that would break the paper-craft read.
 */
export function visorEmissive(glow: boolean, selected: boolean): number {
  if (!glow) return 0
  return selected ? 1.4 : 0.9
}
