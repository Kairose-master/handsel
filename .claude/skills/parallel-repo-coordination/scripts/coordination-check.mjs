#!/usr/bin/env node
/**
 * parallel-repo-coordination — the gate half of the skill.
 *
 * Several agents (or people) work one git remote at the same time with no shared
 * memory. The only channel is a file in the repo — `conversation.md` by default —
 * where each session writes what it is doing that another session could trip
 * over: live processes, agents not to rewire, files mid-refactor, a defect found
 * in someone else's commit.
 *
 * A note that depends on being voluntarily read is ignored by exactly the agent
 * that most needs it (see the Handsel repo, docs/agent-coordination.md — the note
 * sat on screen in a merge diffstat for eleven minutes). So this script REFUSES
 * until the note has been read in this working copy, and prints only the lines
 * that are new since it was last acknowledged.
 *
 * The acknowledgement lives in `.git/`, never in the repo:
 *   - per working copy: a fresh clone is a fresh agent and is asked to read once;
 *   - never committed: nobody can acknowledge on another session's behalf, and
 *     there is nothing to merge-conflict on.
 *
 * Usage:
 *   node coordination-check.mjs             # exit 1 with the new lines if unread
 *   node coordination-check.mjs --ack       # record the current note as read
 *   node coordination-check.mjs --note "…"  # append a dated, branch-stamped section
 *   node coordination-check.mjs --install-hook   # pre-push hook that runs the check
 *   NOTE_FILE=docs/COORDINATION.md node coordination-check.mjs   # different file
 */
import { readFile, writeFile, mkdir, appendFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const NOTE = process.env.NOTE_FILE || 'conversation.md'
const SELF = process.argv[1]
const ACK_COMMAND = `node ${path.relative(process.cwd(), SELF)} --ack`

const normalize = (t) => t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n').trimStart()
const meaningful = (t) => t.split('\n').filter((l) => l.trim())

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return null }
}

const gitDir = git(['rev-parse', '--git-dir'])
// Not a checkout anybody coordinates in (tarball, Docker COPY) — nothing to gate.
if (!gitDir) process.exit(0)
const dir = path.resolve(gitDir)
const ackPath = path.join(dir, `coordination-ack-${path.basename(NOTE).replace(/[^a-z0-9]/gi, '_')}`)

if (process.argv.includes('--install-hook')) {
  const hook = path.join(dir, 'hooks', 'pre-push')
  const line = `node "${path.resolve(SELF)}" || exit 1`
  const existing = existsSync(hook) ? await readFile(hook, 'utf8') : '#!/bin/sh\n'
  if (!existing.includes(line)) {
    await mkdir(path.dirname(hook), { recursive: true })
    await writeFile(hook, existing.replace(/\n*$/, '\n') + `# parallel-repo-coordination\n${line}\n`, 'utf8')
    await chmod(hook, 0o755)
  }
  console.log(`pre-push hook installed at ${hook} — pushes refuse until ${NOTE} is acknowledged.`)
  process.exit(0)
}

if (process.argv.includes('--note')) {
  const i = process.argv.indexOf('--note')
  const text = process.argv.slice(i + 1).join(' ').trim()
  if (!text) { console.error('--note needs text'); process.exit(2) }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown-branch'
  const who = process.env.COORD_AUTHOR || process.env.USER || 'agent'
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const header = existsSync(NOTE) ? '' : `Notes between sessions working this repo at the same time. Read before touching anything; \`${ACK_COMMAND}\` after reading.\n---\n`
  await appendFile(NOTE, `${header}\n## ${stamp} · ${who} (${branch})\n\n${text}\n`, 'utf8')
  // Writing a note is reading it.
  await mkdir(path.dirname(ackPath), { recursive: true })
  await writeFile(ackPath, await readFile(NOTE, 'utf8'), 'utf8')
  console.log(`Appended to ${NOTE} and acknowledged. Commit it with your change so the other sessions see it on their next pull.`)
  process.exit(0)
}

if (!existsSync(NOTE)) process.exit(0)
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
console.error(acked === null ? `✖ ${NOTE} has not been read in this working copy.` : `✖ ${NOTE} changed since it was last read here.`)
console.error('')
console.error('Another session is working this repo and left a note. It is not optional reading.')
console.error('')
if (added.length) for (const l of added) console.error(`  │ ${l}`)
else console.error('  │ (lines were removed or reordered — read the file)')
console.error('')
console.error(`Read ${NOTE}, then: ${ACK_COMMAND}`)
console.error('')
process.exit(1)
