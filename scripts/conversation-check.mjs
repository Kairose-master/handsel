#!/usr/bin/env node
/**
 * Gate: conversation.md has to be read before this working copy can commit.
 *
 * See lib/conversation-notes.ts for why this exists rather than a rule in
 * CLAUDE.md — the short version is that a rule was already the plan, and the
 * agent that skipped the note had read the rules.
 *
 * The acknowledgement lives in `.git/`, NOT in the repo. That is the whole
 * design:
 *
 *   - It is per working copy, so a fresh clone — which is a fresh agent, with
 *     no memory of the conversation — is asked to read the note once.
 *   - It is never committed, so acknowledging cannot be pushed on somebody
 *     else's behalf, and there is no merge conflict to resolve in it.
 *
 * Run with --ack to record the current note as read.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const NOTE = 'conversation.md'
const ACK_COMMAND = 'npm run conversation:ack'

/* Mirrored from lib/conversation-notes.ts, pinned by
 * tests/conversation-notes.test.ts — a script cannot import a .ts module
 * without a build step, and a build step in a pre-commit gate is a gate that
 * gets skipped. */
const normalize = (t) =>
  t
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n')
    .trimStart()
const meaningful = (t) => t.split('\n').filter((l) => l.trim())

function gitDir() {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
    return path.resolve(out)
  } catch {
    return null
  }
}

const dir = gitDir()
// No git dir means this is not a checkout anybody is coordinating in — a
// tarball, a Docker COPY. Refusing there would break builds to enforce a
// convention that cannot apply.
if (!dir) process.exit(0)
if (!existsSync(NOTE)) process.exit(0)

const ackPath = path.join(dir, 'handsel-conversation-ack')
const note = await readFile(NOTE, 'utf8')
const acked = existsSync(ackPath) ? await readFile(ackPath, 'utf8') : null

if (process.argv.includes('--ack')) {
  await mkdir(path.dirname(ackPath), { recursive: true })
  await writeFile(ackPath, note, 'utf8')
  console.log(`Acknowledged ${NOTE}. It will be flagged again when it changes.`)
  process.exit(0)
}

if (acked !== null && normalize(acked) === normalize(note)) process.exit(0)

const seen = new Set(acked === null ? [] : meaningful(normalize(acked)))
const added = meaningful(normalize(note)).filter((l) => !seen.has(l))

console.error('')
console.error(
  acked === null
    ? `✖ ${NOTE} has not been read in this working copy.`
    : `✖ ${NOTE} changed since it was last read here.`,
)
console.error('')
console.error('Another agent is working this repo and left a note. It is not optional')
console.error('reading: the last time it was skipped, it was describing a live round')
console.error('and a defect in code shipped seven minutes earlier.')
console.error('')
if (added.length) for (const l of added) console.error(`  │ ${l}`)
else console.error('  │ (lines were removed or reordered — read the file)')
console.error('')
console.error(`Read ${NOTE}, then: ${ACK_COMMAND}`)
console.error('')
process.exit(1)
