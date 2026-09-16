import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every skill this repo AUTHORS declares what it may touch, and says so twice.
 *
 * The idea is borrowed from aomi-labs/skills (reviewed 2026-09-16): each skill
 * carries an OWASP Agentic Skills Top 10 universal-manifest block in its
 * frontmatter — `permissions.{files,network,shell,tools}` and a `risk_tier`
 * from L0 (inert) to L3 (destructive) — plus a SECURITY.md that walks the ten
 * risks (AST01–AST10) and names the control for each.
 *
 * A manifest is only worth having if it cannot drift from the skill it
 * describes. So this file pins three things:
 *
 *   1. every authored skill has both halves, and they agree on the tier;
 *   2. every host on the network allow-list is one the skill's own text
 *      mentions, and every literal host in the skill's scripts is on the
 *      allow-list — the manifest cannot claim a narrower egress than the
 *      code has, or a wider one than the docs explain;
 *   3. a skill with no scripts declares no shell, and a skill that declares
 *      shell has something to run.
 *
 * Vendored skills (the ones with an ORIGIN.md) are copied verbatim and pinned
 * to an upstream commit; editing their frontmatter would break the pin, so
 * they are exempt here and their ORIGIN.md is what states the caveats.
 */

const ROOT = process.cwd()
const AUTHORED_DIRS = [
  ...readdirSync(join(ROOT, '.claude/skills'))
    .map((d) => join(ROOT, '.claude/skills', d))
    .filter((d) => statSync(d).isDirectory() && !existsSync(join(d, 'ORIGIN.md'))),
  // The public package strangers install; the copy under public/ is generated
  // from it and compared byte-for-byte in tests/skill-package.test.ts.
  join(ROOT, 'skill/handsel/skills/handsel'),
]

const AST_IDS = ['AST01', 'AST02', 'AST03', 'AST04', 'AST05', 'AST06', 'AST07', 'AST08', 'AST09', 'AST10']

function frontmatter(dir: string): string {
  const src = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  expect(src.startsWith('---\n'), `${dir}: SKILL.md must open with frontmatter`).toBe(true)
  const end = src.indexOf('\n---', 4)
  expect(end, `${dir}: frontmatter never closes`).toBeGreaterThan(0)
  return src.slice(4, end)
}

/** `key: [a, b]` or `key: []` — inline arrays only, so the check needs no YAML parser. */
function inlineList(front: string, key: string): string[] | undefined {
  const m = front.match(new RegExp(`^\\s*${key}: \\[([^\\]]*)\\]\\s*$`, 'm'))
  if (!m) return undefined
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `shell: []` inline, or a `shell:` block of `- item` lines. */
function shellList(front: string): string[] | undefined {
  const inline = inlineList(front, 'shell')
  if (inline !== undefined) return inline
  const m = front.match(/^ {2}shell:\n((?: {4}- .+\n?)+)/m)
  if (!m) return undefined
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^ {4}- /, '').trim())
    .filter(Boolean)
}

function allText(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return out.join('\n')
}

function scriptText(dir: string): string {
  const scripts = join(dir, 'scripts')
  if (!existsSync(scripts)) return ''
  return readdirSync(scripts)
    .map((f) => readFileSync(join(scripts, f), 'utf8'))
    .join('\n')
}

