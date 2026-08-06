import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The skill package is documentation that an agent executes.
 *
 * That is the whole reason it needs a test. A README with a wrong endpoint is a
 * bad README; a SKILL.md with a wrong endpoint is a worker that 404s on its
 * first call and leaves. Writing this file, the first draft told agents to
 * `GET /api/agents/<id>/profile` — an endpoint that has never existed. It was
 * caught by curling it, which is not a process.
 *
 * So: every API path this package names must resolve to a real route, and any
 * path it names as public must not be behind a session.
 */

const SKILL_DIR = join(process.cwd(), 'skill/handsel')
const SKILL_MD = join(SKILL_DIR, 'skills/handsel/SKILL.md')
const REFERENCE_DIR = join(SKILL_DIR, 'skills/handsel/reference')
const PUBLIC_DIR = join(process.cwd(), 'public/skill')

function allText(): string {
  const files = [SKILL_MD, ...readdirSync(REFERENCE_DIR).map((f) => join(REFERENCE_DIR, f))]
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

/** Turn `/api/agents/<id>/card` into the app-router directory it must live in. */
function routeDirFor(apiPath: string): string {
  const segments = apiPath.replace(/^\//, '').split('/')
  const mapped = segments.map((s) => (/^[<:{]|^\$/.test(s) ? '[id]' : s))
  return join(process.cwd(), 'app', ...mapped)
}

describe('the skill package conforms to the marketplace spec', () => {
  it('has the required nesting and manifest', () => {
    expect(existsSync(join(SKILL_DIR, '.claude-plugin/plugin.json'))).toBe(true)
    expect(existsSync(SKILL_MD)).toBe(true)
  })

  it('the manifest carries every required field, with a shaped author', () => {
    const m = JSON.parse(readFileSync(join(SKILL_DIR, '.claude-plugin/plugin.json'), 'utf8'))
    for (const field of ['name', 'description', 'version', 'author', 'license', 'keywords', 'skills']) {
      expect(m[field], field).toBeTruthy()
    }
    // "never a plain string" is called out explicitly in the authoring standard.
    expect(typeof m.author).toBe('object')
    expect(m.author.name).toBeTruthy()
    expect(m.author.email).toBeTruthy()
    expect(m.skills).toBe('./skills')
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(m.keywords).toContain('lucid-agents')
    // The skill directory name must match the manifest name.
    expect(m.name).toBe('handsel')
    expect(existsSync(join(SKILL_DIR, 'skills', m.name, 'SKILL.md'))).toBe(true)
  })

  it('SKILL.md has frontmatter with a name matching its directory', () => {
    const src = readFileSync(SKILL_MD, 'utf8')
    expect(src.startsWith('---\n')).toBe(true)
    const front = src.slice(4, src.indexOf('\n---', 4))
    expect(front).toMatch(/^name: handsel$/m)
    const desc = front.match(/^description: (.+)$/m)?.[1]
    expect(desc).toBeTruthy()
    expect(desc!.length).toBeLessThanOrEqual(1024)
    // The standard asks the description to say when to use it, not just what.
    expect(desc!.toLowerCase()).toMatch(/use when/)
  })

  it('links every reference it names, and names every reference it ships', () => {
    const src = readFileSync(SKILL_MD, 'utf8')
    const linked = [...src.matchAll(/\(reference\/([\w.-]+)\)/g)].map((m) => m[1])
    const shipped = readdirSync(REFERENCE_DIR)
    // An unlinked reference is dead weight; a linked-but-missing one is a 404
    // in the middle of an agent's decision procedure.
    expect(new Set(linked)).toEqual(new Set(shipped))
    for (const f of shipped) expect(existsSync(join(REFERENCE_DIR, f))).toBe(true)
  })

  it('gives every reference over 100 lines a Contents section', () => {
    for (const f of readdirSync(REFERENCE_DIR)) {
      const src = readFileSync(join(REFERENCE_DIR, f), 'utf8')
      if (src.split('\n').length > 100) expect(src, f).toMatch(/^## Contents$/m)
    }
  })

  it('keeps references one level deep', () => {
    // The standard: references must not link to more required references.
    for (const f of readdirSync(REFERENCE_DIR)) {
      expect(readFileSync(join(REFERENCE_DIR, f), 'utf8'), f).not.toMatch(/\(reference\//)
    }
  })
})

describe('every endpoint it tells an agent to call is real', () => {
  const text = allText()
  const paths = [...new Set([...text.matchAll(/\/api\/[\w/[\]<>:$-]+/g)].map((m) => m[0].replace(/[.,)`]+$/, '')))]

  it('found the paths — the extraction is the test here', () => {
    expect(paths.length).toBeGreaterThan(5)
    expect(paths).toContain('/api/agents/register')
    expect(paths).toContain('/api/runtime/callback')
  })

  it('each one resolves to a route in this repo', () => {
    const missing = paths.filter((p) => !existsSync(join(routeDirFor(p), 'route.ts')))
    expect(
      missing,
      `The skill tells agents to call endpoints that do not exist: ${missing.join(', ')}. ` +
        'An agent following this package would 404 on its first call.',
    ).toEqual([])
  })

  it('does not present a session-gated endpoint as public', () => {
    // /api/agents/:id and /credit-history require the OWNER's session. The
    // first draft of this package offered them as a way to vet a worker before
    // hiring it, which would have failed for every caller who was not that
    // worker's owner.
    for (const gated of ['/api/agents/<agent_id>', '/api/agents/:id']) {
      const asPublic = new RegExp(`curl[^\\n]*${gated.replace(/[<>:/]/g, '\\$&')}(?![\\w/])`)
      expect(text, `${gated} is session-gated`).not.toMatch(asPublic)
    }
    expect(text).toMatch(/are \*\*not\*\* public/)
  })
})

describe('the safety contract survives copy-editing', () => {
  const text = allText()

  it('carries both refusal markers and says they go on different records', () => {
    // §25: one word for two situations comes back as one word, filed under the
    // wrong one. A skill that ships only the attack marker recreates that bug
    // in every agent that installs it.
    expect(text).toContain('HANDSEL-REFUSED-BRIEF')
    expect(text).toContain('HANDSEL-CANNOT-DO')
    expect(text).toMatch(/different (parties|records)/)
  })

  it('tells the agent to read realMoney rather than guess from the hostname', () => {
    // §26: the environment is a fact about the chain, and every surface that
    // asserted it from a constant was eventually wrong.
    expect(text).toMatch(/meta\.realMoney/)
    expect(text).toMatch(/Never infer the network from the hostname/)
  })

  it('tells the worker not to score its own work', () => {
    expect(text).toMatch(/quality_score.*null/s)
  })
})

/**
 * The served copy under `public/` is generated by `npm run skill:sync`, because
 * Next.js only serves files from there. A copy is a drift hazard, and a copy
 * behind a CDN is a drift hazard you cannot see — an installer would keep
 * handing agents last month's instructions with nothing anywhere saying so.
 * So the divergence is a build failure rather than a thing to remember.
 */
describe('the served copy matches the source', () => {
  it('has every source file, byte for byte', () => {
    const stale: string[] = []
    if (readFileSync(SKILL_MD, 'utf8') !== readFileSync(join(PUBLIC_DIR, 'SKILL.md'), 'utf8')) stale.push('SKILL.md')
    for (const f of readdirSync(REFERENCE_DIR)) {
      const served = join(PUBLIC_DIR, 'reference', f)
      if (!existsSync(served) || readFileSync(join(REFERENCE_DIR, f), 'utf8') !== readFileSync(served, 'utf8')) {
        stale.push(`reference/${f}`)
      }
    }
    expect(stale, `public/skill is stale — run \`npm run skill:sync\`: ${stale.join(', ')}`).toEqual([])
  })

  it('serves nothing the source no longer has', () => {
    // A reference deleted from skill/ but left in public/ is a file the
    // installer still downloads and the agent still reads.
    const source = new Set(readdirSync(REFERENCE_DIR))
    for (const f of readdirSync(join(PUBLIC_DIR, 'reference'))) expect(source, f).toContain(f)
  })

  it('the installer carries no filenames of its own', () => {
    // The one place drift would be both invisible and remote.
    const sh = readFileSync(join(process.cwd(), 'public/install-skill.sh'), 'utf8')
    expect(sh).toMatch(/skill\/files\.txt/)
    for (const f of readdirSync(REFERENCE_DIR)) expect(sh, f).not.toContain(f)
  })

  it('the file list the installer reads names exactly the source files', () => {
    const listed = readFileSync(join(PUBLIC_DIR, 'files.txt'), 'utf8').trim().split('\n')
    const expected = ['SKILL.md', ...readdirSync(REFERENCE_DIR).sort().map((f) => `reference/${f}`)]
    expect(listed).toEqual(expected)
  })

  it('refuses a partial install rather than writing a broken skill', () => {
    // A half-downloaded decision procedure is worse than none: the agent reads
    // instructions whose references 404 partway through.
    const sh = readFileSync(join(process.cwd(), 'public/install-skill.sh'), 'utf8')
    expect(sh).toMatch(/mktemp -d/)
    expect(sh).toMatch(/nothing was written/)
    expect(sh).toMatch(/curl -fsSL/) // -f, so a 404 body never lands on disk as the skill
  })
})
