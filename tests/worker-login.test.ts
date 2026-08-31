/**
 * The worker's --login flow — pinned at the source level, the same way
 * tests/worker-harness.test.ts pins the harness flags, because
 * public/handsel-worker.mjs is standalone by design and cannot be imported.
 *
 * What must stay true:
 *  - Login talks to the SAME endpoint the desktop Miner uses
 *    (/api/agents/register), whose same-name reconnect semantics are what
 *    make a second --login "log back in" instead of "duplicate the agent".
 *  - The saved token is a password: 0o600 file, 0o700 dir, --logout removes.
 *  - Interactive login never fires on a non-TTY stdin — a CI job or a piped
 *    invocation must fail loudly, not hang on a prompt nobody will answer.
 *  - A pasted --token is NOT persisted unless --remember is passed, so
 *    existing installs keep their exact behavior.
 *  - --workdir/--harness are NOT persisted: granting file access stays a
 *    per-run decision.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'public', 'handsel-worker.mjs'), 'utf8')

describe('handsel-worker --login', () => {
  it('registers through the same endpoint as the desktop Miner', () => {
    expect(src).toContain('/api/agents/register')
    // Reconnect semantics are the point — the header must say so where the
    // next editor will read it.
    expect(src).toMatch(/RECONNECT/i)
  })

  it('treats the saved token as a password', () => {
    expect(src).toContain("path.join(os.homedir(), '.handsel')")
    expect(src).toContain('worker-token')
    expect(src).toMatch(/mode:\s*0o600/)
    expect(src).toMatch(/mode:\s*0o700/)
    expect(src).toContain("args.includes('--logout')")
  })

  it('only starts interactive login on a TTY', () => {
    expect(src).toMatch(/process\.stdin\.isTTY[\s\S]{0,200}loginFlow\(\)/)
  })

  it('does not persist a pasted --token without --remember', () => {
    expect(src).toMatch(/flag\('token'\) && args\.includes\('--remember'\)/)
  })

  it('does not persist workdir or harness flags', () => {
    // The token file holds exactly the token, nothing else — the login flow
    // must never write workdir/harness config to disk.
    const persisted = src.slice(src.indexOf('async function saveToken'), src.indexOf('function ask'))
    expect(persisted).not.toContain('workdir')
    expect(persisted).not.toContain('harness')
  })

  it('declares file/code capability only when this run can touch disk', () => {
    expect(src).toMatch(/flag\('workdir'\) \|\| flag\('harness'\) \|\| flag\('harness-cmd'\)\s*\?\s*\['text', 'code', 'file'\]/)
  })
})