describe('authored skills', () => {
  it('found them — the discovery is part of the test', () => {
    const names = AUTHORED_DIRS.map((d) => d.split('/').pop())
    expect(names).toEqual(expect.arrayContaining(['handsel-agent-contract', 'parallel-repo-coordination', 'instagram-publisher', 'handsel']))
  })

  for (const dir of AUTHORED_DIRS) {
    const name = dir.replace(`${ROOT}/`, '')

    describe(name, () => {
      const front = frontmatter(dir)

      it('declares a risk tier and a version', () => {
        expect(front).toMatch(/^risk_tier: L[0-3]$/m)
        expect(front).toMatch(/^version: "\d+\.\d+\.\d+"$/m)
      })

      it('declares the four permission surfaces', () => {
        expect(front).toMatch(/^permissions:$/m)
        expect(front).toMatch(/^ {2}files:$/m)
        expect(front).toMatch(/^ {2}network:$/m)
        expect(shellList(front), 'permissions.shell').toBeDefined()
        expect(inlineList(front, 'tools'), 'permissions.tools').toBeDefined()
        // The OWASP schema wants explicit path lists, not globs.
        for (const key of ['read', 'write', 'deny_write']) {
          const list = inlineList(front, key)
          expect(list, `permissions.files.${key}`).toBeDefined()
          for (const p of list!) expect(p, `${key} entry ${p} is a glob`).not.toMatch(/[*?]/)
        }
        // Identity files are the canonical injection target; every skill denies them.
        expect(inlineList(front, 'deny_write')).toEqual(expect.arrayContaining(['SOUL.md', 'MEMORY.md', 'AGENTS.md']))
        expect(front).toMatch(/^ {4}deny: "\*"$/m)
      })

      it('lists only network hosts its own text mentions', () => {
        const allow = inlineList(front, 'allow')
        expect(allow, 'permissions.network.allow').toBeDefined()
        const text = allText(dir)
        for (const host of allow!) {
          expect(host).toMatch(/^[a-z0-9.-]+$/)
          expect(text, `${host} is allow-listed but nothing in the skill names it`).toContain(host)
        }
      })

      it('allow-lists every literal host its scripts contact', () => {
        const allow = new Set(inlineList(front, 'allow') ?? [])
        const hosts = [...scriptText(dir).matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase())
        const undeclared = [...new Set(hosts)].filter((h) => !allow.has(h))
        expect(undeclared, 'scripts reach hosts the manifest does not declare').toEqual([])
      })

      it('declares shell only if it ships something to run', () => {
        const shell = shellList(front)!
        const hasScripts = existsSync(join(dir, 'scripts'))
        const body = readFileSync(join(dir, 'SKILL.md'), 'utf8')
        if (shell.length === 0) {
          expect(hasScripts, 'ships scripts but declares no shell').toBe(false)
        } else {
          // Either its own scripts, or a documented command it tells the agent to run.
          const named = shell.some((bin) => body.includes(bin))
          expect(hasScripts || named, `declares shell ${shell.join(',')} but never runs it`).toBe(true)
        }
        // A skill that binds real money or a public account is at least L2.
        const tier = front.match(/^risk_tier: (L[0-3])$/m)![1]
        if (/--live|real money|realMoney/.test(body)) expect(['L2', 'L3']).toContain(tier)
      })

      it('ships a SECURITY.md that walks all ten risks and agrees on the tier', () => {
        const path = join(dir, 'SECURITY.md')
        expect(existsSync(path), 'SECURITY.md missing').toBe(true)
        const sec = readFileSync(path, 'utf8')
        for (const id of AST_IDS) expect(sec, id).toContain(id)
        const tier = front.match(/^risk_tier: (L[0-3])$/m)![1]
        expect(sec).toMatch(new RegExp(`risk_tier: ${tier}`))
        expect(sec).toMatch(/\*\*Last reviewed:\*\* \d{4}-\d{2}-\d{2}/)
        expect(sec).toMatch(/OWASP Agentic Skills Top 10/)
      })
    })
  }
})

describe('vendored skills', () => {
  it('each carries an ORIGIN.md and is left out of the manifest rule', () => {
    const vendored = readdirSync(join(ROOT, '.claude/skills'))
      .map((d) => join(ROOT, '.claude/skills', d))
      .filter((d) => existsSync(join(d, 'ORIGIN.md')))
    expect(vendored.length).toBeGreaterThan(0)
    for (const d of vendored) {
      const origin = readFileSync(join(d, 'ORIGIN.md'), 'utf8')
      // The pin is what makes "copied verbatim" checkable.
      expect(origin, d).toMatch(/[0-9a-f]{7,40}/)
    }
  })
})
