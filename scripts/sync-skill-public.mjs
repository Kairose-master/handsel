#!/usr/bin/env node
/**
 * Publish the skill package to `public/`, so `install-skill.sh` has something
 * to download.
 *
 * The skill's canonical home is `skill/handsel/`, in the nested layout the
 * skills-market authoring standard requires. Next.js only serves files under
 * `public/`, so the served copy is a copy — and a copy is a drift hazard, which
 * this repo has now been bitten by often enough to stop hoping about
 * (§23 two receipts that read alike, §26 a doc asserting what the code did not
 * do).
 *
 * So the copy is generated, never hand-edited, and `tests/skill-package.test.ts`
 * fails the build when the two diverge. Run `npm run skill:sync` after touching
 * anything under `skill/`.
 *
 * It also writes the file list twice, on purpose. `manifest.json` is for tools
 * and humans; `files.txt` is newline-delimited for the installer, because
 * parsing JSON in POSIX sh is a bad trade — the first version tried, extracted
 * the wrong key, and only failed safely because the download step checks its
 * status. Both are generated from the same array, so they cannot disagree.
 *
 * Either way the installer carries no filenames of its own: a hardcoded list in
 * a shell script served from a CDN is the one place drift would be invisible
 * *and* remote.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'skill/handsel/skills/handsel'
const OUT = 'public/skill'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'reference'), { recursive: true })

copyFileSync(join(SRC, 'SKILL.md'), join(OUT, 'SKILL.md'))

const references = readdirSync(join(SRC, 'reference')).filter((f) => f.endsWith('.md')).sort()
for (const f of references) copyFileSync(join(SRC, 'reference', f), join(OUT, 'reference', f))

const manifest = {
  name: 'handsel',
  version: JSON.parse(readFileSync('skill/handsel/.claude-plugin/plugin.json', 'utf8')).version,
  files: ['SKILL.md', ...references.map((f) => `reference/${f}`)],
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(OUT, 'files.txt'), `${manifest.files.join('\n')}\n`)

console.log(`synced ${manifest.files.length} file(s) to ${OUT} (v${manifest.version})`)
