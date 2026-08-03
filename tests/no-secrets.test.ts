import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * This repository is PUBLIC. Every byte of it, and of its history, is readable
 * by anyone.
 *
 * An audit found nothing — but an audit is a thing somebody remembers to run,
 * and the failure it guards against is a single careless paste on a tired
 * evening. The whole lesson of this codebase is that a check nobody invokes is
 * not a check, so this runs on every `npm run test` alongside everything else.
 *
 * Scope is deliberately the tracked working tree, not history. A secret already
 * committed is not something a test can undo — that needs rotation, and then a
 * rewrite if it is worth it. What a test can do is stop the next one arriving.
 *
 * Patterns are the shapes that are unambiguous. Anything looser produces false
 * positives on a codebase full of hashes and addresses, and a check that cries
 * wolf gets skipped, which returns us to having no check.
 */

/**
 * Publicly published test vectors — Hardhat and Anvil ship these in their
 * documentation, and every Ethereum developer has them.
 *
 * Allowlisted by full value rather than by file, so moving them somewhere they
 * do not belong still passes and adding a DIFFERENT key to those same files
 * still fails. Verified as harmless rather than assumed: the derived addresses
 * 0x70997970…79C8 and 0x9965507D…A4dc hold nothing on Base mainnet.
 */
const PUBLIC_TEST_KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
]

const PATTERNS: Array<{ name: string; re: RegExp; allow?: (m: string, line: string) => boolean }> = [
  {
    name: 'private key (32-byte hex)',
    re: /\b0x[0-9a-fA-F]{64}\b/g,
    allow: (m, line) =>
      PUBLIC_TEST_KEYS.includes(m.toLowerCase()) ||
      // Hashes are the same shape and this codebase is full of them. The
      // distinguishing feature is the NAME beside the value, so that is what is
      // read — a bare 32-byte literal with no such word is the suspicious case.
      /keccak|hash|digest|selector|bytecode|root|commit|salt|nonce|sha256|blob|proof|topic|specHash|resultHash/i.test(
        line,
      ) ||
      /^0x0+$/.test(m) ||
      /^0xf+$/i.test(m.toLowerCase()),
  },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'PEM private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  {
    name: 'connection string with credentials',
    re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)(?:\+srv)?:\/\/[^:/@\s'"]+:[^@\s'"]+@/gi,
    // Placeholders are the documented shape in .env.example and every README.
    allow: (m) => /user:password|USER:PASS|<[^>]*>|:pass@|:xxx|:\.\.\.|localhost|example/i.test(m),
  },
  {
    name: 'provider URL with an embedded project id or key',
    re: /\b(?:rpc\.zerodev\.app\/api\/v\d+\/[A-Za-z0-9-]{8,}|[a-z-]+\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]{20,}|api\.developer\.coinbase\.com\/rpc\/v1\/[a-z-]+\/[A-Za-z0-9]{20,}|infura\.io\/v3\/[a-f0-9]{20,}|[a-z0-9-]+\.quiknode\.pro\/[a-f0-9]{20,})/gi,
    allow: (m) => /EXAMPLE|deadbeef|your|xxx|<|\.\.\.|placeholder/i.test(m),
  },
]

/** Tracked text files only. Untracked ones cannot leak by being pushed. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((p) => !/\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|pdf|zip|jar|wasm|mp3|mp4|bin)$/i.test(p))
    .filter((p) => {
      try {
        // The compiled artifacts are megabytes of hex by design and contain no
        // secrets; scanning them costs seconds and finds nothing.
        return statSync(p).size < 512 * 1024
      } catch {
        return false
      }
    })
}

describe('nothing that looks like a credential is committed', () => {
  const files = trackedFiles()

  it('has files to check, so a broken lister cannot pass silently', () => {
    // Without this, `git ls-files` failing would produce an empty list and a
    // green test — a scanner that scans nothing reports no findings.
    expect(files.length).toBeGreaterThan(100)
  })

  it('finds no credentials in any tracked file', () => {
    const findings: string[] = []
    for (const file of files) {
      // The test's own patterns would match themselves.
      if (file === 'tests/no-secrets.test.ts') continue
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (const { name, re, allow } of PATTERNS) {
        for (const [i, line] of lines.entries()) {
          for (const m of line.match(re) ?? []) {
            if (allow?.(m, line)) continue
            findings.push(`${file}:${i + 1}  ${name}  ${m.slice(0, 16)}…`)
          }
        }
      }
    }
    expect(findings).toEqual([])
    // Every pattern against every line of every tracked file takes ~12s while
    // the rest of the suite runs in parallel, and vitest's default budget is 5s.
    // It passed alone and went red in the full run, which is the worst possible
    // behaviour for a credential scanner: a check that fails at random teaches
    // you to re-run rather than to look, and then a real finding reads like the
    // usual flake. Give it room instead of making it shallower.
  }, 60_000)
})

describe('the environment file cannot be committed by accident', () => {
  const ignore = readFileSync('.gitignore', 'utf8')

  it('ignores .env', () => {
    expect(ignore).toMatch(/^\.env$/m)
  })

  it('has never had one tracked', () => {
    const tracked = trackedFiles().filter((p) => /(^|\/)\.env($|\.)/.test(p) && !p.endsWith('.example'))
    expect(tracked).toEqual([])
  })
})
