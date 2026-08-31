import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { THEMES } from '@/app/(dashboard)/office/game3d/theme'
import { PUBLIC_ROUTE_PREFIXES, isPublicPath } from '@/lib/public-routes'

const CSS = readFileSync('app/globals.css', 'utf8')

/** Pull one top-level rule's declarations out of the stylesheet. */
function blockOf(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no ${selector} block in globals.css`)
  const open = CSS.indexOf('{', at)
  let depth = 0
  let close = open
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1
    else if (CSS[i] === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  const body = CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Record<string, string> = {}
  for (const line of body.split(';')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/is.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const dark = blockOf('.dark')
const light = blockOf(':root')
const tactical = THEMES.tactical

/**
 * The deck chrome and the 3D office are one palette.
 *
 * This is the only reason two files are allowed to hold the same hex code:
 * a colour changed in the scene and not in the CSS (or the reverse) is
 * invisible in review and obvious on screen, as the app sitting in a
 * different blue from the diorama embedded in it.
 */
const PAIRED: Record<string, string> = {
  '--background': tactical.bg,
  '--foreground': tactical.text,
  '--card': tactical.wall,
  '--primary': tactical.accent,
  '--ring': tactical.accent,
  '--destructive': tactical.danger,
  '--warning': tactical.warn,
  '--success': tactical.ok,
  '--border': tactical.prop.fabric,
  '--sidebar-primary': tactical.accent,
}

describe('the deck theme is the office theme', () => {
  it('takes its colours from the scene preset, not a second opinion about navy', () => {
    for (const [cssVar, sceneColor] of Object.entries(PAIRED)) {
      expect(dark[cssVar]?.toLowerCase(), cssVar).toBe(sceneColor.toLowerCase())
    }
  })

  it('defines every token the light theme defines', () => {
    // A token present in :root and missing from .dark does not fall back to
    // anything sensible — it keeps the LIGHT value, so one stray light grey
    // survives into the dark theme and only shows up on the one component
    // that happens to use it.
    const missing = Object.keys(light).filter((k) => !(k in dark))
    expect(missing).toEqual([])
  })

  it('never leaves a token empty or pointing at itself', () => {
    for (const [k, v] of Object.entries(dark)) {
      expect(v.length, k).toBeGreaterThan(0)
      expect(v, k).not.toBe(`var(${k})`)
    }
  })
})

/** Directories under app/ that hold a route but are not pages a person visits. */
const NOT_A_PAGE = new Set(['api', 'actions'])

function hasPage(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (hasPage(full)) return true
    } else if (entry === 'page.tsx') {
      return true
    }
  }
  return false
}

describe('public routes stay classified', () => {
  it('every routable top-level directory outside (dashboard) is listed as public', () => {
    const unclassified: string[] = []
    for (const entry of readdirSync('app')) {
      if (entry.startsWith('(') || NOT_A_PAGE.has(entry)) continue
      const full = join('app', entry)
      if (!statSync(full).isDirectory()) continue
      if (!hasPage(full)) continue
      if (!(PUBLIC_ROUTE_PREFIXES as readonly string[]).includes(entry)) unclassified.push(entry)
    }
    // A new public page that lands here opens on the dark deck instead of
    // ledger paper, which is exactly the mistake this list exists to prevent.
    expect(unclassified).toEqual([])
  })

  it('lists nothing that does not exist', () => {
    for (const prefix of PUBLIC_ROUTE_PREFIXES) {
      expect(() => statSync(join('app', prefix)), prefix).not.toThrow()
    }
  })

  it('sends deck paths to the deck and public paths to paper', () => {
    expect(isPublicPath('/guest')).toBe(true)
    expect(isPublicPath('/directory')).toBe(true)
    expect(isPublicPath('/proof/abc123')).toBe(true)
    expect(isPublicPath('/office')).toBe(false)
    expect(isPublicPath('/')).toBe(false)
    expect(isPublicPath('/jobs')).toBe(false)
  })
})
